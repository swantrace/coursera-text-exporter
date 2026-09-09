import type { Course, Job } from '../shared/types';
export function filename(value: string): string {
  const clean =
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: filenames must exclude ASCII control characters.
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .replace(/\.{2,}/g, '-')
      .replace(/[. ]+$/g, '')
      .slice(0, 70)
      .replace(/[. ]+$/g, '') || 'untitled';
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)
    ? `_${clean}`
    : clean;
}
export function courseFolder(job: Job): string {
  return `${filename(job.slug)}-${job.id.slice(0, 8)}`;
}
export function itemPath(course: Course, itemId: string): string {
  for (const [mi, module] of course.modules.entries())
    for (const [li, lesson] of module.lessons.entries()) {
      const ii = lesson.items.findIndex((i) => i.id === itemId);
      if (ii >= 0)
        return `modules/${String(mi + 1).padStart(2, '0')}-${filename(module.title).slice(0, 35)}/${String(li + 1).padStart(2, '0')}-${filename(lesson.title).slice(0, 35)}/${String(ii + 1).padStart(2, '0')}-${filename(lesson.items[ii].title).slice(0, 45)}-${filename(itemId)}`;
    }
  throw new Error('Could not locate the item in the course outline.');
}
export function subtitleSuffix(language: string, key?: string): string {
  const trackIndex = Number(key?.split(':').at(-1) ?? 0);
  return `.${filename(language)}${trackIndex > 0 ? `.track${trackIndex + 1}` : ''}`;
}
