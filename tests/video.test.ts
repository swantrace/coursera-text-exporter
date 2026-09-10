import { readFileSync } from 'node:fs';
import { required } from './helpers';
import 'fake-indexeddb/auto';
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { videoSource } from '../src/api/coursera';
import { execute } from '../src/background/execute';
import {
  controlDownloads,
  startNativeDownload,
  synchronizeDownloads,
} from '../src/background/media-downloads';
import { bundle } from '../src/export/bundle';
import { courseFolder, itemPath, subtitleSuffix } from '../src/export/paths';
import { parseCourse } from '../src/parsers/course';
import type { Job, Task } from '../src/shared/types';
import { videoOptions } from '../src/shared/video';
import * as storage from '../src/storage/database';
import {
  claim,
  control,
  createJob,
  db,
  newTask,
  reconcile,
  settle,
  snapshot,
} from '../src/storage/database';
import { lecture, outline } from './fixtures';

const media = {
  elements: [{ id: 'course-1~v1' }],
  linked: {
    'onDemandVideos.v1': [
      {
        id: 'vid',
        subtitlesVtt: {},
        sources: {
          byResolution: {
            '1080p': {
              mp4VideoUrl: 'https://d3c33hcgiwev3.cloudfront.net/full1080.mp4',
              webMVideoUrl:
                'https://d3c33hcgiwev3.cloudfront.net/full1080.webm',
            },
            '720p': {
              mp4VideoUrl: 'https://d3c33hcgiwev3.cloudfront.net/full720.mp4',
            },
            '360p': {
              mp4VideoUrl: 'https://d3c33hcgiwev3.cloudfront.net/full360.mp4',
              webMVideoUrl: 'https://d3c33hcgiwev3.cloudfront.net/full360.webm',
            },
            '240p': {
              mp4VideoUrl: 'https://d3c33hcgiwev3.cloudfront.net/full240.mp4',
            },
          },
        },
      },
    ],
  },
};
const course = parseCourse(outline, 'test-course');
type TestDownload = Pick<
  chrome.downloads.DownloadItem,
  | 'id'
  | 'byExtensionId'
  | 'filename'
  | 'startTime'
  | 'state'
  | 'paused'
  | 'bytesReceived'
  | 'totalBytes'
  | 'mime'
  | 'url'
  | 'error'
>;
let job: Job,
  downloads: TestDownload[],
  values: Record<string, unknown>,
  nextId: number;
beforeEach(async () => {
  const database = await db();
  for (const store of ['jobs', 'tasks', 'artifacts', 'sync'] as const)
    await database.clear(store);
  job = {
    id: 'job-video',
    slug: 'test-course',
    createdAt: new Date().toISOString(),
    status: 'active',
    course,
    options: {
      language: 'en',
      allLanguages: false,
      includeReadings: true,
      autoSync: false,
      includeVideos: true,
      videoResolution: '360p',
      videoFormat: 'mp4',
    },
  };
  await createJob(job);
  const initial = required(await claim());
  await settle(initial, {});
  downloads = [];
  values = {};
  nextId = 10;
  vi.stubGlobal('chrome', {
    runtime: { id: 'extension-test' },
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: values[key] })),
        set: vi.fn(async (update: Record<string, unknown>) =>
          Object.assign(values, update),
        ),
      },
    },
    downloads: {
      download: vi.fn(async (options: chrome.downloads.DownloadOptions) => {
        const item: TestDownload = {
          id: nextId++,
          byExtensionId: 'extension-test',
          filename: `/downloads/${options.filename}`,
          startTime: new Date().toISOString(),
          state: 'in_progress',
          paused: false,
          bytesReceived: 0,
          totalBytes: 100,
          mime: 'video/mp4',
          url: options.url,
        };
        downloads.push(item);
        return item.id;
      }),
      search: vi.fn(async (query: chrome.downloads.DownloadQuery) =>
        query.id === undefined
          ? [...downloads].reverse()
          : downloads.filter((d) => d.id === query.id),
      ),
      pause: vi.fn(async (id: number) => {
        required(downloads.find((d) => d.id === id)).paused = true;
      }),
      resume: vi.fn(async (id: number) => {
        required(downloads.find((d) => d.id === id)).paused = false;
      }),
      cancel: vi.fn(async (id: number) => {
        Object.assign(required(downloads.find((d) => d.id === id)), {
          state: 'interrupted',
          error: 'USER_CANCELED',
        });
      }),
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify(media), {
          headers: { 'Content-Type': 'application/json' },
        }),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());
async function videoTask(): Promise<Task> {
  const task = newTask(job.id, 'video:v1', 'video', {
    item: course.modules[0].lessons[0].items[0],
  });
  await (await db()).put('tasks', task);
  return required(await claim());
}
it('defaults to opt-in video with 360p MP4 and validates options', () => {
  expect(videoOptions({})).toEqual({
    includeVideos: false,
    videoResolution: '360p',
    videoFormat: 'mp4',
  });
  expect(() => videoOptions({ videoResolution: '4k' })).toThrow();
});
it('selects the requested format and highest resolution within the cap', () => {
  expect(videoSource(media, '1080p', 'webm').resolution).toBe('1080p');
  expect(videoSource(media, '720p', 'webm')).toMatchObject({
    resolution: '360p',
    format: 'webm',
  });
  expect(videoSource(media, '360p', 'mp4').url).toContain('full360.mp4');
  expect(videoSource(media, '240p', 'mp4').resolution).toBe('240p');
  expect(() => videoSource(media, '240p', 'webm')).toThrow(/No direct/);
  expect(() => videoSource(lecture, '360p', 'mp4')).toThrow(/byResolution/);
});
it('starts Chrome downloads and only completes the task after disk download completion', async () => {
  const task = await videoTask();
  await startNativeDownload(task, job, new AbortController().signal);
  let state = await snapshot();
  expect(state.tasks.find((t) => t.kind === 'video')?.state).toBe(
    'downloading',
  );
  await reconcile();
  expect((await snapshot()).job?.status).toBe('active');
  expect(chrome.downloads.download).toHaveBeenCalledWith(
    expect.objectContaining({
      filename: `${courseFolder(job)}/${itemPath(course, 'v1')}.mp4`,
      saveAs: false,
    }),
  );
  downloads[0].state = 'complete';
  downloads[0].bytesReceived = 100;
  await synchronizeDownloads();
  await reconcile();
  state = await snapshot();
  expect(state.job?.status).toBe('complete');
  expect(state.tasks.find((t) => t.kind === 'video')?.file?.bytesReceived).toBe(
    100,
  );
  expect(JSON.stringify(state)).not.toContain('cloudfront.net');
});
it('keeps the Chrome startup error and filename without persisting signed URLs', async () => {
  const task = await videoTask();
  vi.mocked(chrome.downloads.download).mockRejectedValueOnce(
    new Error('Invalid filename: https://cdn.test/video.mp4?Signature=secret'),
  );
  await startNativeDownload(task, job, new AbortController().signal);
  const stored = required(await (await db()).get('tasks', task.id));
  expect(stored.state).toBe('failed');
  expect(stored.code).toBe('DOWNLOAD_START');
  expect(stored.error).toContain('Invalid filename');
  expect(stored.error).toContain(stored.file?.filename);
  expect(stored.error).not.toContain('Signature=secret');
});
it('recovers a post-start failure without marking a live download as failed', async () => {
  const task = await videoTask();
  const database = await db();
  const connection = vi.spyOn(storage, 'db').mockResolvedValue(database);
  const get = vi
    .spyOn(database, 'get')
    .mockRejectedValueOnce(new Error('Status read failed'));
  try {
    await startNativeDownload(task, job, new AbortController().signal);
  } finally {
    get.mockRestore();
    connection.mockRestore();
  }
  const stored = required(await database.get('tasks', task.id));
  expect(stored.state).toBe('downloading');
  expect(stored.code).toBe('DOWNLOAD_BOOKKEEPING');
  expect(stored.file?.downloadId).toBe(downloads[0].id);
  expect(chrome.downloads.cancel).not.toHaveBeenCalled();
  downloads[0].state = 'complete';
  await synchronizeDownloads();
  expect((await database.get('tasks', task.id))?.state).toBe('succeeded');
  expect(chrome.downloads.download).toHaveBeenCalledTimes(1);
});
it('cleans directory endings after truncating long course titles', () => {
  const longCourse = structuredClone(course);
  longCourse.modules[0].title = `${'A'.repeat(34)} trailing title`;
  longCourse.modules[0].lessons[0].title = `${'B'.repeat(34)}. remaining title`;
  const path = itemPath(longCourse, 'v1');
  expect(path.split('/').every((segment) => !/[. ]$/.test(segment))).toBe(true);
});
it('refreshes the metadata after forbidden signed downloads instead of retrying a stale URL', async () => {
  const task = await videoTask();
  await startNativeDownload(task, job, new AbortController().signal);
  downloads[0].state = 'interrupted';
  downloads[0].error = 'SERVER_FORBIDDEN';
  await synchronizeDownloads();
  const retry = required(await claim(Date.now() + 100000));
  expect(retry.kind).toBe('video');
  // Reset the test clock reservation without sleeping.
  values = {};
  await startNativeDownload(retry, job, new AbortController().signal);
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(downloads).toHaveLength(2);
});
it('recovers the crash window between download initiation and ID persistence', async () => {
  const task = await videoTask();
  await startNativeDownload(task, job, new AbortController().signal);
  const database = await db();
  const stored = required(await database.get('tasks', task.id));
  delete stored.file?.downloadId;
  await database.put('tasks', stored);
  await synchronizeDownloads();
  expect((await database.get('tasks', task.id))?.file?.downloadId).toBe(
    downloads[0].id,
  );
  expect(chrome.downloads.download).toHaveBeenCalledTimes(1);
});
it('pauses, resumes and cancels native downloads along with the job', async () => {
  const task = await videoTask();
  await startNativeDownload(task, job, new AbortController().signal);
  await control(job.id, 'pause');
  await controlDownloads(job.id, 'pause');
  expect(downloads[0].paused).toBe(true);
  await control(job.id, 'resume');
  await controlDownloads(job.id, 'resume');
  expect(downloads[0].paused).toBe(false);
  await control(job.id, 'cancel');
  await controlDownloads(job.id, 'cancel');
  await synchronizeDownloads();
  expect(downloads[0].error).toBe('USER_CANCELED');
  expect((await (await db()).get('tasks', task.id))?.state).toBe('cancelled');
});
it('preserves user cancellation and rejects HTML downloads presented as videos', async () => {
  const task = await videoTask();
  await startNativeDownload(task, job, new AbortController().signal);
  downloads[0].state = 'complete';
  downloads[0].mime = 'text/html';
  await synchronizeDownloads();
  expect((await (await db()).get('tasks', task.id))?.code).toBe(
    'VIDEO_CONTENT_TYPE',
  );
});
it('limits active native videos without blocking text tasks', async () => {
  const database = await db();
  for (let i = 0; i < 3; i++)
    await database.put('tasks', newTask(job.id, `video:${i}`, 'video'));
  await database.put('tasks', newTask(job.id, 'z-subtitle', 'subtitle'));
  expect((await claim())?.kind).toBe('video');
  expect((await claim())?.kind).toBe('video');
  expect((await claim())?.kind).toBe('subtitle');
  expect(await claim()).toBeUndefined();
});
it('creates a video task independently of the subtitle discovery task', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(outline))),
  );
  const result = await execute(
    newTask(job.id, 'new-outline', 'outline'),
    new AbortController().signal,
  );
  expect(result.children?.filter((t) => t.kind === 'video')).toHaveLength(1);
  expect(
    result.children?.some((t) => t.kind === 'lecture' && t.item?.id === 'v1'),
  ).toBe(true);
});
it('requests locked outline entries and skips them without blocking accessible items', async () => {
  const response = structuredClone(outline);
  const locked = required(
    response.linked['onDemandCourseMaterialItems.v2'].find(
      (item) => item.id === 'locked',
    ),
  );
  locked.contentSummary.typeName = 'staffGraded';
  locked.name = 'Bonus questions';
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: URL) => {
      const query = new URL(input).searchParams;
      expect(query.get('fields')).toContain('isLocked');
      if (query.get('showLockedItems') !== 'true') {
        response.linked['onDemandCourseMaterialItems.v2'] = response.linked[
          'onDemandCourseMaterialItems.v2'
        ].filter((item) => item.id !== 'locked');
      }
      return new Response(JSON.stringify(response));
    }),
  );
  const result = await execute(
    newTask(job.id, 'outline-check', 'outline'),
    new AbortController().signal,
  );
  expect(
    result.children?.find((task) => task.item?.id === 'locked'),
  ).toMatchObject({
    state: 'skipped',
    item: { title: 'Bonus questions', locked: true, type: 'staffGraded' },
  });
  expect(result.children?.find((task) => task.kind === 'video')).toMatchObject({
    state: 'pending',
    item: { id: 'v1' },
  });
  expect(result.children?.find((task) => task.item?.id === 'r1')).toMatchObject(
    { state: 'pending', kind: 'reading' },
  );
});
it('matches ZIP subtitle paths to the same lecture stem as the native video', async () => {
  const database = await db();
  await database.put('artifacts', {
    id: 'a',
    jobId: job.id,
    itemId: 'v1',
    title: 'Welcome',
    kind: 'subtitle',
    language: 'en',
    trackKey: 'en:0',
    raw: 'WEBVTT\n\n',
    rawFormat: 'vtt',
    text: 'hello',
    markdown: 'hello',
    cues: [{ startMs: 0, endMs: 1000, text: 'hello' }],
    source: 'https://www.coursera.org/learn/test',
    warnings: [],
  });
  const { blob } = await bundle(job.id, 'zip');
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const stem = itemPath(course, 'v1');
  expect(strFromU8(files[`${stem}.en.srt`])).toContain(
    '00:00:00,000 --> 00:00:01,000',
  );
  expect(files[`${stem}.en.vtt`]).toBeDefined();
  expect(subtitleSuffix('en', 'en:1')).toBe('.en.track2');
});

it('reads all formats from the sanitized real Coursera video response', () => {
  const raw = JSON.parse(
    readFileSync('tests/fixtures/preview-lecture.json', 'utf8'),
  );
  for (const resolution of ['1080p', '720p', '360p', '240p'] as const)
    for (const format of ['webm', 'mp4'] as const) {
      expect(videoSource(raw, resolution, format)).toMatchObject({
        resolution,
        format,
      });
    }
  const missing720 = structuredClone(raw);
  delete missing720.linked['onDemandVideos.v1'][0].sources.byResolution['720p'];
  expect(videoSource(missing720, '720p', 'mp4').resolution).toBe('540p');
});
