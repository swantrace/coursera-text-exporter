import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { lecture, outline, reading, vtt } from '../tests/fixtures.ts';

const profile = await mkdtemp(join(tmpdir(), 'coursera-extension-'));
const extension = resolve('dist');
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium',
  headless: true,
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    '--no-sandbox',
  ],
});
try {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker'));
  const id = new URL(worker.url()).host;
  await worker.evaluate(
    ({ outline, lecture, reading, vtt }) => {
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.includes('onDemandCourseMaterials'))
          return new Response(JSON.stringify(outline), {
            headers: { 'Content-Type': 'application/json' },
          });
        if (url.includes('onDemandLectureVideos'))
          return new Response(JSON.stringify(lecture), {
            headers: { 'Content-Type': 'application/json' },
          });
        if (url.includes('onDemandSupplements'))
          return new Response(JSON.stringify(reading), {
            headers: { 'Content-Type': 'application/json' },
          });
        if (url.includes('subtitleAssetProxy'))
          return new Response(vtt, { headers: { 'Content-Type': 'text/vtt' } });
        throw new Error(`Unexpected request: ${new URL(url).pathname}`);
      };
    },
    { outline, lecture, reading, vtt },
  );
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${id}/popup/popup.html`);
  await page.locator('#course').fill('test-course');
  await page.locator('#start').click();
  await page.waitForFunction(
    () =>
      document.querySelector('#job-status')?.textContent?.includes('Complete'),
    {},
    { timeout: 30000 },
  );
  const state = await page.evaluate(async () => {
    const r = await chrome.runtime.sendMessage({
      target: 'worker',
      type: 'STATE',
    });
    return r.data;
  });
  assert.equal(state.artifactCount, 2);
  assert.equal(state.tasks.filter((t) => t.state === 'failed').length, 0);
  assert.equal(state.tasks.filter((t) => t.state === 'skipped').length, 2);
  // A newly opened UI reads persisted state, independently of the original popup.
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${id}/popup/popup.html`);
  await reopened.waitForFunction(() =>
    document.querySelector('#job-status')?.textContent?.includes('Complete'),
  );
  // Exercise real offscreen message validation and Blob generation without OS save dialogs.
  const exportResult = await worker.evaluate(async (jobId) => {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Verify local export',
    });
    return chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'BUNDLE',
      jobId,
      format: 'zip',
    });
  }, state.job.id);
  assert.equal(
    exportResult.ok,
    true,
    exportResult.error ?? 'Offscreen did not respond',
  );
  assert.match(exportResult.url, /^blob:chrome-extension:/);
  const byteLength = await reopened.evaluate(
    async (url) => (await (await fetch(url)).arrayBuffer()).byteLength,
    exportResult.url,
  );
  assert.ok(byteLength > 100);
  const released = await worker.evaluate(async (url) => {
    const result = await chrome.runtime.sendMessage({
      target: 'offscreen',
      type: 'REVOKE',
      url,
    });
    if (result.empty) await chrome.offscreen.closeDocument();
    return result;
  }, exportResult.url);
  assert.equal(released.empty, true);
  await mkdir('.local', { recursive: true });
  await reopened.screenshot({ path: '.local/popup-smoke.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        extensionId: id,
        artifacts: state.artifactCount,
        tasks: state.tasks.length,
        zipBytes: byteLength,
        popupReopen: 'PASS',
        offscreen: 'PASS',
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}
