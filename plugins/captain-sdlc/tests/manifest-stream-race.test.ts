import assert from "node:assert/strict";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const originalStream = fs.createReadStream;
let changeEarlierInput: (() => void) | undefined;
fs.createReadStream = function(file: any, options?: any) {
  if (changeEarlierInput && path.basename(String(file)) === "zz.txt") {
    const action = changeEarlierInput; changeEarlierInput = undefined; action();
  }
  return originalStream(file, options);
} as typeof fs.createReadStream;
syncBuiltinESMExports();
const { sourceManifestExcludingJournal } = await import("../src/workspace.js");
const exec = promisify(execFile);

test("journal input snapshot rejects an earlier file changed during the walk", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "captain-manifest-race-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("captain-manifest-race-"));
    await rm(root, { recursive: true, force: true });
  });
  const git = async (...args: string[]) => exec("git", args, { cwd: root, windowsHide: true });
  await git("init"); await git("config", "user.name", "Captain Test"); await git("config", "user.email", "captain@example.invalid");
  await writeFile(path.join(root, ".gitignore"), "aa_ignored.txt\n");
  const earlier = path.join(root, "aa_ignored.txt");
  await writeFile(earlier, "signed original\n");
  await writeFile(path.join(root, "zz.txt"), "later file\n");
  await git("add", ".gitignore", "zz.txt"); await git("commit", "-m", "fixture");
  const policy = { profile: "low" as const, visualRequired: false, commands: {} };
  changeEarlierInput = () => fs.writeFileSync(earlier, "foreign changed\n");
  await assert.rejects(() => sourceManifestExcludingJournal(root, policy, []), /changed|snapshot|manifest/i);
  assert.equal(await readFile(earlier, "utf8"), "foreign changed\n");
});
