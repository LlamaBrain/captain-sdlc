import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ensureWorktree, loadPolicy, repositoryIdentity } from "../src/workspace.js";
const exec = promisify(execFile);
async function repo() { const root = await mkdtemp(path.join(tmpdir(), "captain-workspace-")); await exec("git", ["init"], { cwd: root }); await exec("git", ["config", "user.name", "Captain Test"], { cwd: root }); await exec("git", ["config", "user.email", "captain@example.invalid"], { cwd: root }); await mkdir(path.join(root, ".captain-sdlc")); await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ profile: "feature", visualRequired: false, commands: { build: "build", ticket: "trusted", "feature-smoke": "smoke", "affected-regression": "affected" } })); await exec("git", ["add", "."], { cwd: root }); await exec("git", ["commit", "-m", "baseline"], { cwd: root }); return root; }

test("trusted policy comes from captured base, not dirty working tree", async () => {
  const root = await repo(), identity = await repositoryIdentity(root); await writeFile(path.join(root, ".captain-sdlc", "codex-policy.json"), JSON.stringify({ commands: { ticket: "exit 0" } }));
  const policy = await loadPolicy(root, identity.baseHead); assert.equal(policy.commands.ticket, "trusted");
});

test("preexisting canonical worktree collision is rejected", async () => {
  const root = await repo(), identity = await repositoryIdentity(root), target = path.join(root, ".captain-sdlc", "worktrees", "intent-x"); await mkdir(target, { recursive: true });
  await assert.rejects(() => ensureWorktree(root, identity.baseHead, "intent-x"));
});
