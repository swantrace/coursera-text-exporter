import type { ExportFormat } from "../shared/types";

let creating: Promise<void> | undefined;
let operations: Promise<unknown> = Promise.resolve();
function serialize<T>(work: () => Promise<T>): Promise<T> {
  const next = operations.then(work);
  operations = next.catch(() => {});
  return next;
}
async function ensureOffscreen(): Promise<void> {
  if (creating) return creating;
  creating = (async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    if (!contexts.length)
      await chrome.offscreen.createDocument({
        url: "offscreen/offscreen.html",
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification:
          "Create local export Blob URLs without keeping the popup open.",
      });
  })().finally(() => {
    creating = undefined;
  });
  return creating;
}
export function download(jobId: string, format: ExportFormat): Promise<void> {
  return serialize(() => performDownload(jobId, format));
}
async function performDownload(
  jobId: string,
  format: ExportFormat,
): Promise<void> {
  await ensureOffscreen();
  const result = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "BUNDLE",
    jobId,
    format,
  });
  if (!result?.ok) throw new Error(result?.error ?? "文件生成失败。");
  let id: number;
  try {
    id = await chrome.downloads.download({
      url: result.url,
      filename: result.name,
      saveAs: true,
    });
  } catch (error) {
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "REVOKE",
      url: result.url,
    });
    throw error;
  }
  await chrome.storage.local.set({ [`download:${id}`]: result.url });
  // Handle a small download completing before its bookkeeping write.
  const [item] = await chrome.downloads.search({ id });
  if (item && item.state !== "in_progress") await cleanup(id);
}
export function cleanupDownload(id: number): Promise<void> {
  return serialize(() => cleanup(id));
}
async function cleanup(id: number): Promise<void> {
  const key = `download:${id}`,
    stored = await chrome.storage.local.get(key);
  if (stored[key]) {
    const result = await chrome.runtime
      .sendMessage({ target: "offscreen", type: "REVOKE", url: stored[key] })
      .catch(() => undefined);
    if (result?.empty) await chrome.offscreen.closeDocument();
    await chrome.storage.local.remove(key);
  }
}

// Sidecar data stays in the extension's offscreen document until Chrome finishes reading it.
export function sidecarUrl(
  taskId: string,
): Promise<{ url: string; name: string }> {
  return serialize(async () => {
    await ensureOffscreen();
    const result = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "SIDECAR",
      taskId,
    });
    if (!result?.ok) throw new Error(result?.error ?? "字幕文件生成失败。");
    return result;
  });
}
export async function trackBlobDownload(
  id: number,
  url: string,
): Promise<void> {
  await chrome.storage.local.set({ [`download:${id}`]: url });
  const [item] = await chrome.downloads.search({ id });
  if (item && item.state !== "in_progress") await cleanupDownload(id);
}
export function releaseBlob(url: string): Promise<void> {
  return serialize(async () => {
    const result = await chrome.runtime
      .sendMessage({ target: "offscreen", type: "REVOKE", url })
      .catch(() => undefined);
    if (result?.empty) await chrome.offscreen.closeDocument();
  });
}
