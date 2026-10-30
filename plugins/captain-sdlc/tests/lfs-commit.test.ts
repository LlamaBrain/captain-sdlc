import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { commitAtomic, sourceState } from "../src/workspace.js";

const exec = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, env, windowsHide: true })).stdout.trim();

test("Captain commits a changed LFS asset as a pointer without executing local LFS drivers", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "captain-lfs-commit-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("captain-lfs-commit-"));
    await rm(root, { recursive: true, force: true });
  });
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Captain Test");
  await git(root, "config", "user.email", "captain@example.invalid");
  await git(root, "config", "core.autocrlf", "false");
  await git(root, "lfs", "install", "--local");
  await writeFile(path.join(root, ".gitattributes"), "*.uasset filter=lfs diff=lfs merge=lfs -text\n");
  await writeFile(path.join(root, "VERSION"), "1.0.0\n");
  await writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n");
  await writeFile(path.join(root, "fixture.uasset"), Buffer.from("original asset data"));
  await git(root, "add", ".");
  await git(root, "commit", "-m", "fixture");
  await git(root, "config", "filter.lfs.process", "echo EXECUTED > hostile-marker; exit 1");
  const bytes = Buffer.from("updated game asset\0data", "utf8");
  await writeFile(path.join(root, "fixture.uasset"), bytes);
  await writeFile(path.join(root, "VERSION"), "1.0.1\n");
  await writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n- Update asset (v1.0.1)\n");

  await commitAtomic(root, ["fixture.uasset", "VERSION", "CHANGELOG.md"], "fix(asset): update fixture (v1.0.1)");
  const pointer = await git(root, "show", "HEAD:fixture.uasset");
  assert.match(pointer, new RegExp(`oid sha256:${createHash("sha256").update(bytes).digest("hex")}`));
  assert.match(pointer, new RegExp(`size ${bytes.length}(?:\\n|$)`));
  assert.deepEqual(await readFile(path.join(root, "fixture.uasset")), bytes);
  assert.equal((await sourceState(root)).status, "");
  await assert.rejects(access(path.join(root, "hostile-marker")), { code: "ENOENT" });
});
