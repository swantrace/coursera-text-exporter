import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import {
  vtt as exampleVtt,
  lecture as lectureTemplate,
  reading,
  outline as template,
} from "../tests/fixtures.ts";

const live = process.argv.includes("--live-preview");
const profile = await mkdtemp(join(tmpdir(), "coursera-video-"));
const downloadsDir = join(profile, "downloads");
await mkdir(join(profile, "Default"), { recursive: true });
await mkdir(downloadsDir);
await writeFile(
  join(profile, "Default", "Preferences"),
  JSON.stringify({
    download: {
      default_directory: downloadsDir,
      prompt_for_download: false,
      directory_upgrade: true,
    },
  }),
);
let outline = structuredClone(template),
  lecture = structuredClone(lectureTemplate),
  vtt = exampleVtt;
let server, mediaUrl;
if (live) {
  const courseId = "Gv4-81PiEfGVyAr_4g2xqw",
    itemId = "04z9N";
  const response = await fetch(
    `https://www.coursera.org/api/onDemandLectureVideos.v1/${courseId}~${itemId}?includes=video`,
  );
  assert.equal(response.status, 200);
  lecture = await response.json();
  const url = Object.values(
    lecture.linked["onDemandVideos.v1"][0].subtitlesVtt,
  )[0];
  const subtitle = await fetch(new URL(url, "https://www.coursera.org"));
  assert.equal(subtitle.status, 200);
  vtt = await subtitle.text();
  outline.elements[0].id = courseId;
  outline.elements[0].moduleIds = ["m2"];
  outline.linked["onDemandCourseMaterialLessons.v1"][1].itemIds = [itemId];
  outline.linked["onDemandCourseMaterialItems.v2"] = [
    { id: itemId, name: "Overview", contentSummary: { typeName: "lecture" } },
  ];
} else {
  const payload = Buffer.alloc(32 * 1024, 1);
  server = createServer((_req, res) => {
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": payload.length,
    });
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  mediaUrl = `http://127.0.0.1:${server.address().port}/fixture.mp4`;
  lecture.linked["onDemandVideos.v1"][0].sources = {
    byResolution: {
      "360p": {
        mp4VideoUrl: "https://d3c33hcgiwev3.cloudfront.net/fixture360.mp4",
      },
    },
  };
}
const extension = resolve("dist");
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: true,
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${extension}`,
    `--load-extension=${extension}`,
    "--no-sandbox",
  ],
});
try {
  const worker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  await worker.evaluate(
    ({ outline, lecture, reading, vtt, mediaUrl }) => {
      if (mediaUrl) {
        const nativeDownload = chrome.downloads.download.bind(chrome.downloads);
        // Only transport is redirected in fixture mode; the real Chrome downloader writes the files.
        chrome.downloads.download = (options) =>
          nativeDownload({
            ...options,
            url: options.url.includes("cloudfront.net")
              ? mediaUrl
              : options.url,
          });
      }
      globalThis.fetch = async (input) => {
        const url = String(input);
        if (url.includes("onDemandCourseMaterials"))
          return new Response(JSON.stringify(outline));
        if (url.includes("onDemandLectureVideos"))
          return new Response(JSON.stringify(lecture));
        if (url.includes("onDemandSupplements"))
          return new Response(JSON.stringify(reading));
        if (url.includes("subtitleAssetProxy")) return new Response(vtt);
        throw new Error("Unexpected fetch");
      };
    },
    { outline, lecture, reading, vtt, mediaUrl },
  );
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Browser.setDownloadBehavior", {
    behavior: "default",
    eventsEnabled: true,
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`chrome-extension://${id}/popup/popup.html`);
  assert.equal(await page.locator("#video-resolution").inputValue(), "360p");
  assert.equal(await page.locator("#video-format").inputValue(), "mp4");
  await page
    .locator("#course")
    .fill(
      live
        ? "packt-scalable-node-js-advanced-patterns-integration"
        : "video-test",
    );
  await page.locator("#videos").check();
  await page.locator("#start").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#job-status")?.textContent?.includes("已完成"),
    {},
    { timeout: 60000 },
  );
  const state = await page.evaluate(
    async () =>
      (await chrome.runtime.sendMessage({ target: "worker", type: "STATE" }))
        .data,
  );
  assert.deepEqual(
    state.tasks
      .filter((t) => t.state === "failed")
      .map((t) => ({ kind: t.kind, error: t.error })),
    [],
  );
  const video = state.tasks.find((t) => t.kind === "video"),
    sidecars = state.tasks.filter((t) => t.kind === "sidecar");
  assert.equal(video.state, "succeeded");
  assert.equal(video.file.resolution, "360p");
  assert.equal(sidecars.length, 2);
  const records = await worker.evaluate(async () =>
    chrome.downloads.search({}),
  );
  const videoRecord = records.find((d) => d.id === video.file.downloadId);
  const stem = basename(videoRecord.filename, ".mp4");
  const files = [];
  for (const task of [video, ...sidecars]) {
    const record = records.find((d) => d.id === task.file.downloadId);
    assert.equal(record.state, "complete");
    assert.equal(dirname(record.filename), dirname(videoRecord.filename));
    const bytes = await readFile(record.filename);
    assert.ok(bytes.length > 0);
    if (task.kind === "sidecar") {
      assert.equal(
        basename(record.filename),
        `${stem}.en.${task.sidecarFormat}`,
      );
      if (task.sidecarFormat === "srt") assert.match(bytes.toString(), /--> /);
    }
    files.push({ name: basename(record.filename), bytes: bytes.length });
  }
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(`chrome-extension://${id}/popup/popup.html`);
  await reopened.waitForFunction(() =>
    document.querySelector("#job-status")?.textContent?.includes("已完成"),
  );
  assert.equal(await reopened.locator("#videos").isChecked(), true);
  await mkdir(".local", { recursive: true });
  await reopened.screenshot({ path: ".local/video-smoke.png", fullPage: true });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        result: "PASS",
        mode: live
          ? "live public preview"
          : "fixture with real native downloads",
        resolution: video.file.resolution,
        format: video.file.format,
        files,
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
