import { required } from "./helpers";
import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseCourse } from "../src/parsers/course";
import { createJob, db } from "../src/storage/database";
import { googleRequest, syncJob } from "../src/sync/drive";
import { outline } from "./fixtures";

let uploads = 0,
  idCounter = 0,
  committed = 0,
  total = 0;
let remote = new Map<
  string,
  { id: string; appProperties?: Record<string, string> }
>();
let dropResponse = false,
  _resumable = false;
const response = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) => new Response(JSON.stringify(data), { status, headers });
beforeEach(async () => {
  uploads = 0;
  idCounter = 0;
  committed = 0;
  total = 0;
  remote = new Map();
  dropResponse = false;
  _resumable = false;
  const database = await db();
  for (const store of ["jobs", "tasks", "artifacts", "sync"] as const)
    await database.clear(store);
  await createJob({
    id: "job",
    slug: "test",
    createdAt: "2026-09-09",
    status: "complete",
    options: {
      language: "en",
      allLanguages: false,
      includeReadings: true,
      autoSync: false,
    },
    course: parseCourse(outline, "test"),
  });
  vi.stubGlobal("chrome", {
    runtime: { getManifest: () => ({ oauth2: { client_id: "test" } }) },
    identity: {
      getAuthToken: vi.fn(async () => ({ token: "access-token" })),
      removeCachedAuthToken: vi.fn(async () => {}),
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input),
        method = init.method ?? "GET";
      if (url.pathname.endsWith("/about"))
        return response({ user: { permissionId: "account-1" } });
      if (url.pathname.endsWith("/generateIds"))
        return response({ ids: [`file-${++idCounter}`] });
      if (url.pathname === "/resumable/session") {
        const range = required(new Headers(init.headers).get("Content-Range"));
        if (range.startsWith("bytes */"))
          return new Response(null, {
            status: 308,
            headers: committed ? { Range: `bytes=0-${committed - 1}` } : {},
          });
        const match = required(range.match(/bytes (\d+)-(\d+)\/(\d+)/));
        expect(Number(match[1])).toBe(committed);
        total = Number(match[3]);
        committed = Number(match[2]) + 1;
        return committed === total
          ? response({ id: "file-1" })
          : new Response(null, {
              status: 308,
              headers: { Range: `bytes=0-${committed - 1}` },
            });
      }
      if (url.pathname.startsWith("/upload/")) {
        uploads++;
        if (url.searchParams.get("uploadType") === "resumable")
          return response({}, 200, {
            Location: "https://www.googleapis.com/resumable/session",
          });
        const text = await (init.body as Blob).text();
        const metadata = JSON.parse(
          text.split("\r\n\r\n")[1].split("\r\n--")[0],
        );
        const fileId = metadata.id ?? url.pathname.split("/").at(-1);
        remote.set(fileId, {
          id: fileId,
          appProperties: metadata.appProperties,
        });
        if (dropResponse) {
          dropResponse = false;
          throw new TypeError("connection lost after commit");
        }
        return response({ id: fileId });
      }
      if (url.pathname.endsWith("/files") && method === "POST") {
        const body = JSON.parse(String(init.body));
        remote.set(body.id, body);
        return response(body);
      }
      const id = required(url.pathname.split("/").at(-1));
      return remote.has(id) ? response(remote.get(id)) : response({}, 404);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
it("refreshes a rejected Google token once and does not leak it to other origins", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(response({}, 401))
      .mockResolvedValueOnce(response({ ok: true })),
  );
  expect(
    (
      await googleRequest(
        "https://www.googleapis.com/drive/v3/files",
        {},
        new AbortController().signal,
      )
    ).ok,
  ).toBe(true);
  expect(chrome.identity.removeCachedAuthToken).toHaveBeenCalledWith({
    token: "access-token",
  });
  await expect(
    googleRequest("https://evil.test/", {}, new AbortController().signal),
  ).rejects.toThrow(/非 Google/);
});
it("does not create a duplicate after a successful upload response is lost", async () => {
  dropResponse = true;
  await expect(syncJob("job", new AbortController().signal)).rejects.toThrow(
    /失败或超时/,
  );
  expect(uploads).toBe(1);
  await syncJob("job", new AbortController().signal);
  expect(uploads).toBe(1);
  expect([...remote.values()].filter((v) => v.appProperties)).toHaveLength(1);
});
it("updates changed content on the same file ID", async () => {
  await syncJob("job", new AbortController().signal);
  const database = await db();
  await database.put("artifacts", {
    id: "a",
    jobId: "job",
    itemId: "v1",
    title: "Changed",
    kind: "subtitle",
    raw: "",
    rawFormat: "vtt",
    text: "Changed",
    markdown: "Changed",
    source: "https://www.coursera.org/learn/test",
    warnings: [],
  });
  await syncJob("job", new AbortController().signal);
  expect(uploads).toBe(2);
  expect([...remote.values()].filter((v) => v.appProperties)).toHaveLength(1);
});
it("resumes large content in chunks from the server acknowledged byte range", async () => {
  const database = await db();
  const text = "字幕内容".repeat(600000);
  await database.put("artifacts", {
    id: "large",
    jobId: "job",
    itemId: "v1",
    title: "Large",
    kind: "subtitle",
    raw: "",
    rawFormat: "vtt",
    text,
    markdown: text,
    source: "https://www.coursera.org/learn/test",
    warnings: [],
  });
  let completed = false;
  for (let i = 0; i < 12; i++) {
    try {
      await syncJob("job", new AbortController().signal);
      completed = true;
      break;
    } catch (e) {
      expect(e).toMatchObject({ code: "UPLOAD_PROGRESS" });
    }
  }
  expect(completed).toBe(true);
  expect(committed).toBe(total);
  expect(total).toBeGreaterThan(5 * 1024 * 1024);
  expect(uploads).toBe(1);
  const entries = await database.getAll("sync");
  expect(entries.find((e) => e.hash)?.session).toBeUndefined();
});
it("creates a new ID when a previously uploaded file was permanently deleted", async () => {
  await syncJob("job", new AbortController().signal);
  const previous = required(
    [...remote.values()].find((v) => v.appProperties),
  ).id;
  remote.delete(previous);
  await syncJob("job", new AbortController().signal);
  const current = required(
    [...remote.values()].find((v) => v.appProperties),
  ).id;
  expect(current).not.toBe(previous);
  expect(uploads).toBe(2);
});
