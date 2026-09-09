import { object } from '../parsers/course';
import { slugFromInput } from '../shared/errors';
import type { ExportFormat, Options } from '../shared/types';
import { videoOptions } from '../shared/video';
import {
  control,
  createJob,
  db,
  newTask,
  removeJob,
  snapshot,
} from '../storage/database';
import { token } from '../sync/drive';
import { cleanupDownload, download } from './downloads';
import { controlDownloads } from './media-downloads';
import { abortJob, kick, publish, reportFailure } from './scheduler';

const wake = () => {
  void kick().catch(reportFailure);
};
chrome.runtime.onInstalled.addListener(wake);
chrome.runtime.onStartup.addListener(wake);
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith('queue-')) wake();
});
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && delta.state.current !== 'in_progress') {
    void cleanupDownload(delta.id).catch(reportFailure);
    wake();
  }
});
function trusted(sender: chrome.runtime.MessageSender): boolean {
  return (
    sender.id === chrome.runtime.id &&
    sender.url === chrome.runtime.getURL('popup/popup.html')
  );
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'worker') return;
  if (!trusted(sender)) {
    sendResponse({
      ok: false,
      error: 'Requests from untrusted interfaces are rejected.',
    });
    return;
  }
  void route(message).then(
    (data) => sendResponse({ ok: true, data }),
    (error) =>
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : 'Operation failed.',
      }),
  );
  return true;
});
async function route(raw: unknown): Promise<unknown> {
  const message = object(raw);
  const jobId = typeof message.jobId === 'string' ? message.jobId : undefined;
  switch (message.type) {
    case 'STATE':
      return {
        ...(await snapshot(jobId)),
        oauthConfigured: !!chrome.runtime.getManifest().oauth2?.client_id,
      };
    case 'START': {
      const slug = slugFromInput(String(message.course ?? ''));
      const input = object(message.options);
      if (
        typeof input.language !== 'string' ||
        !/^[a-zA-Z0-9-]{1,35}$/.test(input.language)
      )
        throw new Error('Invalid language code.');
      const options: Options = {
        language: input.language,
        allLanguages: input.allLanguages === true,
        includeReadings: input.includeReadings !== false,
        autoSync: input.autoSync === true,
        ...videoOptions(input),
      };
      const id = crypto.randomUUID();
      await createJob({
        id,
        slug,
        options,
        createdAt: new Date().toISOString(),
        status: 'active',
      });
      await chrome.storage.local.set({
        settings: { course: slug, ...options },
      });
      wake();
      return { jobId: id };
    }
    case 'CONTROL': {
      const action = message.action;
      if (
        !jobId ||
        (action !== 'pause' &&
          action !== 'resume' &&
          action !== 'cancel' &&
          action !== 'retry')
      )
        throw new Error('Invalid job action.');
      await control(jobId, action);
      abortJob(jobId);
      await controlDownloads(jobId, action);
      await publish();
      wake();
      return {};
    }
    case 'EXPORT': {
      if (
        !jobId ||
        typeof message.format !== 'string' ||
        !['md', 'txt', 'json', 'zip'].includes(message.format)
      )
        throw new Error('Invalid export format.');
      await download(jobId, message.format as ExportFormat);
      return {};
    }
    case 'CONNECT':
      await token(true);
      return {};
    case 'SYNC': {
      if (!jobId) throw new Error('Select a job.');
      const database = await db(),
        tx = database.transaction(['jobs', 'tasks'], 'readwrite');
      const job = await tx.objectStore('jobs').get(jobId);
      if (!job?.course) throw new Error('Fetch the course outline first.');
      const tasks = await tx.objectStore('tasks').index('jobId').getAll(jobId);
      if (
        tasks.some(
          (t) =>
            ![
              'succeeded',
              'failed',
              'skipped',
              'cancelled',
              'blocked_auth',
            ].includes(t.state),
        )
      )
        throw new Error('Wait for collection to finish before syncing.');
      await tx.objectStore('tasks').put(newTask(jobId, 'drive', 'drive'));
      job.status = 'active';
      await tx.objectStore('jobs').put(job);
      await tx.done;
      wake();
      return {};
    }
    case 'DELETE':
      if (!jobId) throw new Error('Select a job.');
      else {
        await control(jobId, 'cancel');
        abortJob(jobId);
        await controlDownloads(jobId, 'cancel');
        await removeJob(jobId);
        return {};
      }
    default:
      throw new Error('Unknown operation.');
  }
}
void chrome.storage.local
  .setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
  .catch(reportFailure);
wake();
