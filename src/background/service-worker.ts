import { abortJob, kick, publish, reportFailure } from './scheduler';
import { cleanupDownload, download } from './downloads';
import { control, createJob, db, newTask, removeJob, snapshot } from '../storage/database';
import { slugFromInput } from '../shared/errors';
import { token } from '../sync/drive';
import type { ExportFormat, Options } from '../shared/types';
const wake = () => { void kick().catch(reportFailure); };
chrome.runtime.onInstalled.addListener(wake);
chrome.runtime.onStartup.addListener(wake);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name.startsWith('queue-')) wake(); });
chrome.downloads.onChanged.addListener(delta => { if (delta.state && delta.state.current !== 'in_progress') void cleanupDownload(delta.id).catch(reportFailure); });
function trusted(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && sender.url === chrome.runtime.getURL('popup/popup.html');
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== 'worker') return;
  if (!trusted(sender)) { sendResponse({ ok: false, error: '拒绝来自非控制界面的请求。' }); return; }
  void route(message).then(data => sendResponse({ ok: true, data }), error => sendResponse({ ok: false, error: error instanceof Error ? error.message : '操作失败。' }));
  return true;
});
async function route(message: any): Promise<unknown> {
  const jobId = typeof message.jobId === 'string' ? message.jobId : undefined;
  switch (message.type) {
    case 'STATE': return { ...await snapshot(jobId), oauthConfigured: !!chrome.runtime.getManifest().oauth2?.client_id };
    case 'START': {
      const slug = slugFromInput(String(message.course ?? ''));
      const input = message.options ?? {};
      if (!/^[a-zA-Z0-9-]{1,35}$/.test(input.language ?? '')) throw new Error('语言代码无效。');
      const options: Options = { language: input.language, allLanguages: input.allLanguages === true, includeReadings: input.includeReadings !== false, autoSync: input.autoSync === true };
      const id = crypto.randomUUID();
      await createJob({ id, slug, options, createdAt: new Date().toISOString(), status: 'active' });
      await chrome.storage.local.set({ settings: { course: slug, ...options } });
      wake(); return { jobId: id };
    }
    case 'CONTROL': {
      if (!jobId || !['pause','resume','cancel','retry'].includes(message.action)) throw new Error('无效的任务操作。');
      await control(jobId, message.action); abortJob(jobId); await publish(); wake(); return {};
    }
    case 'EXPORT': {
      if (!jobId || !['md','txt','json','zip'].includes(message.format)) throw new Error('无效导出格式。');
      await download(jobId, message.format as ExportFormat); return {};
    }
    case 'CONNECT': await token(true); return {};
    case 'SYNC': {
      if (!jobId) throw new Error('请选择任务。');
      const database = await db(), tx = database.transaction(['jobs','tasks'], 'readwrite');
      const job = await tx.objectStore('jobs').get(jobId);
      if (!job?.course) throw new Error('请先取得课程大纲。');
      const tasks = await tx.objectStore('tasks').index('jobId').getAll(jobId);
      if (tasks.some(t => !['succeeded','failed','skipped','cancelled','blocked_auth'].includes(t.state))) throw new Error('请等待采集完成后同步。');
      await tx.objectStore('tasks').put(newTask(jobId, 'drive', 'drive'));
      job.status = 'active'; await tx.objectStore('jobs').put(job); await tx.done; wake(); return {};
    }
    case 'DELETE': if (!jobId) throw new Error('请选择任务。'); else { abortJob(jobId); await removeJob(jobId); return {}; }
    default: throw new Error('未知操作。');
  }
}
void chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(reportFailure);
wake();
