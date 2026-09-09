import { bundle } from '../export/bundle';
import { courseFolder, itemPath, subtitleSuffix } from '../export/paths';
import { toSrt } from '../parsers/webvtt';
import { db } from '../storage/database';

const urls = new Set<string>();
let pending = 0;
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (
    message?.target !== 'offscreen' ||
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL('background/service-worker.js')
  )
    return;
  if (message.type === 'REVOKE') {
    if (urls.delete(message.url)) URL.revokeObjectURL(message.url);
    respond({ ok: true, empty: urls.size === 0 && pending === 0 });
    return;
  }
  if (
    message.type !== 'SIDECAR' &&
    (message.type !== 'BUNDLE' ||
      !['md', 'txt', 'json', 'zip'].includes(message.format))
  )
    return;
  pending++;
  void (
    message.type === 'SIDECAR'
      ? sidecar(message.taskId)
      : bundle(message.jobId, message.format)
  )
    .then(({ blob, name }) => {
      const url = URL.createObjectURL(blob);
      urls.add(url);
      pending--;
      respond({ ok: true, url, name });
    })
    .catch((e) => {
      pending--;
      respond({ ok: false, error: e.message });
    });
  return true;
});

async function sidecar(taskId: string): Promise<{ blob: Blob; name: string }> {
  const database = await db(),
    task = await database.get('tasks', taskId);
  if (!task?.artifactId || !['srt', 'vtt'].includes(task.sidecarFormat ?? ''))
    throw new Error('Invalid subtitle task.');
  const artifact = await database.get('artifacts', task.artifactId),
    job = await database.get('jobs', task.jobId);
  if (!artifact?.cues || !job?.course)
    throw new Error('Caption or course data is missing.');
  const name = `${courseFolder(job)}/${itemPath(job.course, artifact.itemId)}${subtitleSuffix(artifact.language ?? 'und', artifact.trackKey)}.${task.sidecarFormat}`;
  return {
    name,
    blob: new Blob(
      [task.sidecarFormat === 'srt' ? toSrt(artifact.cues) : artifact.raw],
      {
        type:
          task.sidecarFormat === 'srt'
            ? 'application/x-subrip'
            : 'text/vtt;charset=utf-8',
      },
    ),
  };
}
