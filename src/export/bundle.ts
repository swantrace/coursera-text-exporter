import { zipSync, strToU8 } from 'fflate';
import { db } from '../storage/database';
import { toSrt } from '../parsers/webvtt';
import type { ExportFormat } from '../shared/types';
export function filename(value: string): string { return value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/\.{2,}/g, '-').replace(/[. ]+$/g, '').slice(0, 90) || 'untitled'; }
const heading = (value: string) => value.replace(/[\r\n]+/g, ' ').replace(/([\\`*_[\]<>])/g, '\\$1');
export async function bundle(jobId: string, format: ExportFormat): Promise<{ blob: Blob; name: string }> {
  const database = await db(), job = await database.get('jobs', jobId);
  if (!job) throw new Error('任务不存在。');
  const tasks = (await database.getAllFromIndex('tasks', 'jobId', jobId)).filter(t => t.kind !== 'drive');
  const artifacts = await database.getAllFromIndex('artifacts', 'jobId', jobId);
  const title = job.course?.title ?? job.slug;
  const report = { createdAt: job.createdAt, course: job.slug, warnings: job.course?.warnings ?? [],
    items: tasks.map(t => ({ kind: t.kind, itemId: t.item?.id, title: t.item?.title, language: t.language, status: t.state, code: t.code, reason: t.error })),
    warningsByArtifact: artifacts.filter(a => a.warnings.length).map(a => ({ itemId: a.itemId, language: a.language, warnings: a.warnings })) };
  const json = JSON.stringify({ schemaVersion: 1, course: job.course, options: job.options, report, artifacts }, null, 2);
  const files: Record<string, Uint8Array> = {};
  const markdown: string[] = [`# ${heading(title)}`, `来源：https://www.coursera.org/learn/${job.slug}`, ''];
  const text: string[] = [title, ''];
  const orderedArtifacts = [];
  for (const [mi, module] of (job.course?.modules ?? []).entries()) {
    markdown.push(`## ${heading(module.title)}`); text.push(module.title);
    for (const [li, lesson] of module.lessons.entries()) {
      markdown.push(`### ${heading(lesson.title)}`); text.push(lesson.title);
      for (const [ii, item] of lesson.items.entries()) {
        markdown.push(`#### ${heading(item.title)}`); text.push(item.title);
        const found = artifacts.filter(a => a.itemId === item.id).sort((a,b) => a.id.localeCompare(b.id));
        orderedArtifacts.push(...found);
        for (const [ai, artifact] of found.entries()) {
          const language = artifact.language ? ` (${artifact.language})` : '';
          markdown.push(`[来源](${artifact.source})${language}`, '', artifact.markdown, '');
          text.push(language, artifact.text, '');
          const path = `modules/${String(mi+1).padStart(2,'0')}-${filename(module.title)}/${String(li+1).padStart(2,'0')}-${filename(lesson.title)}/${String(ii+1).padStart(2,'0')}-${filename(item.title)}-${filename(item.id)}-${ai+1}${artifact.language ? '.' + filename(artifact.language) : ''}`;
          files[`${path}.txt`] = strToU8(artifact.text);
          if (artifact.cues) {
            files[`${path}.vtt`] = strToU8(artifact.raw);
            files[`${path}.srt`] = strToU8(toSrt(artifact.cues));
          } else {
            files[`${path}.md`] = strToU8(artifact.markdown);
            files[`${path}.source.${artifact.rawFormat}`] = strToU8(artifact.raw);
          }
        }
        const issues = tasks.filter(t => t.item?.id === item.id && !['succeeded'].includes(t.state));
        for (const issue of issues) {
          const note = `[${issue.state}] ${issue.error ?? '尚未完成'}${issue.language ? ` (${issue.language})` : ''}`;
          markdown.push(`> ${heading(note)}`, ''); text.push(note);
        }
      }
    }
  }
  const warningLines = [...(job.course?.warnings ?? []), ...orderedArtifacts.flatMap(a => a.warnings.map(w => `${a.title}: ${w}`))];
  if (warningLines.length) { markdown.push('## 采集提示', ...warningLines.map(w => `- ${heading(w)}`)); text.push('采集提示', ...warningLines); }
  files['course.json'] = strToU8(json);
  files['course.md'] = strToU8(markdown.join('\n\n'));
  files['course.txt'] = strToU8(text.join('\n'));
  files['report.json'] = strToU8(JSON.stringify(report, null, 2));
  const content = format === 'zip' ? zipSync(files) : files[`course.${format}`];
  const mime = { zip: 'application/zip', md: 'text/markdown', txt: 'text/plain', json: 'application/json' }[format];
  return { blob: new Blob([new Uint8Array(content)], { type: mime }), name: `${filename(job.slug)}.${format}` };
}
