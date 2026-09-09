import 'fake-indexeddb/auto';
import { beforeEach, it, expect } from 'vitest';
import { createJob, claim, settle, control, db, newTask, reconcile, snapshot } from '../src/storage/database';
import type { Job } from '../src/shared/types';
const job: Job = { id:'job',slug:'test',createdAt:'2026-09-09',status:'active',options:{language:'en',allLanguages:false,includeReadings:true,autoSync:false} };
beforeEach(async()=> { const database=await db(); for(const store of ['jobs','tasks','artifacts','sync'] as const) await database.clear(store); await createJob(structuredClone(job)); });
it('claims a task only once under concurrent dispatch',async()=>{
 const result=await Promise.all([claim(),claim(),claim()]); expect(result.filter(Boolean)).toHaveLength(1);
});
it('reclaims an expired lease and rejects a stale result',async()=>{
 const old=(await claim(100))!; const renewed=(await claim(100000))!;
 expect(renewed.lease).not.toBe(old.lease);
 expect(await settle(old,{})).toBe(false); expect(await settle(renewed,{})).toBe(true);
});
it('pause fences in-flight results, resume retries, cancel fences again',async()=>{
 const first=(await claim())!; await control(job.id,'pause'); expect(await settle(first,{})).toBe(false); expect(await claim()).toBeUndefined();
 await control(job.id,'resume'); const next=(await claim())!; await control(job.id,'cancel'); expect(await settle(next,{})).toBe(false);
 expect((await snapshot()).job?.status).toBe('cancelled');
});
it('commits follow-up tasks atomically and does not duplicate them',async()=>{
 const parent=(await claim())!; await settle(parent,{children:[newTask(job.id,'video','lecture')]});
 expect((await snapshot()).tasks).toHaveLength(2); expect(await settle(parent,{children:[newTask(job.id,'other','reading')]})).toBe(false);
});
it('marks terminal jobs complete while preserving failed/skipped outcomes',async()=>{
 const parent=(await claim())!; await settle(parent,{skip:'No content'}); await reconcile(); expect((await snapshot()).job?.status).toBe('complete');
});
it('does not upload until retried collection tasks finish',async()=>{
 const database=await db(); await database.put('tasks',newTask(job.id,'drive','drive'));
 const task=(await claim())!; expect(task.kind).toBe('outline');
 expect(await claim()).toBeUndefined();
 await settle(task,{}); expect((await claim())?.kind).toBe('drive');
});
