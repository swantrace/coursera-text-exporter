import { openDB, type DBSchema } from 'idb';
import type { Artifact, Job, SyncRecord, Task, TaskResult } from '../shared/types';
interface Schema extends DBSchema {
  jobs: { key: string; value: Job };
  tasks: { key: string; value: Task; indexes: { jobId: string } };
  artifacts: { key: string; value: Artifact; indexes: { jobId: string } };
  sync: { key: string; value: SyncRecord };
}
export const db = () => openDB<Schema>('coursera-text-exporter', 1, { upgrade(database) {
  database.createObjectStore('jobs', { keyPath: 'id' });
  database.createObjectStore('tasks', { keyPath: 'id' }).createIndex('jobId', 'jobId');
  database.createObjectStore('artifacts', { keyPath: 'id' }).createIndex('jobId', 'jobId');
  database.createObjectStore('sync', { keyPath: 'key' });
} });
export function newTask(jobId: string, key: string, kind: Task['kind'], extra: Partial<Task> = {}): Task {
  return { id: `${jobId}:${key}`, jobId, kind, state: 'pending', attempts: 0, nextAt: 0, ...extra };
}
export async function createJob(job: Job): Promise<void> {
  const database = await db(), tx = database.transaction(['jobs', 'tasks'], 'readwrite');
  await tx.objectStore('jobs').put(job);
  await tx.objectStore('tasks').put(newTask(job.id, 'outline', 'outline'));
  await tx.done;
}
export async function claim(now = Date.now()): Promise<Task | undefined> {
  const database = await db(), tx = database.transaction(['jobs', 'tasks'], 'readwrite');
  const jobs = new Map((await tx.objectStore('jobs').getAll()).map(j => [j.id, j]));
  const tasks = await tx.objectStore('tasks').getAll();
  for (const task of tasks) {
    if (jobs.get(task.jobId)?.status !== 'active') continue;
    if (task.kind === 'drive' && tasks.some(other => other.jobId === task.jobId && other.kind !== 'drive' && !['succeeded','skipped','failed','cancelled'].includes(other.state))) continue;
    if (task.state === 'running' && (task.leaseUntil ?? 0) <= now) task.state = 'pending';
    if (!['pending', 'retry_wait'].includes(task.state) || task.nextAt > now) continue;
    task.state = 'running'; task.lease = crypto.randomUUID(); task.leaseUntil = now + 90_000;
    await tx.objectStore('tasks').put(task); await tx.done; return task;
  }
  await tx.done; return undefined;
}
export async function settle(task: Task, result: TaskResult): Promise<boolean> {
  const database = await db(), tx = database.transaction(['jobs', 'tasks', 'artifacts'], 'readwrite');
  const current = await tx.objectStore('tasks').get(task.id);
  const job = await tx.objectStore('jobs').get(task.jobId);
  if (!current || current.state !== 'running' || current.lease !== task.lease || job?.status !== 'active') { await tx.done; return false; }
  for (const artifact of result.artifacts ?? []) await tx.objectStore('artifacts').put(artifact);
  for (const child of result.children ?? []) {
    if (!await tx.objectStore('tasks').get(child.id)) await tx.objectStore('tasks').put(child);
  }
  if (result.course) { job.course = result.course; await tx.objectStore('jobs').put(job); }
  current.state = result.skip ? 'skipped' : 'succeeded'; current.error = result.skip;
  delete current.lease; delete current.leaseUntil;
  await tx.objectStore('tasks').put(current); await tx.done; return true;
}
export async function fail(task: Task, update: Partial<Task>, pause?: Job['status']): Promise<void> {
  const database = await db(), tx = database.transaction(['jobs', 'tasks'], 'readwrite');
  const current = await tx.objectStore('tasks').get(task.id), job = await tx.objectStore('jobs').get(task.jobId);
  if (current?.state === 'running' && current.lease === task.lease && job?.status === 'active') {
    Object.assign(current, update); delete current.lease; delete current.leaseUntil;
    await tx.objectStore('tasks').put(current);
    if (pause) { job.status = pause; await tx.objectStore('jobs').put(job); }
  }
  await tx.done;
}
export async function control(jobId: string, action: 'pause' | 'resume' | 'cancel' | 'retry'): Promise<void> {
  const database = await db(), tx = database.transaction(['jobs', 'tasks'], 'readwrite');
  const job = await tx.objectStore('jobs').get(jobId);
  if (!job) throw new Error('任务不存在。');
  if (action === 'resume' && (job.status === 'cancelled' || job.status === 'complete')) { await tx.done; return; }
  job.status = action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'active';
  const tasks = await tx.objectStore('tasks').index('jobId').getAll(jobId);
  const retryCollection = action === 'retry' && tasks.some(t => t.kind !== 'drive' && ['failed','blocked_auth','cancelled'].includes(t.state));
  for (const task of tasks) {
    if (retryCollection && job.options.autoSync && task.kind === 'drive') { task.state = 'pending'; task.attempts = 0; task.nextAt = 0; }
    if (action === 'cancel' && !['succeeded', 'skipped', 'failed'].includes(task.state)) task.state = 'cancelled';
    else if (action === 'pause' && task.state === 'running') task.state = 'pending';
    else if ((action === 'retry' && ['failed', 'blocked_auth', 'cancelled'].includes(task.state)) || (action === 'resume' && task.state === 'blocked_auth')) {
      task.state = 'pending'; task.attempts = 0; task.nextAt = 0; delete task.error; delete task.code;
    }
    if (task.state !== 'running') { delete task.lease; delete task.leaseUntil; }
    await tx.objectStore('tasks').put(task);
  }
  await tx.objectStore('jobs').put(job); await tx.done;
}
export async function reconcile(): Promise<void> {
  const database = await db(), tx = database.transaction(['jobs', 'tasks'], 'readwrite');
  for (const job of await tx.objectStore('jobs').getAll()) {
    if (job.status !== 'active') continue;
    const tasks = await tx.objectStore('tasks').index('jobId').getAll(job.id);
    const collection = tasks.filter(t => t.kind !== 'drive');
    const terminal = (t: Task) => ['succeeded', 'skipped', 'failed', 'cancelled'].includes(t.state);
    if (collection.length && collection.every(terminal)) {
      if (job.options.autoSync && job.course && !tasks.some(t => t.kind === 'drive')) {
        await tx.objectStore('tasks').put(newTask(job.id, 'drive', 'drive'));
      } else if (tasks.every(terminal)) {
        job.status = 'complete'; await tx.objectStore('jobs').put(job);
      }
    }
  }
  await tx.done;
}
export async function snapshot(jobId?: string) {
  const database = await db();
  const jobs = (await database.getAll('jobs')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const job = jobId ? jobs.find(j => j.id === jobId) : jobs[0];
  return { jobs, job, tasks: job ? await database.getAllFromIndex('tasks', 'jobId', job.id) : [],
    artifactCount: job ? await database.countFromIndex('artifacts', 'jobId', job.id) : 0 };
}
export async function removeJob(jobId: string): Promise<void> {
  const database = await db(), tx = database.transaction(['jobs', 'tasks', 'artifacts'], 'readwrite');
  for (const store of ['tasks', 'artifacts'] as const) {
    for (const key of await tx.objectStore(store).index('jobId').getAllKeys(jobId)) await tx.objectStore(store).delete(key);
  }
  await tx.objectStore('jobs').delete(jobId); await tx.done;
}
