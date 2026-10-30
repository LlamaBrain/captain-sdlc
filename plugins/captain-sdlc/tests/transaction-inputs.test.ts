import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import * as workspace from "../src/workspace.js";

const sourceManifestExcludingJournal: (root: string, policy: any, paths: string[]) => Promise<string> =
  (workspace as any).sourceManifestExcludingJournal ?? (async () => { throw new Error("journal input snapshot is not implemented"); });

const exec = promisify(execFile);
const git = async (root: string, ...args: string[]) => exec("git", args, { cwd: root, windowsHide: true });
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "captain-journal-input-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith("captain-journal-input-")); await rm(root, { recursive: true, force: true }); });
  await git(root, "init");
  await git(root, "config", "user.name", "Captain Test");
  await git(root, "config", "user.email", "captain@example.invalid");
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\nTemp/\n");
  await writeFile(path.join(root, "changed.txt"), "old\n");
  await writeFile(path.join(root, "sibling.txt"), "unchanged\n");
  await writeFile(path.join(root, "ignored.txt"), "ignored input\n");
  await mkdir(path.join(root, "Temp"));
  await writeFile(path.join(root, "Temp", "generated.txt"), "build output\n");
  await git(root, "add", ".gitignore", "changed.txt", "sibling.txt");
  await git(root, "commit", "-m", "fixture");
  const policy = { profile: "low" as const, visualRequired: false, commands: {}, sourceManifestExcludes: ["Temp"] };
  return { root, policy };
}

test("journal-excluded paths do not hide sibling or ignored inputs", async t => {
  const { root, policy } = await fixture(t);
  const before = await sourceManifestExcludingJournal(root, policy, ["changed.txt"]);
  await writeFile(path.join(root, "changed.txt"), "journal-owned new bytes\n");
  await writeFile(path.join(root, "Temp", "generated.txt"), "new build output\n");
  assert.equal(await sourceManifestExcludingJournal(root, policy, ["changed.txt"]), before);
  await writeFile(path.join(root, "ignored.txt"), "foreign edit\n");
  assert.notEqual(await sourceManifestExcludingJournal(root, policy, ["changed.txt"]), before);
});

test("a captured journal snapshot revalidates earlier inputs after another tree is read", async t => {
  const { root, policy } = await fixture(t);
  const capture = (workspace as any).captureJournalInputManifest;
  assert.equal(typeof capture, "function");
  const snapshot = await capture(root, policy, ["changed.txt"]);
  assert.match(snapshot.manifest, /^[a-f0-9]{64}$/);
  await writeFile(path.join(root, "ignored.txt"), "changed while checking the other tree\n");
  await assert.rejects(() => snapshot.revalidate(), /changed|snapshot|manifest/i);
});

test("journal input snapshot binds executable-mode changes", { skip: process.platform === "win32" }, async t => {
  const { root, policy } = await fixture(t);
  await chmod(path.join(root, "sibling.txt"), 0o644);
  const before = await sourceManifestExcludingJournal(root, policy, ["changed.txt"]);
  await chmod(path.join(root, "sibling.txt"), 0o755);
  assert.notEqual(await sourceManifestExcludingJournal(root, policy, ["changed.txt"]), before);
});

test("journal exclusions refuse directories, reparse points and escaping paths", async t => {
  const { root, policy } = await fixture(t);
  await mkdir(path.join(root, "folder"));
  await writeFile(path.join(root, "folder", "input.txt"), "data\n");
  await assert.rejects(() => sourceManifestExcludingJournal(root, policy, ["folder"]), /directory|regular file/i);
  await assert.rejects(() => sourceManifestExcludingJournal(root, policy, ["../outside"]), /path|escape/i);
  const link = path.join(root, "journal-link");
  try { await symlink(path.join(root, "folder"), link, process.platform === "win32" ? "junction" : "dir"); }
  catch (error: any) { if (error.code === "EPERM" || error.code === "EACCES") { t.skip("symlink creation unavailable"); return; } throw error; }
  await assert.rejects(() => sourceManifestExcludingJournal(root, policy, ["journal-link"]), /reparse|symlink/i);
});
