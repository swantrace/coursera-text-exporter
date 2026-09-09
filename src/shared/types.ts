export interface Item { id: string; title: string; type: string; locked: boolean }
export interface Lesson { id: string; title: string; items: Item[] }
export interface Module { id: string; title: string; lessons: Lesson[] }
export interface Course { id: string; slug: string; title: string; modules: Module[]; warnings: string[] }
export interface Cue { startMs: number; endMs: number; text: string; speaker?: string }
export interface Artifact {
  id: string; jobId: string; itemId: string; title: string; kind: 'subtitle' | 'reading';
  language?: string; raw: string; rawFormat: 'vtt' | 'html' | 'md' | 'txt';
  text: string; markdown: string; cues?: Cue[]; source: string; warnings: string[];
}
export type TaskState = 'pending' | 'running' | 'retry_wait' | 'blocked_auth' | 'succeeded' | 'skipped' | 'failed' | 'cancelled';
export interface Task {
  id: string; jobId: string; kind: 'outline' | 'lecture' | 'subtitle' | 'reading' | 'drive';
  item?: Item; language?: string; assetKey?: string; state: TaskState; attempts: number;
  nextAt: number; lease?: string; leaseUntil?: number; error?: string; code?: string;
}
export interface Options { language: string; allLanguages: boolean; includeReadings: boolean; autoSync: boolean }
export interface Job {
  id: string; slug: string; createdAt: string; options: Options;
  status: 'active' | 'paused' | 'blocked_auth' | 'complete' | 'cancelled'; course?: Course;
}
export interface SyncRecord {
  key: string; fileId: string; hash?: string; session?: string; sessionHash?: string;
}
export interface TaskResult { course?: Course; artifacts?: Artifact[]; children?: Task[]; skip?: string }
export type ExportFormat = 'md' | 'txt' | 'json' | 'zip';
export interface Snapshot { jobs: Job[]; job?: Job; tasks: Task[]; artifactCount: number; oauthConfigured: boolean }
