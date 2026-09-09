import { metadata, videoSource } from "../api/coursera";
import { validateUrl } from "../api/http";
import { courseFolder, itemPath } from "../export/paths";
import { AppError } from "../shared/errors";
import type { Job, NativeFile, Task } from "../shared/types";
import { videoOptions } from "../shared/video";
import { db } from "../storage/database";
import { releaseBlob, sidecarUrl, trackBlobDownload } from "./downloads";

const starting = new Set<string>();

async function patch(
  task: Task,
  change: (current: Task) => void,
): Promise<boolean> {
  const database = await db(),
    tx = database.transaction("tasks", "readwrite");
  const current = await tx.store.get(task.id);
  if (
    current?.state !== "downloading" ||
    current.file?.startedAt !== task.file?.startedAt
  ) {
    await tx.done;
    return false;
  }
  change(current);
  await tx.store.put(current);
  await tx.done;
  return true;
}

export async function startNativeDownload(
  task: Task,
  job: Job,
  signal: AbortSignal,
): Promise<void> {
  if (!job.course || !task.item)
    throw new AppError("TASK_INVALID", "下载任务缺少课时信息。");
  let url: string, file: NativeFile;
  if (task.kind === "video") {
    const options = videoOptions(job.options);
    const selected = videoSource(
      await metadata("lecture", job.course.id, task.item.id, signal),
      options.videoResolution,
      options.videoFormat,
    );
    url = validateUrl(selected.url).href;
    file = {
      filename: `${courseFolder(job)}/${itemPath(job.course, task.item.id)}.${selected.format}`,
      startedAt: new Date().toISOString(),
      resolution: selected.resolution,
      format: selected.format,
      ...(selected.resolution !== options.videoResolution
        ? {
            warning: `最高 ${options.videoResolution}，实际下载 ${selected.resolution}。`,
          }
        : {}),
    };
  } else {
    const sidecar = await sidecarUrl(task.id);
    url = sidecar.url;
    file = { filename: sidecar.name, startedAt: new Date().toISOString() };
  }
  const blob = url.startsWith("blob:");
  const database = await db(),
    tx = database.transaction(["jobs", "tasks"], "readwrite");
  const current = await tx.objectStore("tasks").get(task.id),
    currentJob = await tx.objectStore("jobs").get(job.id);
  if (
    signal.aborted ||
    current?.state !== "running" ||
    current.lease !== task.lease ||
    currentJob?.status !== "active"
  ) {
    await tx.done;
    if (blob) await releaseBlob(url);
    return;
  }
  // Persist intent before handing the request to Chrome; recovery can find the download by its unique path.
  current.state = "downloading";
  current.file = file;
  delete current.lease;
  delete current.leaseUntil;
  await tx.objectStore("tasks").put(current);
  await tx.done;
  task.file = file;
  starting.add(task.id);
  try {
    const id = await chrome.downloads.download({
      url,
      filename: file.filename,
      conflictAction: "overwrite",
      saveAs: false,
    });
    const attached = await patch(task, (current) => {
      current.file!.downloadId = id;
    });
    if (blob) await trackBlobDownload(id, url);
    if (!attached) {
      await chrome.downloads.cancel(id).catch(() => {});
      return;
    }
    const latest = await database.get("jobs", job.id);
    if (!latest || latest.status === "cancelled")
      await chrome.downloads.cancel(id).catch(() => {});
    else if (latest.status === "paused" || latest.status === "blocked_auth")
      await chrome.downloads.pause(id).catch(() => {});
  } catch {
    if (blob) await releaseBlob(url).catch(() => {});
    await patch(task, (current) => {
      current.state = "failed";
      current.code = "DOWNLOAD_START";
      current.error = "Chrome 无法启动文件下载，请检查下载权限与设置后重试。";
    });
  } finally {
    starting.delete(task.id);
  }
}

async function lookup(
  task: Task,
): Promise<chrome.downloads.DownloadItem | undefined> {
  if (!task.file) return;
  if (task.file.downloadId !== undefined)
    return (await chrome.downloads.search({ id: task.file.downloadId }))[0];
  if (starting.has(task.id)) return;
  const matches = await chrome.downloads.search({
    startedAfter: new Date(
      Date.parse(task.file.startedAt) - 1000,
    ).toISOString(),
    orderBy: ["-startTime"],
  });
  return matches.find(
    (d) =>
      d.byExtensionId === chrome.runtime.id &&
      d.filename.replace(/\\/g, "/").endsWith(`/${task.file?.filename}`),
  );
}

// Called by both download events and the recovery alarm; no Worker waits for video bytes.
export async function synchronizeDownloads(): Promise<void> {
  const database = await db();
  const jobs = new Map((await database.getAll("jobs")).map((j) => [j.id, j]));
  for (const task of await database.getAll("tasks")) {
    if (task.state !== "downloading" || !task.file || starting.has(task.id))
      continue;
    const job = jobs.get(task.jobId);
    if (!job) continue;
    const item = await lookup(task);
    if (!item) {
      if (Date.now() - Date.parse(task.file.startedAt) < 30_000) continue;
      await patch(task, (t) => {
        t.attempts++;
        t.state = t.attempts <= 4 ? "retry_wait" : "failed";
        t.code = "DOWNLOAD_MISSING";
        t.error = "找不到 Chrome 下载记录，请重试。";
        t.nextAt = Date.now();
        delete t.file;
      });
      continue;
    }
    if (item.state === "in_progress") {
      if (["paused", "blocked_auth"].includes(job.status) && !item.paused)
        await chrome.downloads.pause(item.id).catch(() => {});
      await patch(task, (t) => {
        Object.assign(t.file!, {
          downloadId: item.id,
          bytesReceived: item.bytesReceived,
          totalBytes: item.totalBytes,
          paused: item.paused,
        });
      });
      continue;
    }
    await patch(task, (t) => {
      Object.assign(t.file!, {
        downloadId: item.id,
        bytesReceived: item.bytesReceived,
        totalBytes: item.totalBytes,
        paused: false,
      });
      if (item.state === "complete") {
        if (
          t.kind === "video" &&
          /^text\/|application\/json/i.test(item.mime)
        ) {
          t.state = "failed";
          t.code = "VIDEO_CONTENT_TYPE";
          t.error = "视频地址返回了文本或登录页面，请检查权限后重试。";
        } else {
          t.state = "succeeded";
          delete t.error;
          delete t.code;
        }
        return;
      }
      const reason = String(item.error ?? "UNKNOWN");
      if (reason === "USER_CANCELED") {
        t.state = "cancelled";
        t.error = "下载已在 Chrome 中取消。";
        t.code = reason;
        return;
      }
      t.attempts++;
      const retryable =
        /^(NETWORK_|SERVER_(FORBIDDEN|UNAUTHORIZED|FAILED|UNREACHABLE)|CRASH|USER_SHUTDOWN)/.test(
          reason,
        );
      t.state = retryable && t.attempts <= 4 ? "retry_wait" : "failed";
      t.code = reason;
      t.error = `下载中断：${reason}${t.state === "retry_wait" ? "，将刷新链接后重试。" : "。"}`;
      t.nextAt = Date.now() + Math.min(60_000, 1000 * 2 ** t.attempts);
    });
  }
}

export async function controlDownloads(
  jobId: string,
  action: "pause" | "resume" | "cancel" | "retry",
): Promise<void> {
  const database = await db();
  for (const task of await database.getAllFromIndex("tasks", "jobId", jobId)) {
    if (!task.file) continue;
    const item = await lookup(task);
    if (item?.state !== "in_progress") continue;
    if (action === "pause")
      await chrome.downloads.pause(item.id).catch(() => {});
    else if (action === "cancel")
      await chrome.downloads.cancel(item.id).catch(() => {});
    else if (item.paused)
      await chrome.downloads.resume(item.id).catch(() => {});
  }
}
