import type { Snapshot } from '../shared/types';

const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
let jobId = '',
  busy = false,
  refreshSequence = 0;
async function send<T = unknown>(
  type: string,
  values: Record<string, unknown> = {},
): Promise<T> {
  const result:
    | { ok: true; data: T }
    | { ok: false; error: string }
    | undefined = await chrome.runtime.sendMessage({
    target: 'worker',
    type,
    ...values,
  });
  if (!result?.ok)
    throw new Error(
      result?.error ?? 'The worker is unavailable. Reopen the extension.',
    );
  return result.data;
}
function notice(text: string): void {
  el('notice').textContent = text;
  el('notice').classList.toggle('hidden', !text);
}
async function action(work: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    notice('');
    await work();
    await refresh();
  } catch (e) {
    notice(e instanceof Error ? e.message : 'Operation failed');
  } finally {
    busy = false;
  }
}
const states: Record<string, string> = {
  active: 'Collecting',
  paused: 'Paused',
  complete: 'Complete',
  blocked_auth: 'Sign-in / authorization required',
  cancelled: 'Cancelled',
};
async function refresh(): Promise<void> {
  const sequence = ++refreshSequence;
  const state: Snapshot = await send<Snapshot>('STATE', {
    jobId: jobId || undefined,
  });
  if (sequence !== refreshSequence) return;
  jobId = state.job?.id ?? '';
  const select = el<HTMLSelectElement>('jobs');
  select.replaceChildren(
    ...(state.jobs.length
      ? state.jobs.map(
          (j) =>
            new Option(
              `${j.course?.title ?? j.slug} · ${new Date(j.createdAt).toLocaleString()}`,
              j.id,
            ),
        )
      : [new Option('No jobs', '')]),
  );
  select.value = jobId;
  const tasks = state.tasks,
    done = tasks.filter((t) =>
      ['succeeded', 'skipped', 'failed', 'cancelled'].includes(t.state),
    ).length;
  const failures = tasks.filter((t) => t.state === 'failed').length,
    skips = tasks.filter((t) => t.state === 'skipped').length;
  el('job-status').textContent = state.job
    ? `${states[state.job.status]}${failures || skips ? ' · Has missing items' : ''}`
    : 'Waiting to start';
  el<HTMLProgressElement>('progress').max = Math.max(1, tasks.length);
  el<HTMLProgressElement>('progress').value = done;
  el('counts').textContent = tasks.length
    ? `${done}/${tasks.length} steps · ${state.artifactCount} text artifacts · ${skips} skipped · ${failures} failed`
    : 'The worker continues after this popup closes.';
  const issues = tasks
    .filter((t) => t.error || t.state === 'blocked_auth')
    .map(
      (t) =>
        `${t.item?.title ?? t.kind}${t.language ? ` (${t.language})` : ''}：${t.error ?? t.state}${t.code ? ` [${t.code}]` : ''}`,
    );
  issues.push(
    ...tasks
      .filter((t) => t.file?.warning)
      .map((t) => `${t.item?.title}: ${t.file?.warning}`),
  );
  issues.push(...(state.job?.course?.warnings ?? []));
  const videos = tasks.filter((t) => t.kind === 'video');
  const bytes = videos.reduce(
    (sum, t) => sum + (t.file?.bytesReceived ?? 0),
    0,
  );
  el('video-status').textContent = videos.length
    ? `Videos ${videos.filter((t) => t.state === 'succeeded').length}/${videos.length} complete · ${(bytes / 1024 / 1024).toFixed(1)} MiB · cap ${state.job?.options.videoResolution ?? '360p'} / ${(state.job?.options.videoFormat ?? 'mp4').toUpperCase()} · folder ${state.job?.slug}-${state.job?.id.slice(0, 8)}`
    : '';
  el('issues').replaceChildren(
    ...(issues.length ? issues : ['No issues.']).map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );
  for (const id of [
    'pause',
    'resume',
    'retry',
    'cancel',
    'export',
    'sync',
    'delete',
  ])
    el<HTMLButtonElement>(id).disabled = !jobId;
  el<HTMLButtonElement>('connect').disabled = !state.oauthConfigured;
  el<HTMLButtonElement>('sync').disabled = !jobId || !state.oauthConfigured;
  el<HTMLInputElement>('auto-sync').disabled = !state.oauthConfigured;
  el('drive-status').textContent = state.oauthConfigured
    ? "Authorization is required once; sync updates this course's Markdown export."
    : 'Local export is available. Configure the Drive OAuth Client ID in config.local.json first.';
}
el('videos').addEventListener('change', () => {
  el<HTMLFieldSetElement>('video-options').disabled =
    !el<HTMLInputElement>('videos').checked;
});
el('start-form').addEventListener('submit', (event) => {
  event.preventDefault();
  void action(async () => {
    const result = await send<{ jobId: string }>('START', {
      course: el<HTMLInputElement>('course').value,
      options: {
        language: el<HTMLSelectElement>('language').value,
        allLanguages: el<HTMLInputElement>('all-languages').checked,
        includeReadings: el<HTMLInputElement>('readings').checked,
        autoSync: el<HTMLInputElement>('auto-sync').checked,
        includeVideos: el<HTMLInputElement>('videos').checked,
        videoResolution: el<HTMLSelectElement>('video-resolution').value,
        videoFormat: el<HTMLSelectElement>('video-format').value,
      },
    });
    jobId = result.jobId;
    notice('Job started. You can close this popup.');
  });
});
el('detect').addEventListener('click', () => {
  void action(async () => {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (!tab?.id) throw new Error('No readable tab is available.');
    const response = await chrome.tabs
      .sendMessage(tab.id, { type: 'COURSE_CONTEXT' })
      .catch(() => undefined);
    if (!response?.slug)
      throw new Error(
        'Open and refresh a course page, or paste its URL directly.',
      );
    el<HTMLInputElement>('course').value = response.slug;
  });
});
el('jobs').addEventListener('change', () => {
  jobId = el<HTMLSelectElement>('jobs').value;
  void refresh().catch((e) => notice(e.message));
});
for (const name of ['pause', 'resume', 'retry', 'cancel'])
  el(name).addEventListener('click', () => {
    void action(async () => {
      await send('CONTROL', { jobId, action: name });
    });
  });
el('export').addEventListener('click', () => {
  void action(async () => {
    await send('EXPORT', {
      jobId,
      format: el<HTMLSelectElement>('format').value,
    });
    notice('Local download started.');
  });
});
el('connect').addEventListener('click', () => {
  void action(async () => {
    await send('CONNECT');
    notice('Google Drive connected. You can sync now.');
  });
});
el('sync').addEventListener('click', () => {
  void action(async () => {
    await send('SYNC', { jobId });
    notice('Sync job added to the queue.');
  });
});
el('delete').addEventListener('click', () => {
  if (
    confirm(
      'Delete this job and its local text? Exported and Drive files will remain.',
    )
  )
    void action(async () => {
      await send('DELETE', { jobId });
      jobId = '';
    });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.summary)
    void refresh().catch((e) => notice(e.message));
  if (area === 'local' && changes.workerError?.newValue)
    notice(String(changes.workerError.newValue));
});
void (async () => {
  const stored = await chrome.storage.local.get('settings');
  const settings = stored.settings as
    | (import('../shared/types').Options & { course?: string })
    | undefined;
  el<HTMLInputElement>('course').value =
    settings?.course ?? 'packt-scalable-node-js-advanced-patterns-integration';
  if (settings) {
    el<HTMLSelectElement>('language').value = settings.language ?? 'en';
    el<HTMLInputElement>('all-languages').checked = !!settings.allLanguages;
    el<HTMLInputElement>('readings').checked =
      settings.includeReadings !== false;
    el<HTMLInputElement>('auto-sync').checked = !!settings.autoSync;
  }
  el<HTMLInputElement>('videos').checked = settings?.includeVideos === true;
  el<HTMLSelectElement>('video-resolution').value =
    settings?.videoResolution ?? '360p';
  el<HTMLSelectElement>('video-format').value = settings?.videoFormat ?? 'mp4';
  el<HTMLFieldSetElement>('video-options').disabled =
    !el<HTMLInputElement>('videos').checked;
  await refresh();
})().catch((e) => notice(e.message));
