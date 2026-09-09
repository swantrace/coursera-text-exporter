import { chooseTracks, materials, metadata, readingAssets, subtitle, tracks } from '../api/coursera';
import { requestText } from '../api/http';
import { parseCourse } from '../parsers/course';
import { htmlToMarkdown, htmlToText, markdownToText } from '../parsers/reading';
import { parseVtt, toTimedText } from '../parsers/webvtt';
import { AppError } from '../shared/errors';
import type { Artifact, Task, TaskResult } from '../shared/types';
import { db, newTask } from '../storage/database';
import { syncJob } from '../sync/drive';
export async function execute(task: Task, signal: AbortSignal): Promise<TaskResult> {
  const job = await (await db()).get('jobs', task.jobId);
  if (!job) throw new AppError('JOB_MISSING', '任务不存在。');
  if (task.kind === 'outline') {
    const course = parseCourse(await materials(job.slug, signal), job.slug);
    const children = course.modules.flatMap(m => m.lessons.flatMap(l => l.items.map(item => {
      const kind = item.type === 'lecture' ? 'lecture' : 'reading';
      const skip = item.locked ? '课时已锁定。' : !['lecture','supplement'].includes(item.type) ? `不支持的课时类型：${item.type}` : item.type === 'supplement' && !job.options.includeReadings ? '未选择采集阅读材料。' : '';
      return newTask(job.id, `item:${item.id}`, kind, { item, ...(skip ? { state: 'skipped', error: skip } : {}) });
    })));
    return { course, children };
  }
  if (task.kind === 'drive') { await syncJob(job.id, signal); return {}; }
  if (!job.course || !task.item) throw new AppError('TASK_INVALID', '任务缺少课程信息。');
  const courseId = job.course.id, item = task.item;
  const source = `https://www.coursera.org/learn/${job.slug}/${item.type === 'lecture' ? 'lecture' : 'supplement'}/${encodeURIComponent(item.id)}`;
  if (task.kind === 'lecture') {
    const selected = chooseTracks(tracks(await metadata('lecture', courseId, item.id, signal)), job.options.language, job.options.allLanguages);
    if (!selected.length) return { skip: '没有可用的 WebVTT 字幕。' };
    return { children: selected.map(track => newTask(job.id, `subtitle:${item.id}:${track.key}`, 'subtitle', { item, assetKey: track.key, language: track.language })) };
  }
  if (task.kind === 'subtitle') {
    const { raw, track } = await subtitle(courseId, item.id, task.assetKey!, signal);
    const { cues, warnings } = parseVtt(raw);
    if (!cues.length) return { skip: '字幕轨道为空。' };
    if (!job.options.allLanguages && track.language !== job.options.language) warnings.push(`首选 ${job.options.language}，实际导出 ${track.language}。`);
    const text = cues.map(c => c.text).join('\n');
    return { artifacts: [{ id: task.id, jobId: job.id, itemId: item.id, title: item.title, kind: 'subtitle', language: track.language,
      raw, rawFormat: 'vtt', text, markdown: toTimedText(cues), cues, source, warnings }] };
  }
  const artifacts: Artifact[] = [];
  // One task per reading item; commit all assets together, never silently lose siblings.
  let resolved = readingAssets(await metadata('reading', courseId, item.id, signal));
  if (!resolved.assets.length) return { skip: `阅读材料格式暂不支持（${resolved.unsupported} 个资源）。` };
  for (const asset of resolved.assets) {
    let raw: string;
    try { raw = asset.content ?? await requestText(asset.url!, signal); }
    catch (e) {
      if (!(e instanceof AppError) || e.code !== 'FORBIDDEN') throw e;
      const refreshed = readingAssets(await metadata('reading', courseId, item.id, signal)).assets.find(a => a.key === asset.key);
      if (!refreshed) throw new AppError('ASSET_MISSING', '刷新后阅读资源已消失。');
      raw = refreshed.content ?? await requestText(refreshed.url!, signal);
    }
    artifacts.push({ id: `${task.id}:${asset.key}`, jobId: job.id, itemId: item.id, title: item.title, kind: 'reading', raw, rawFormat: asset.format,
      text: asset.format === 'html' ? htmlToText(raw) : asset.format === 'md' ? markdownToText(raw) : raw,
      markdown: asset.format === 'html' ? htmlToMarkdown(raw, asset.url ? new URL(asset.url, 'https://www.coursera.org').href.split(/[?#]/)[0] : source) : raw,
      source, warnings: resolved.unsupported ? [`同课时还有 ${resolved.unsupported} 个不支持的资源。`] : [] });
  }
  return { artifacts };
}
