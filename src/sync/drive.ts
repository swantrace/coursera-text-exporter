import { retryAfter } from "../api/http";
import { bundle } from "../export/bundle";
import { type Obj, object, rows } from "../parsers/course";
import { AppError } from "../shared/errors";
import type { SyncRecord } from "../shared/types";
import { db } from "../storage/database";

const api = "https://www.googleapis.com/drive/v3";
export async function token(interactive: boolean): Promise<string> {
  if (!chrome.runtime.getManifest().oauth2?.client_id)
    throw new AppError(
      "GOOGLE_CONFIG",
      "尚未配置 Google OAuth Client ID。请参照 README 配置后重新构建扩展。",
    );
  try {
    const result = await chrome.identity.getAuthToken({ interactive });
    if (!result.token) throw new Error();
    return result.token;
  } catch {
    throw new AppError(
      "GOOGLE_AUTH",
      "请点击“连接 Google Drive”完成授权，再重试同步。",
    );
  }
}
export async function googleRequest(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  if (new URL(url).origin !== "https://www.googleapis.com")
    throw new AppError("DRIVE_URL", "拒绝向非 Google API 地址发送授权信息。");
  for (let attempt = 0; attempt < 2; attempt++) {
    const accessToken = await token(false);
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        credentials: "omit",
        redirect: "error",
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          Authorization: `Bearer ${accessToken}`,
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
      });
    } catch {
      if (signal.aborted) throw new AppError("ABORTED", "同步已停止。");
      throw new AppError("NETWORK", "Drive 请求失败或超时。", true);
    }
    if (response.status === 401) {
      await chrome.identity.removeCachedAuthToken({ token: accessToken });
      if (attempt === 0) continue;
      throw new AppError("GOOGLE_AUTH", "Google 授权失效，请重新连接。");
    }
    if ([408, 429, 500, 502, 503, 504].includes(response.status))
      throw new AppError(
        "DRIVE_RETRY",
        `Drive 暂时不可用（${response.status}）。`,
        true,
        retryAfter(response.headers.get("Retry-After")),
      );
    if (response.status === 403) {
      const body = await response
        .clone()
        .json()
        .catch(() => ({}));
      const reason = rows(object(object(body).error).errors)[0]?.reason;
      if (
        ["rateLimitExceeded", "userRateLimitExceeded"].includes(String(reason))
      )
        throw new AppError(
          "DRIVE_RETRY",
          "Drive 请求限流。",
          true,
          Date.now() + 5000,
        );
      throw new AppError(
        "DRIVE_FORBIDDEN",
        `Drive 权限或配额不足（${reason ?? "403"}）。`,
      );
    }
    return response;
  }
  throw new AppError("GOOGLE_AUTH", "Google 授权失效。");
}
async function json(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Obj> {
  const response = await googleRequest(url, init, signal);
  if (!response.ok)
    throw new AppError("DRIVE_HTTP", `Drive 请求失败（${response.status}）。`);
  return object(await response.json());
}
export function multipart(
  metadata: Record<string, unknown>,
  blob: Blob,
): { body: Blob; contentType: string } {
  const boundary = `coursera_${crypto.randomUUID()}`;
  const contentType = `multipart/related; boundary=${boundary}`;
  return {
    contentType,
    body: new Blob(
      [
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
        JSON.stringify(metadata),
        `\r\n--${boundary}\r\nContent-Type: ${blob.type}\r\n\r\n`,
        blob,
        `\r\n--${boundary}--\r\n`,
      ],
      { type: contentType },
    ),
  };
}
export async function hash(blob: Blob): Promise<string> {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
async function record(key: string, signal: AbortSignal): Promise<SyncRecord> {
  const database = await db();
  let existing = await database.get("sync", key);
  if (!existing) {
    const response = await json(
      `${api}/files/generateIds?count=1&space=drive&type=files`,
      {},
      signal,
    );
    const fileId = Array.isArray(response.ids) ? response.ids[0] : undefined;
    if (typeof fileId !== "string" || !fileId)
      throw new AppError("DRIVE_RESPONSE", "Drive 未返回有效文件标识。");
    existing = { key, fileId };
    await database.put("sync", existing);
  }
  return existing;
}
async function fileInfo(
  fileId: string,
  signal: AbortSignal,
): Promise<Obj | undefined> {
  const response = await googleRequest(
    `${api}/files/${encodeURIComponent(fileId)}?fields=id,trashed,appProperties`,
    {},
    signal,
  );
  if (response.status === 404) return undefined;
  if (!response.ok)
    throw new AppError(
      "DRIVE_HTTP",
      `无法读取目标文件（${response.status}）。`,
    );
  return object(await response.json());
}
export async function syncJob(
  jobId: string,
  signal: AbortSignal,
): Promise<void> {
  const database = await db(),
    job = await database.get("jobs", jobId);
  if (!job?.course) throw new AppError("NO_COURSE", "尚未取得课程大纲。");
  const about = await json(
    `${api}/about?fields=user(permissionId)`,
    {},
    signal,
  );
  const account = object(about.user).permissionId;
  if (typeof account !== "string" || !account)
    throw new AppError("GOOGLE_ACCOUNT", "无法识别 Drive 账号。");
  const { blob, name } = await bundle(jobId, "md");
  const contentHash = await hash(blob);
  const variant = await hash(
    new Blob([
      JSON.stringify({
        course: job.course.id,
        language: job.options.language,
        all: job.options.allLanguages,
        readings: job.options.includeReadings,
      }),
    ]),
  );
  const key = `${account}:${variant}`;
  let entry = await record(key, signal);
  const info = await fileInfo(entry.fileId, signal);
  if (!info && entry.hash) {
    await database.delete("sync", key);
    entry = await record(key, signal);
  }
  if (info?.trashed)
    throw new AppError("DRIVE_TRASHED", "同步目标已移入回收站，请恢复后重试。");
  if (object(info?.appProperties).contentHash === contentHash) {
    entry.hash = contentHash;
    delete entry.session;
    await database.put("sync", entry);
    return;
  }
  let folder = await record(`${account}:folder`, signal);
  const folderInfo = await fileInfo(folder.fileId, signal);
  if (!folderInfo && folder.hash) {
    await database.delete("sync", folder.key);
    folder = await record(folder.key, signal);
  }
  if (folderInfo?.trashed)
    throw new AppError("DRIVE_TRASHED", "导出文件夹已在回收站，请恢复后重试。");
  if (!folderInfo) {
    const response = await googleRequest(
      `${api}/files`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: folder.fileId,
          name: "Coursera Text Exports",
          mimeType: "application/vnd.google-apps.folder",
        }),
      },
      signal,
    );
    if (!response.ok && response.status !== 409)
      throw new AppError("DRIVE_HTTP", `无法创建目录（${response.status}）。`);
    folder.hash = "created";
    await database.put("sync", folder);
  }
  const metadata = {
    name,
    mimeType: blob.type,
    appProperties: { courseId: job.course.id, contentHash, variant },
    ...(info ? {} : { id: entry.fileId, parents: [folder.fileId] }),
  };
  const uploadUrl = `https://www.googleapis.com/upload/drive/v3/files${info ? `/${entry.fileId}` : ""}`;
  if (blob.size <= 5 * 1024 * 1024) {
    const part = multipart(metadata, blob);
    const response = await googleRequest(
      `${uploadUrl}?uploadType=multipart`,
      {
        method: info ? "PATCH" : "POST",
        headers: { "Content-Type": part.contentType },
        body: part.body,
      },
      signal,
    );
    if (response.status === 409) {
      const check = await fileInfo(entry.fileId, signal);
      if (object(check?.appProperties).contentHash !== contentHash)
        throw new AppError(
          "DRIVE_RETRY",
          "目标文件已存在，将重新核对并更新。",
          true,
        );
    } else if (!response.ok)
      throw new AppError("DRIVE_HTTP", `上传失败（${response.status}）。`);
    entry.hash = contentHash;
    delete entry.session;
    await database.put("sync", entry);
    return;
  }
  if (entry.session && entry.sessionHash !== contentHash) delete entry.session;
  if (!entry.session) {
    const response = await googleRequest(
      `${uploadUrl}?uploadType=resumable`,
      {
        method: info ? "PATCH" : "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Upload-Content-Type": blob.type,
          "X-Upload-Content-Length": String(blob.size),
        },
        body: JSON.stringify(metadata),
      },
      signal,
    );
    if (response.status === 409)
      throw new AppError("DRIVE_RETRY", "目标文件已存在，将重新核对。", true);
    const session = response.headers.get("Location");
    if (!response.ok || !session)
      throw new AppError("DRIVE_HTTP", "无法建立断点上传会话。");
    entry.session = session;
    entry.sessionHash = contentHash;
    await database.put("sync", entry);
  }
  const status = await googleRequest(
    entry.session,
    {
      method: "PUT",
      headers: { "Content-Range": `bytes */${blob.size}` },
      body: new Blob([]),
    },
    signal,
  );
  if (status.status === 404 || status.status === 410) {
    delete entry.session;
    await database.put("sync", entry);
    throw new AppError("UPLOAD_PROGRESS", "上传会话已过期，将重新建立。", true);
  }
  if (status.ok) {
    entry.hash = contentHash;
    delete entry.session;
    await database.put("sync", entry);
    return;
  }
  if (status.status !== 308)
    throw new AppError("DRIVE_HTTP", `无法恢复上传（${status.status}）。`);
  const start =
    Number(status.headers.get("Range")?.match(/bytes=0-(\d+)/)?.[1] ?? -1) + 1;
  const end = Math.min(start + 1024 * 1024, blob.size);
  const response = await googleRequest(
    entry.session,
    {
      method: "PUT",
      headers: {
        "Content-Type": blob.type,
        "Content-Range": `bytes ${start}-${end - 1}/${blob.size}`,
      },
      body: blob.slice(start, end),
    },
    signal,
  );
  if (response.ok) {
    entry.hash = contentHash;
    delete entry.session;
    await database.put("sync", entry);
    return;
  }
  if (response.status === 308)
    throw new AppError(
      "UPLOAD_PROGRESS",
      `正在上传，已发送至 ${end} / ${blob.size} 字节。`,
      true,
      Date.now() + 500,
    );
  throw new AppError("DRIVE_HTTP", `分块上传失败（${response.status}）。`);
}
