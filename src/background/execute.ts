import {
  chooseTracks,
  materials,
  metadata,
  readingAssets,
  subtitle,
  tracks,
} from '../api/coursera';
import { requestText } from '../api/http';
import { parseCourse } from '../parsers/course';
import { htmlToMarkdown, htmlToText, markdownToText } from '../parsers/reading';
import { parseVtt, toTimedText } from '../parsers/webvtt';
import { AppError } from '../shared/errors';
import type { Artifact, Task, TaskResult } from '../shared/types';
import { db, newTask } from '../storage/database';
import { syncJob } from '../sync/drive';
import { startNativeDownload } from './media-downloads';
export async function execute(
  task: Task,
  signal: AbortSignal,
): Promise<TaskResult> {
  const job = await (await db()).get('jobs', task.jobId);
  if (!job) throw new AppError('JOB_MISSING', 'Job not found.');
  if (task.kind === 'outline') {
    const course = parseCourse(await materials(job.slug, signal), job.slug);
    const children = course.modules.flatMap((m) =>
      m.lessons.flatMap((l) =>
        l.items.flatMap((item) => {
          const kind = item.type === 'lecture' ? 'lecture' : 'reading';
          const skip = item.locked
            ? 'Item is locked.'
            : !['lecture', 'supplement'].includes(item.type)
              ? `Unsupported item type: ${item.type}`
              : item.type === 'supplement' && !job.options.includeReadings
                ? 'Reading collection was not selected.'
                : '';
          const tasks = [
            newTask(job.id, `item:${item.id}`, kind, {
              item,
              ...(skip ? { state: 'skipped', error: skip } : {}),
            }),
          ];
          if (
            job.options.includeVideos &&
            item.type === 'lecture' &&
            !item.locked
          )
            tasks.push(newTask(job.id, `video:${item.id}`, 'video', { item }));
          return tasks;
        }),
      ),
    );
    return { course, children };
  }
  if (task.kind === 'video' || task.kind === 'sidecar') {
    await startNativeDownload(task, job, signal);
    return { external: true };
  }
  if (task.kind === 'drive') {
    await syncJob(job.id, signal);
    return {};
  }
  if (!job.course || !task.item)
    throw new AppError(
      'TASK_INVALID',
      'The task is missing course information.',
    );
  const courseId = job.course.id,
    item = task.item;
  const source = `https://www.coursera.org/learn/${job.slug}/${item.type === 'lecture' ? 'lecture' : 'supplement'}/${encodeURIComponent(item.id)}`;
  if (task.kind === 'lecture') {
    const selected = chooseTracks(
      tracks(await metadata('lecture', courseId, item.id, signal)),
      job.options.language,
      job.options.allLanguages,
    );
    if (!selected.length) return { skip: 'No WebVTT captions are available.' };
    return {
      children: selected.map((track) =>
        newTask(job.id, `subtitle:${item.id}:${track.key}`, 'subtitle', {
          item,
          assetKey: track.key,
          language: track.language,
        }),
      ),
    };
  }
  if (task.kind === 'subtitle') {
    if (!task.assetKey)
      throw new AppError(
        'TASK_INVALID',
        'The caption task is missing an asset key.',
      );
    const { raw, track } = await subtitle(
      courseId,
      item.id,
      task.assetKey,
      signal,
    );
    const { cues, warnings } = parseVtt(raw);
    if (!cues.length) return { skip: 'The caption track is empty.' };
    if (!job.options.allLanguages && track.language !== job.options.language)
      warnings.push(
        `Preferred ${job.options.language}; exported ${track.language}.`,
      );
    const text = cues.map((c) => c.text).join('\n');
    return {
      artifacts: [
        {
          id: task.id,
          jobId: job.id,
          itemId: item.id,
          title: item.title,
          kind: 'subtitle',
          language: track.language,
          trackKey: track.key,
          raw,
          rawFormat: 'vtt',
          text,
          markdown: toTimedText(cues),
          cues,
          source,
          warnings,
        },
      ],
      children: job.options.includeVideos
        ? (['srt', 'vtt'] as const).map((sidecarFormat) =>
            newTask(
              job.id,
              `sidecar:${item.id}:${track.key}:${sidecarFormat}`,
              'sidecar',
              {
                item,
                artifactId: task.id,
                language: track.language,
                sidecarFormat,
              },
            ),
          )
        : [],
    };
  }
  const artifacts: Artifact[] = [];
  // One task per reading item; commit all assets together, never silently lose siblings.
  const resolved = readingAssets(
    await metadata('reading', courseId, item.id, signal),
  );
  if (!resolved.assets.length)
    return {
      skip: `Reading format is unsupported (${resolved.unsupported} resource(s)).`,
    };
  for (const asset of resolved.assets) {
    let raw: string;
    try {
      raw = await readingContent(asset, signal);
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== 'FORBIDDEN') throw e;
      const refreshed = readingAssets(
        await metadata('reading', courseId, item.id, signal),
      ).assets.find((a) => a.key === asset.key);
      if (!refreshed)
        throw new AppError(
          'ASSET_MISSING',
          'The reading asset disappeared after refresh.',
        );
      raw = await readingContent(refreshed, signal);
    }
    artifacts.push({
      id: `${task.id}:${asset.key}`,
      jobId: job.id,
      itemId: item.id,
      title: item.title,
      kind: 'reading',
      raw,
      rawFormat: asset.format,
      text:
        asset.format === 'html'
          ? htmlToText(raw)
          : asset.format === 'md'
            ? markdownToText(raw)
            : raw,
      markdown:
        asset.format === 'html'
          ? htmlToMarkdown(
              raw,
              asset.url
                ? new URL(asset.url, 'https://www.coursera.org').href.split(
                    /[?#]/,
                  )[0]
                : source,
            )
          : raw,
      source,
      warnings: resolved.unsupported
        ? [
            `This item has ${resolved.unsupported} additional unsupported resource(s).`,
          ]
        : [],
    });
  }
  return { artifacts };
}

async function readingContent(
  asset: { content?: string; url?: string },
  signal: AbortSignal,
): Promise<string> {
  if (asset.content !== undefined) return asset.content;
  if (!asset.url)
    throw new AppError(
      'ASSET_MISSING',
      'The reading asset has no text or download URL.',
    );
  return requestText(asset.url, signal);
}
