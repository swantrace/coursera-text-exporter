import { cmlToHtml } from '../parsers/cml';
import { getJson, requestText } from './http';
import { AppError } from '../shared/errors';
import { object, rows, type Obj } from '../parsers/course';
const base = 'https://www.coursera.org/api/';
export function materials(slug: string, signal: AbortSignal) {
  const query = new URLSearchParams({ q: 'slug', slug,
    includes: 'modules,lessons,items',
    fields: 'moduleIds,onDemandCourseMaterialModules.v1(name,slug,lessonIds),onDemandCourseMaterialLessons.v1(name,slug,itemIds),onDemandCourseMaterialItems.v2(name,slug,contentSummary)' });
  return getJson(`${base}onDemandCourseMaterials.v2/?${query}`, signal);
}
export function metadata(kind: 'lecture' | 'reading', courseId: string, itemId: string, signal: AbortSignal) {
  const endpoint = kind === 'lecture' ? 'onDemandLectureVideos.v1' : 'onDemandSupplements.v1';
  return getJson(`${base}${endpoint}/${encodeURIComponent(courseId)}~${encodeURIComponent(itemId)}?includes=${kind === 'lecture' ? 'video' : 'asset'}`, signal);
}
export interface Track { language: string; url: string; key: string }
export function tracks(input: unknown): Track[] {
  const raw = object(input), roots = rows(raw.elements);
  if (!roots.length) throw new AppError('SCHEMA_MISMATCH', '视频元数据没有 elements。');
  const linked = object(raw.linked);
  const videos = Object.entries(linked).filter(([key]) => /videos?\.v\d/i.test(key)).flatMap(([, value]) => rows(value));
  const candidates = [...roots, ...videos, ...roots.map(r => object(r.video))];
  const result: Track[] = []; let recognized = false;
  for (const candidate of candidates) {
    for (const field of ['subtitlesVtt', 'subtitles', 'subtitleUrls', 'captions']) {
      if (!(field in candidate)) continue;
      recognized = true;
      const source = candidate[field];
      const entries = Array.isArray(source) ? source.map((t, i) => [String(object(t).languageCode ?? object(t).language ?? i), t] as const) : Object.entries(object(source));
      for (const [language, value] of entries) {
        const row = object(value);
        const url = typeof value === 'string' ? value : row.vtt ?? row.url ?? row.downloadUrl;
        if (typeof url !== 'string') continue;
        if (field !== 'subtitlesVtt' && !/\.vtt(?:[?#]|$)|(?:fileExtension|format)=vtt(?:&|$)/i.test(url) && row.format !== 'vtt') continue;
        if (!result.some(t => t.language === language && t.url === url)) result.push({ language, url, key: `${language}:${result.filter(t => t.language === language).length}` });
      }
    }
  }
  if (!recognized) throw new AppError('SCHEMA_MISMATCH', '未识别视频字幕字段，需用真实响应校验；没有将其当作无字幕。');
  return result;
}
export function chooseTracks(available: Track[], language: string, all: boolean): Track[] {
  if (all || !available.length) return available;
  const normalized = language.toLowerCase();
  return [available.find(t => t.language.toLowerCase() === normalized) ?? available.find(t => t.language.toLowerCase().split('-')[0] === normalized.split('-')[0]) ?? available.find(t => t.language === 'en') ?? available[0]];
}
export interface ReadingAsset { key: string; format: 'html' | 'md' | 'txt'; content?: string; url?: string }
export function readingAssets(input: unknown): { assets: ReadingAsset[]; unsupported: number } {
  const raw = object(input), root = rows(raw.elements)[0];
  if (!root) throw new AppError('SCHEMA_MISMATCH', '阅读元数据没有 elements。');
  const linked = object(raw.linked);
  let assets = Object.entries(linked).filter(([key]) => /^openCourseAssets\.v\d/.test(key)).flatMap(([, value]) => rows(value));
  if (!assets.length && root.asset) assets = [object(root.asset)];
  if (!assets.length) throw new AppError('SCHEMA_MISMATCH', '未找到 openCourseAssets 关联。');
  let unsupported = 0;
  const result: ReadingAsset[] = [];
  for (const [index, asset] of assets.entries()) {
    const key = String(asset.id ?? index);
    const definition = object(asset.definition);
    const type = String(asset.typeName ?? asset.type ?? asset.mimeType ?? '');
    const html = asset.html ?? definition.html;
    const md = asset.markdown ?? definition.markdown;
    const text = asset.text ?? definition.text;
    const content = asset.content ?? definition.content;
    const cml = asset.cml ?? definition.cml ?? (/cml/i.test(type) ? definition.value ?? asset.value : undefined);
    const url = asset.url ?? definition.url ?? asset.downloadUrl;
    if (typeof html === 'string') result.push({ key, format: 'html', content: html });
    else if (typeof md === 'string') result.push({ key, format: 'md', content: md });
    else if (typeof text === 'string') result.push({ key, format: 'txt', content: text });
    else if (typeof content === 'string' && /html|markdown|text/i.test(type)) result.push({ key, format: /html/i.test(type) ? 'html' : /markdown/i.test(type) ? 'md' : 'txt', content });
    else if (typeof cml === 'string' || object(cml).value) {
      const value = typeof cml === 'string' ? cml : object(cml).value;
      result.push({ key, format: 'html', content: cmlToHtml(value) });
    } else if (typeof url === 'string' && /html|markdown|text/i.test(type)) result.push({ key, format: /html/i.test(type) ? 'html' : /markdown/i.test(type) ? 'md' : 'txt', url });
    else unsupported++;
  }
  return { assets: result, unsupported };
}
export async function subtitle(courseId: string, itemId: string, key: string, signal: AbortSignal): Promise<{ raw: string; track: Track }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const available = tracks(await metadata('lecture', courseId, itemId, signal));
    const track = available.find(t => t.key === key);
    if (!track) throw new AppError('TRACK_MISSING', '所选字幕轨道已消失。');
    try { return { raw: await requestText(track.url, signal), track }; }
    catch (e) { if (!(e instanceof AppError) || e.code !== 'FORBIDDEN' || attempt === 1) throw e; }
  }
  throw new AppError('FORBIDDEN', '刷新签名后资源仍不可访问。');
}
