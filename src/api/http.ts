import { AppError } from '../shared/errors';

declare const __ASSET_ORIGINS__: string[];
const configuredOrigins =
  typeof __ASSET_ORIGINS__ === 'undefined' ? [] : __ASSET_ORIGINS__;
const allowed = new Set([
  'https://www.coursera.org',
  'https://www.googleapis.com',
  'https://d3c33hcgiwev3.cloudfront.net',
  ...configuredOrigins,
]);
export function validateUrl(input: string): URL {
  const url = new URL(input, 'https://www.coursera.org');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !allowed.has(url.origin)
  ) {
    throw new AppError(
      'HOST_PERMISSION',
      `Asset origin is not configured: ${url.origin}. Add this HTTPS origin to assetOrigins in config.local.json, then rebuild and reload.`,
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
      throw new AppError(
        'RATE_WAIT',
        'Wait for the request cooldown.',
        true,
        until,
      );
    await chrome.storage.local.set({
      [key]: until + (origin === 'https://www.googleapis.com' ? 250 : 500),
    });
  });
  reservation = next.catch(() => {});
  await next;
  const delay = until - Date.now();
  if (delay > 0)
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        clearTimeout(timer);
        reject(new DOMException('Cancelled', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', stop);
        resolve();
      }, delay);
      signal.addEventListener('abort', stop, { once: true });
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
        url.origin === 'https://www.coursera.org' ? 'include' : 'omit',
      headers: {
        Accept: json ? 'application/json' : 'text/vtt,text/html,text/plain,*/*',
      },
      signal: AbortSignal.any([signal, timeout]),
      redirect: 'follow',
    });
    validateUrl(response.url || url.href);
    if (response.status === 401)
      throw new AppError(
        'COURSERA_AUTH',
        'Coursera login expired. Sign in using the same Chrome profile and continue.',
      );
    if (response.status === 403)
      throw new AppError(
        'FORBIDDEN',
        'Resource access was denied. The signature may have expired or the item may be restricted.',
      );
    if (response.status === 404)
      throw new AppError('NOT_FOUND', 'The course or resource does not exist.');
    if (
      response.status === 429 ||
      response.status === 408 ||
      [500, 502, 503, 504].includes(response.status)
    ) {
      const retryAt = Math.max(
        retryAfter(response.headers.get('Retry-After')),
        Date.now() + 2000,
      );
      if (response.status === 429)
        await chrome.storage.local.set({ [`rate:${url.origin}`]: retryAt });
      throw new AppError(
        `HTTP_${response.status}`,
        `The server is temporarily unavailable (${response.status}).`,
        true,
        retryAt,
      );
    }
    if (!response.ok)
      throw new AppError(`HTTP_${response.status}`, `HTTP ${response.status}`);
    const reader = response.body?.getReader();
    const decoder = new TextDecoder();
    let text = '',
      bytes = 0;
    if (reader)
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 25 * 1024 * 1024) {
          await reader.cancel();
          throw new AppError(
            'RESOURCE_TOO_LARGE',
            'A text resource exceeds 25 MiB; reading stopped.',
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
        'COURSERA_AUTH',
        'The API returned a login or verification page. Sign in to Coursera and try again.',
      );
    }
    return text;
  } catch (e) {
    if (e instanceof AppError) throw e;
    if (signal.aborted) throw new AppError('ABORTED', 'The job was stopped.');
    throw new AppError(
      'NETWORK',
      'The network request failed or timed out. Check the network and asset host permissions.',
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
    throw new AppError('SCHEMA_MISMATCH', 'The API returned invalid JSON.');
  }
}
