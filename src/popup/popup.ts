import type { Snapshot } from '../shared/types';
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let jobId = '', busy = false, refreshSequence = 0;
async function send(type: string, values: Record<string, unknown> = {}): Promise<any> {
  const result = await chrome.runtime.sendMessage({ target: 'worker', type, ...values });
  if (!result?.ok) throw new Error(result?.error ?? '后台暂时不可用，请重新打开扩展。');
  return result.data;
}
function notice(text: string): void { el('notice').textContent = text; el('notice').classList.toggle('hidden', !text); }
async function action(work: () => Promise<void>): Promise<void> {
  if (busy) return; busy = true;
  try { notice(''); await work(); await refresh(); } catch (e) { notice(e instanceof Error ? e.message : '操作失败'); }
  finally { busy = false; }
}
const states: Record<string, string> = { active: '采集中', paused: '已暂停', complete: '已完成', blocked_auth: '需要登录 / 授权', cancelled: '已取消' };
async function refresh(): Promise<void> {
  const sequence = ++refreshSequence;
  const state: Snapshot = await send('STATE', { jobId: jobId || undefined });
  if (sequence !== refreshSequence) return;
  jobId = state.job?.id ?? '';
  const select = el<HTMLSelectElement>('jobs');
  select.replaceChildren(...(state.jobs.length ? state.jobs.map(j => new Option(`${j.course?.title ?? j.slug} · ${new Date(j.createdAt).toLocaleString()}`, j.id)) : [new Option('暂无任务','')]));
  select.value = jobId;
  const tasks = state.tasks, done = tasks.filter(t => ['succeeded','skipped','failed','cancelled'].includes(t.state)).length;
  const failures = tasks.filter(t => t.state === 'failed').length, skips = tasks.filter(t => t.state === 'skipped').length;
  el('job-status').textContent = state.job ? `${states[state.job.status]}${failures || skips ? ' · 含缺失项' : ''}` : '等待开始';
  el<HTMLProgressElement>('progress').max = Math.max(1, tasks.length); el<HTMLProgressElement>('progress').value = done;
  el('counts').textContent = tasks.length ? `${done}/${tasks.length} 个处理步骤 · ${state.artifactCount} 份文本 · ${skips} 跳过 · ${failures} 失败` : '关闭弹窗后，后台任务仍会继续。';
  const issues = tasks.filter(t => t.error || t.state === 'blocked_auth').map(t => `${t.item?.title ?? t.kind}${t.language ? ` (${t.language})` : ''}：${t.error ?? t.state}${t.code ? ` [${t.code}]` : ''}`);
  issues.push(...(state.job?.course?.warnings ?? []));
  el('issues').replaceChildren(...(issues.length ? issues : ['暂无异常。']).map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
  for (const id of ['pause','resume','retry','cancel','export','sync','delete']) el<HTMLButtonElement>(id).disabled = !jobId;
  el<HTMLButtonElement>('connect').disabled = !state.oauthConfigured;
  el<HTMLButtonElement>('sync').disabled = !jobId || !state.oauthConfigured;
  el<HTMLInputElement>('auto-sync').disabled = !state.oauthConfigured;
  el('drive-status').textContent = state.oauthConfigured ? '首次需授权；同步会更新此课程的 Markdown 全文。' : '本地导出可用。Drive 需先在 config.local.json 配置 OAuth Client ID。';
}
el('start-form').addEventListener('submit', event => { event.preventDefault(); void action(async () => {
  const result = await send('START', { course: el<HTMLInputElement>('course').value, options: { language: el<HTMLSelectElement>('language').value, allLanguages: el<HTMLInputElement>('all-languages').checked, includeReadings: el<HTMLInputElement>('readings').checked, autoSync: el<HTMLInputElement>('auto-sync').checked } });
  jobId = result.jobId; notice('任务已启动，可以关闭弹窗。');
}); });
el('detect').addEventListener('click', () => { void action(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('没有可读取的标签页。');
  const response = await chrome.tabs.sendMessage(tab.id, { type: 'COURSE_CONTEXT' }).catch(() => undefined);
  if (!response?.slug) throw new Error('请打开课程页面并刷新一次，或直接粘贴课程链接。');
  el<HTMLInputElement>('course').value = response.slug;
}); });
el('jobs').addEventListener('change', () => { jobId = el<HTMLSelectElement>('jobs').value; void refresh().catch(e => notice(e.message)); });
for (const name of ['pause','resume','retry','cancel']) el(name).addEventListener('click', () => { void action(async () => { await send('CONTROL', { jobId, action: name }); }); });
el('export').addEventListener('click', () => { void action(async () => { await send('EXPORT', { jobId, format: el<HTMLSelectElement>('format').value }); notice('已发起本地下载。'); }); });
el('connect').addEventListener('click', () => { void action(async () => { await send('CONNECT'); notice('Google Drive 已连接，可点击同步。'); }); });
el('sync').addEventListener('click', () => { void action(async () => { await send('SYNC', { jobId }); notice('同步任务已加入队列。'); }); });
el('delete').addEventListener('click', () => { if (confirm('删除此任务和本地文本？已导出的文件与 Drive 文件会保留。')) void action(async () => { await send('DELETE', { jobId }); jobId = ''; }); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.summary) void refresh().catch(e => notice(e.message));
  if (area === 'local' && changes.workerError?.newValue) notice(String(changes.workerError.newValue));
});
void (async () => {
  const stored = await chrome.storage.local.get('settings');
  const settings = stored.settings as (import('../shared/types').Options & { course?: string }) | undefined;
  el<HTMLInputElement>('course').value = settings?.course ?? 'packt-scalable-node-js-advanced-patterns-integration';
  if (settings) { el<HTMLSelectElement>('language').value = settings.language ?? 'en'; el<HTMLInputElement>('all-languages').checked = !!settings.allLanguages; el<HTMLInputElement>('readings').checked = settings.includeReadings !== false; el<HTMLInputElement>('auto-sync').checked = !!settings.autoSync; }
  await refresh();
})().catch(e => notice(e.message));
