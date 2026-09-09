export class AppError extends Error {
  constructor(public code: string, message: string, public retryable = false, public retryAt = 0) { super(message); }
}
export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof DOMException && error.name === 'QuotaExceededError') return new AppError('STORAGE_FULL', '本地空间不足，请先导出并清理旧任务。');
  return new AppError('INTERNAL', error instanceof Error ? error.message : '未知错误');
}
export function slugFromInput(input: string): string {
  let slug = input.trim();
  if (/^https?:/i.test(slug)) {
    const url = new URL(slug);
    if (url.protocol !== 'https:' || url.hostname !== 'www.coursera.org') throw new AppError('INVALID_COURSE', '请输入 Coursera 课程链接。');
    slug = url.pathname.match(/^\/learn\/([^/]+)/)?.[1] ?? '';
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,180}$/.test(slug)) throw new AppError('INVALID_COURSE', '请输入 /learn/ 下的课程链接或课程 slug。');
  return slug;
}
