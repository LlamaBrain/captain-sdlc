import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { populateLfsWorktree } from "../src/git-lfs-checkout.js";
import type { GitReader } from "../src/git-safe-status.js";

const exec = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1" };
for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/i.test(key)) delete env[key];
const git: GitReader = async (args, cwd) => (await exec("git", ["-c", "core.fsmonitor=false", ...args], { cwd, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const original = Buffer.from(Array.from({ length: 1024 }, (_, i) => (i * 31 + 17) % 256));

async function fixture(t: TestContext, symlinkEntry = false, attributes = "*.uasset filter=lfs diff=lfs merge=lfs -text\n", executable = false) {
  const root = await mkdtemp(path.join(tmpdir(), "captain-lfs-checkout-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("captain-lfs-checkout-"));
    await rm(root, { recursive: true, force: true });
  });
  const source = path.join(root, "source"), target = path.join(root, "linked"), marker = path.join(root, "executed.txt");
  await mkdir(source);
  await git(["init", "-b", "main"], source);
  await git(["config", "user.name", "Captain Test"], source);
  await git(["config", "user.email", "captain@example.invalid"], source);
  await git(["config", "core.autocrlf", "false"], source);
  await git(["lfs", "install", "--local"], source);
  await writeFile(path.join(source, ".gitattributes"), attributes);
  await writeFile(path.join(source, "fixture.uasset"), original);
  if (executable) await chmod(path.join(source, "fixture.uasset"), 0o755);
  await writeFile(path.join(source, "normal.txt"), "ordinary content\n");
  await git(["add", "."], source);
  if (symlinkEntry) {
    const linkText = path.join(root, "link-target.txt");
    await writeFile(linkText, "../outside\n");
    const object = await git(["hash-object", "-w", linkText], source);
    await git(["update-index", "--add", "--cacheinfo", `120000,${object},unsafe-link`], source);
  }
  await git(["commit", "-m", "fixture baseline"], source);
  const head = await git(["rev-parse", "HEAD"], source);
  await git(["worktree", "add", "--no-checkout", "-b", "task", target, head], source);
  const command = `node -e "require('node:fs').writeFileSync('${marker.replaceAll("\\", "/")}', 'executed')"`;
  for (const setting of ["filter.lfs.clean", "filter.lfs.smudge", "filter.lfs.process", "merge.lfs.driver"]) await git(["config", "--local", setting, command], source);
  const oid = createHash("sha256").update(original).digest("hex");
  const object = path.join(source, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4), oid);
  return { root, source, target, head, marker, object };
}

test("checkout hydrates a real LFS asset without invoking repository filter commands", async t => {
  const f = await fixture(t);
  await populateLfsWorktree(f.source, f.target, f.head, git);
  assert.deepEqual(await readFile(path.join(f.target, "fixture.uasset")), original);
  assert.equal(await readFile(path.join(f.target, "normal.txt"), "utf8"), "ordinary content\n");
  assert.match(await git(["ls-files", "--stage", "--", "fixture.uasset"], f.target), /^100644 [a-f0-9]+ 0\s+fixture\.uasset$/);
  await assert.rejects(access(f.marker), { code: "ENOENT" });
});

test("checkout preserves executable mode while hydrating an LFS asset", { skip: process.platform === "win32" }, async t => {
  const f = await fixture(t, false, undefined, true);
  await populateLfsWorktree(f.source, f.target, f.head, git);
  const info = await lstat(path.join(f.target, "fixture.uasset"));
  assert.notEqual(info.mode & 0o100, 0);
  assert.match(await git(["ls-files", "--stage", "--", "fixture.uasset"], f.target), /^100755 /);
  assert.deepEqual(await readFile(path.join(f.target, "fixture.uasset")), original);
  await assert.rejects(access(f.marker), { code: "ENOENT" });
});

test("checkout preserves ordinary text attributes while LFS pointer bytes remain unconverted", async t => {
  const f = await fixture(t, false, "*.uasset filter=lfs diff=lfs merge=lfs text eol=crlf\n*.txt text eol=crlf\n");
  await populateLfsWorktree(f.source, f.target, f.head, git);
  assert.deepEqual(await readFile(path.join(f.target, "fixture.uasset")), original);
  assert.deepEqual(await readFile(path.join(f.target, "normal.txt")), Buffer.from("ordinary content\r\n"));
  await assert.rejects(access(f.marker), { code: "ENOENT" });
});

for (const condition of ["missing", "corrupt"] as const) test(`checkout refuses a ${condition} local LFS object before populating files`, async t => {
  const f = await fixture(t);
  if (condition === "missing") await unlink(f.object);
  else await writeFile(f.object, Buffer.alloc(original.length, 0x5a));
  await assert.rejects(populateLfsWorktree(f.source, f.target, f.head, git), /lfs|object|integrity|digest|hash|missing/i);
  await assert.rejects(access(path.join(f.target, "fixture.uasset")), { code: "ENOENT" });
  await assert.rejects(access(f.marker), { code: "ENOENT" });
});

test("checkout preserves unexpected pre-existing files instead of overwriting them", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.target, "normal.txt"), "user file\n");
  await assert.rejects(populateLfsWorktree(f.source, f.target, f.head, git), /empty|existing|unexpected|occupied/i);
  assert.equal(await readFile(path.join(f.target, "normal.txt"), "utf8"), "user file\n");
  await assert.rejects(access(f.marker), { code: "ENOENT" });
});

test("checkout rejects an index changed after reading the pinned tree before writing files", async t => {
  const f = await fixture(t);
  const changingGit: GitReader = async (args, cwd) => {
    const result = await git(args, cwd);
    if (args[0] === "read-tree") await git(["update-index", "--force-remove", "normal.txt"], cwd);
    return result;
  };
  await assert.rejects(populateLfsWorktree(f.source, f.target, f.head, changingGit), /index|tree|diverged/i);
  await assert.rejects(access(path.join(f.target, ".gitattributes")), { code: "ENOENT" });
  await assert.rejects(access(path.join(f.target, "fixture.uasset")), { code: "ENOENT" });
  await assert.rejects(access(f.marker), { code: "ENOENT" });
});

test("checkout fails closed on a configured non-default LFS storage location", async t => {
  const f = await fixture(t);
  await git(["config", "--local", "lfs.storage", path.join(f.root, "other-lfs")], f.source);
  await assert.rejects(populateLfsWorktree(f.source, f.target, f.head, git), /lfs\.storage|lfs storage/i);
  await assert.rejects(access(path.join(f.target, "fixture.uasset")), { code: "ENOENT" });
  await assert.rejects(access(f.marker), { code: "ENOENT" });
});

test("checkout rejects LFS storage configured only for the target worktree", async t => {
  const f = await fixture(t);
  await git(["config", "--local", "extensions.worktreeConfig", "true"], f.source);
  await git(["config", "--worktree", "lfs.storage", path.join(f.root, "other-lfs")], f.target);
  await assert.rejects(populateLfsWorktree(f.source, f.target, f.head, git), /lfs\.storage|lfs storage/i);
  await assert.rejects(access(path.join(f.target, "fixture.uasset")), { code: "ENOENT" });
  await assert.rejects(access(f.marker), { code: "ENOENT" });
});

test("checkout rejects a committed symlink without creating it", async t => {
  const f = await fixture(t, true);
  await assert.rejects(populateLfsWorktree(f.source, f.target, f.head, git), /symlink|reparse|mode|unsupported/i);
  await assert.rejects(lstat(path.join(f.target, "unsafe-link")), { code: "ENOENT" });
  await assert.rejects(access(f.marker), { code: "ENOENT" });
});
