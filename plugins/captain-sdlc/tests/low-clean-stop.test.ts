import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyLowStrictCompletion } from "../scripts/governed-repository.mjs";

test("LOW turn completion does not require uncommitted junk after a clean commit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "captain-low-clean-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, windowsHide: true });
  git("init"); await writeFile(path.join(root, "work.md"), "Delivered work\n");
  git("add", "work.md"); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "work");
  assert.equal((await verifyLowStrictCompletion(root)).ok, true);
  await writeFile(path.join(root, "work.md"), "Delivered work\nBad whitespace   \n");
  assert.equal((await verifyLowStrictCompletion(root)).ok, false, "whitespace validation still applies");
});
