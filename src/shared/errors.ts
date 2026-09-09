export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public retryable = false,
    public retryAt = 0,
  ) {
    super(message);
  }
}
export function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof DOMException && error.name === 'QuotaExceededError')
    return new AppError(
      'STORAGE_FULL',
      'Local storage is full. Export and clear old jobs first.',
    );
  return new AppError(
    'INTERNAL',
    error instanceof Error ? error.message : 'Unknown error',
  );
}
export function slugFromInput(input: string): string {
  let slug = input.trim();
  if (/^https?:/i.test(slug)) {
    const url = new URL(slug);
    if (url.protocol !== 'https:' || url.hostname !== 'www.coursera.org')
      throw new AppError('INVALID_COURSE', 'Enter a Coursera course URL.');
    slug = url.pathname.match(/^\/learn\/([^/]+)/)?.[1] ?? '';
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,180}$/.test(slug))
    throw new AppError('INVALID_COURSE', 'Enter a /learn/ course URL or slug.');
  return slug;
}
