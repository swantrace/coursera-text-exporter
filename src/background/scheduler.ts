import { claim, db, fail, reconcile, settle, snapshot } from '../storage/database';
import { normalizeError } from '../shared/errors';
import { execute } from './execute';
import type { Task } from '../shared/types';
const active = new Map<string, { task: Task; controller: AbortController }>();
let pumping: Promise<void> | undefined;
let requested = false;
export function abortJob(jobId: string): void { for (const value of active.values()) if (value.task.jobId === jobId) value.controller.abort(); }
export async function publish(): Promise<void> {
  const state = await snapshot();
  await chrome.storage.local.set({ summary: { jobId: state.job?.id, status: state.job?.status, updatedAt: Date.now(), completed: state.tasks.filter(t => ['succeeded','skipped','failed'].includes(t.state)).length, total: state.tasks.length } });
}
async function run(task: Task): Promise<void> {
  const controller = new AbortController(); active.set(task.id, { task, controller });
  // Renew only genuine in-flight work; scheduling never relies on this timer for recovery.
  const renewal = setInterval(() => { void (async () => {
    const database = await db(), tx = database.transaction('tasks', 'readwrite');
    const current = await tx.store.get(task.id);
    if (current && current.lease === task.lease && current.state === 'running') { current.leaseUntil = Date.now() + 90_000; await tx.store.put(current); }
    await tx.done;
  })().catch(() => controller.abort()); }, 20_000);
  try { await settle(task, await execute(task, controller.signal)); }
  catch (error) {
    const e = normalizeError(error);
    const soft = ['RATE_WAIT','UPLOAD_PROGRESS'].includes(e.code);
    const attempts = task.attempts + (soft ? 0 : 1);
    const retry = e.retryable && (soft || attempts <= 4);
    const auth = ['COURSERA_AUTH','GOOGLE_AUTH','GOOGLE_CONFIG'].includes(e.code);
    await fail(task, { state: auth ? 'blocked_auth' : retry ? 'retry_wait' : 'failed', code: e.code, error: e.message, attempts,
      nextAt: Math.max(e.retryAt, Date.now() + (soft ? 500 : Math.random() * Math.min(60_000, 1000 * 2 ** attempts))) },
      e.code === 'COURSERA_AUTH' ? 'blocked_auth' : e.code === 'STORAGE_FULL' ? 'paused' : undefined);
  } finally { clearInterval(renewal); active.delete(task.id); }
}
export function kick(): Promise<void> {
  if (pumping) { requested = true; return pumping; }
  requested = false;
  pumping = pump().finally(() => { pumping = undefined; if (requested) void kick().catch(reportFailure); });
  return pumping;
}
async function pump(): Promise<void> {
  if (!await chrome.alarms.get('queue-recovery')) await chrome.alarms.create('queue-recovery', { periodInMinutes: 0.5 });
  // Short dispatch window; each batch finishes before another is claimed. Alarm recovers termination.
  const deadline = Date.now() + 15_000;
  do {
    await reconcile();
    const batch: Task[] = [];
    for (let i = 0; i < 3; i++) {
      const task = await claim(); if (!task) break;
      batch.push(task);
      // Drive tasks are serialized across jobs by one-task batches.
      if (task.kind === 'drive') break;
    }
    if (!batch.length) break;
    // Keep Drive execution exclusive even if it was claimed after collection tasks.
    await Promise.all(batch.filter(t => t.kind !== 'drive').map(run));
    for (const task of batch.filter(t => t.kind === 'drive')) await run(task);
    await publish();
  } while (Date.now() < deadline);
  await reconcile(); await publish();
  const database = await db(), jobs = await database.getAll('jobs'), tasks = await database.getAll('tasks');
  const activeIds = new Set(jobs.filter(j => j.status === 'active').map(j => j.id));
  const waiting = tasks.filter(t => activeIds.has(t.jobId) && ['pending','retry_wait','running'].includes(t.state));
  if (waiting.length) {
    const next = Math.min(...waiting.map(t => t.state === 'running' ? t.leaseUntil ?? Date.now() : t.nextAt));
    await chrome.alarms.create('queue-next', { when: Math.max(Date.now() + 500, next) });
    // Fast continuation while alive; alarm remains the durable fallback.
    if (next <= Date.now() + 1500) setTimeout(() => { void kick().catch(reportFailure); }, Math.max(500, next - Date.now()));
  } else { await chrome.alarms.clear('queue-recovery'); await chrome.alarms.clear('queue-next'); }
}
export function reportFailure(error: unknown): void {
  void chrome.storage.local.set({ workerError: normalizeError(error).message }).catch(() => {});
}
