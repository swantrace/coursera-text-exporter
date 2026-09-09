import { AppError } from "../shared/errors";

declare const __ASSET_ORIGINS__: string[];
const configuredOrigins =
  typeof __ASSET_ORIGINS__ === "undefined" ? [] : __ASSET_ORIGINS__;
const allowed = new Set([
  "https://www.coursera.org",
  "https://www.googleapis.com",
  "https://d3c33hcgiwev3.cloudfront.net",
  ...configuredOrigins,
]);
export function validateUrl(input: string): URL {
  const url = new URL(input, "https://www.coursera.org");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !allowed.has(url.origin)
  ) {
    throw new AppError(
      "HOST_PERMISSION",
      `资源域名未配置：${url.origin}。将此 HTTPS origin 加入 config.local.json 的 assetOrigins 后重新构建、加载。`,
    );
  }
  return url;
}
export function retryAfter(value: string | null, now = Date.now()): number {
  if (!value) return 0;
  return /^\d+(?:\.\d+)?$/.test(value)
    ? now + Number(value) * 1000
    : Math.max(0, Date.parse(value) || 0);
}
// Reservation is serialized; the persistent origin cooldown survives worker restarts.
let reservation = Promise.resolve();
export async function pace(origin: string, signal: AbortSignal): Promise<void> {
  let until = 0;
  const next = reservation.then(async () => {
    const key = `rate:${origin}`;
    const stored = await chrome.storage.local.get(key);
    until = Math.max(Date.now(), Number(stored[key] ?? 0));
    if (until - Date.now() > 1500)
      throw new AppError("RATE_WAIT", "等待请求冷却。", true, until);
    await chrome.storage.local.set({
      [key]: until + (origin === "https://www.googleapis.com" ? 250 : 500),
    });
  });
  reservation = next.catch(() => {});
  await next;
  const delay = until - Date.now();
  if (delay > 0)
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        reject(new DOMException("Cancelled", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", stop);
        resolve();
      }, delay);
      signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted) stop();
    });
}
export async function requestText(
  input: string,
  signal: AbortSignal,
  json = false,
): Promise<string> {
  const url = validateUrl(input);
  await pace(url.origin, signal);
  const timeout = AbortSignal.timeout(20_000);
  try {
    const response = await fetch(url, {
      credentials:
        url.origin === "https://www.coursera.org" ? "include" : "omit",
      headers: {
        Accept: json ? "application/json" : "text/vtt,text/html,text/plain,*/*",
      },
      signal: AbortSignal.any([signal, timeout]),
      redirect: "follow",
    });
    validateUrl(response.url || url.href);
    if (response.status === 401)
      throw new AppError(
        "COURSERA_AUTH",
        "Coursera 登录已失效，请在同一 Chrome 配置文件中登录后继续。",
      );
    if (response.status === 403)
      throw new AppError(
        "FORBIDDEN",
        "资源访问被拒绝，可能是签名过期或课时权限限制。",
      );
    if (response.status === 404)
      throw new AppError("NOT_FOUND", "课程或资源不存在。");
    if (
      response.status === 429 ||
      response.status === 408 ||
      [500, 502, 503, 504].includes(response.status)
    ) {
      const retryAt = Math.max(
        retryAfter(response.headers.get("Retry-After")),
        Date.now() + 2000,
      );
      if (response.status === 429)
        await chrome.storage.local.set({ [`rate:${url.origin}`]: retryAt });
      throw new AppError(
        `HTTP_${response.status}`,
        `服务器暂时不可用（${response.status}）。`,
        true,
        retryAt,
      );
    }
    if (!response.ok)
      throw new AppError(`HTTP_${response.status}`, `HTTP ${response.status}`);
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = "",
      bytes = 0;
    if (reader)
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 25 * 1024 * 1024) {
          await reader.cancel();
          throw new AppError(
            "RESOURCE_TOO_LARGE",
            "单个文本资源超过 25 MiB，已停止读取。",
          );
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    text += decoder.decode();
    if (
      (json && /^\s*</.test(text)) ||
      /\/login(?:[/?]|$)|authMode=login/.test(response.url)
    ) {
      throw new AppError(
        "COURSERA_AUTH",
        "API 返回了登录或验证页面，请登录 Coursera 后重试。",
      );
    }
    return text;
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (signal.aborted) throw new AppError("ABORTED", "任务已停止。");
    throw new AppError(
      "NETWORK",
      "网络请求失败或超时。请检查网络与资源域名权限。",
      true,
    );
  }
}
export async function getJson(
  url: string,
  signal: AbortSignal,
): Promise<unknown> {
  const text = await requestText(url, signal, true);
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("SCHEMA_MISMATCH", "API 返回了无法解析的 JSON。");
  }
}
