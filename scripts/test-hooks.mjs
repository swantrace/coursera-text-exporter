import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(".");
const directory = await mkdtemp(join(tmpdir(), "coursera-hooks-"));
function run(command, args, expectSuccess = true) {
  const result = spawnSync(command, args, {
    cwd: directory,
    encoding: "utf8",
    env: {
      ...process.env,
      HUSKY: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
  if (expectSuccess && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result;
}
const git = (...args) => run("git", args).stdout.trim();
try {
  await mkdir(join(directory, ".husky"));
  for (const path of ["package.json", "biome.json", ".husky/pre-commit"]) {
    await cp(join(root, path), join(directory, path));
  }
  await writeFile(join(directory, ".gitignore"), "node_modules\n");
  await symlink(
    join(root, "node_modules"),
    join(directory, "node_modules"),
    "dir",
  );
  const fixture = join(directory, "fixture.ts");
  await writeFile(fixture, "export const answer = 1;\n");
  git("init", "-b", "main");
  git("config", "user.name", "Hook Test");
  git("config", "user.email", "hook-test@example.invalid");
  git(
    "add",
    "package.json",
    "biome.json",
    ".gitignore",
    ".husky/pre-commit",
    "fixture.ts",
  );
  git("commit", "-m", "test baseline");
  run("npm", ["run", "prepare"]);
  assert.equal(git("config", "--get", "core.hooksPath"), ".husky/_");

  await writeFile(fixture, "export const answer=2\n");
  git("add", "fixture.ts");
  const success = run("git", ["commit", "-m", "format staged source"]);
  assert.match(success.stdout + success.stderr, /check:write/);
  assert.equal(git("show", "HEAD:fixture.ts"), "export const answer = 2;");
  assert.equal(git("status", "--porcelain"), "");

  // A valid working copy must not hide a broken version in the index.
  const before = git("rev-parse", "HEAD");
  await writeFile(fixture, "export const broken = ;\n");
  git("add", "fixture.ts");
  const staged = git("show", ":fixture.ts");
  const working = "export const answer = 99;\n";
  await writeFile(fixture, working);
  const rejected = run("git", ["commit", "-m", "must be rejected"], false);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout + rejected.stderr, /check:write/);
  assert.equal(git("rev-parse", "HEAD"), before);
  assert.equal(git("show", ":fixture.ts"), staged);
  assert.equal(await readFile(fixture, "utf8"), working);

  // Warning-only diagnostics must also block commits.
  await writeFile(fixture, "export const unsafe: any = 1;\n");
  git("add", "fixture.ts");
  const warning = run("git", ["commit", "-m", "reject warning"], false);
  assert.notEqual(warning.status, 0);
  assert.match(warning.stdout + warning.stderr, /noExplicitAny/);
  assert.equal(git("rev-parse", "HEAD"), before);
  assert.equal(git("show", ":fixture.ts"), "export const unsafe: any = 1;");

  // Auto-format staged code while preserving a separate unstaged edit.
  const partial =
    "export const answer=3\n// context one\n// context two\n// context three\n// context four\n";
  await writeFile(fixture, partial);
  git("add", "fixture.ts");
  await writeFile(fixture, `${partial}// unstaged-only\n`);
  git("commit", "-m", "preserve partial staging");
  const committed = git("show", "HEAD:fixture.ts");
  assert.match(committed, /answer = 3;/);
  assert.doesNotMatch(committed, /unstaged-only/);
  assert.match(await readFile(fixture, "utf8"), /unstaged-only/);
  assert.equal(git("stash", "list"), "");
  console.log(
    "PASS: hook installation, staged auto-fix, error and warning rejection, partial staging preservation",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
