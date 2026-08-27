import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LifecycleStore, type GateRunner, type StateProbe } from "../src/lifecycle.js";

const temp = () => mkdtemp(path.join(tmpdir(), "captain-codex-"));
const runner = (codes: Record<string, number>): GateRunner => async (command) => ({ exitCode: codes[command] ?? 0, stdout: command, stderr: "" });
const policy = { profile: "feature" as const, visualRequired: false, commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "affected", "super-smoke": "super", visual: "visual" }, artifactPaths: { build: "build.zip", smoke: "smoke.json", visual: "proof.png" }, redGate: { expectedExitCodes: [1], outputPattern: "ticket" } };
const probe: StateProbe = async () => ({ head: "b".repeat(40), tree: "c".repeat(40), status: "" });

test("one-time intent starts an owned run and cannot be replayed", async () => {
  const root = await temp(); const data = await temp();
  const store = new LifecycleStore(data, runner({}), probe);
  await store.markIntent({ intentId: "intent-1", sessionId: "s", turnId: "t", projectRoot: root, prompt: "implement x" });
  const run = await store.begin({ intentId: "intent-1", objective: "implement x", projectRoot: root, worktreePath: path.join(root, ".captain-sdlc", "worktrees", "x"), baseHead: "a".repeat(40), policy });
  assert.equal(run.phase, "tdd_red");
  await assert.rejects(() => store.begin({ intentId: "intent-1", objective: "again", projectRoot: root, worktreePath: run.worktreePath, baseHead: run.baseHead, policy }), /consumed/);
});

test("later turns require a fresh one-time resume intent", async () => {
  const root = await temp(), data = await temp(), store = new LifecycleStore(data, runner({}), probe);
  await store.markIntent({ intentId: "start", sessionId: "s", turnId: "t1", projectRoot: root, prompt: "implement x" });
  await store.begin({ intentId: "start", objective: "x", projectRoot: root, worktreePath: path.join(root, ".captain-sdlc", "worktrees", "x"), baseHead: "a".repeat(40), policy });
  await store.markIntent({ intentId: "resume", sessionId: "s", turnId: "t2", projectRoot: root, prompt: "approved", resumeOf: "start" });
  const resumed = await store.resume("resume"); assert.equal(resumed.turnId, "t2"); assert.ok(await store.permitFor("s", "t2"));
  await assert.rejects(() => store.resume("resume"), /consumed/);
});

test("requires a failing ticket test before implementation", async () => {
  const root = await temp(); const data = await temp(); const store = new LifecycleStore(data, runner({ ticket: 0 }), probe);
  await store.markIntent({ intentId: "i", sessionId: "s", turnId: "t", projectRoot: root, prompt: "fix x" });
  await store.begin({ intentId: "i", objective: "fix x", projectRoot: root, worktreePath: path.join(root, ".captain-sdlc", "worktrees", "x"), baseHead: "a".repeat(40), policy });
  await assert.rejects(() => store.recordRed("i", "ticket"), /expected failing test result/);
});

test("feature completion requires green ticket, new smoke, affected regression, build and visual when required", async () => {
  const root = await temp(); const data = await temp();
  const worktree = path.join(root, ".captain-sdlc", "worktrees", "x"); await mkdir(worktree, { recursive: true });
  let ticketRuns = 0;
  const store = new LifecycleStore(data, async (command, cwd) => { if (command === "build") await writeFile(path.join(cwd, "build.zip"), `build-${Date.now()}`); if (command === "smoke") await writeFile(path.join(cwd, "smoke.json"), `{"at":${Date.now()}}`); if (command === "visual") await writeFile(path.join(cwd, "proof.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")); return { exitCode: command === "ticket" && ticketRuns++ === 0 ? 1 : 0, stdout: command, stderr: "" }; }, probe);
  await store.markIntent({ intentId: "i", sessionId: "s", turnId: "t", projectRoot: root, prompt: "implement x" });
  await store.begin({ intentId: "i", objective: "x", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), policy: { ...policy, visualRequired: true } });
  await store.recordRed("i", "ticket");
  await store.recordCommit("i", { head: "b".repeat(40), tree: "c".repeat(40), commitCount: 1, clean: true, subject: "feat(x): ship x (v1.2.0)", versionChanged: true, changelogChanged: true });
  const run = await store.prove("i");
  assert.equal(run.status, "green"); assert.equal(run.phase, "complete");
});

test("pre-release refuses completion without super-smoke", async () => {
  const root = await temp(); const data = await temp(); const worktree = path.join(root, ".captain-sdlc", "worktrees", "release"); await mkdir(worktree, { recursive: true });
  const store = new LifecycleStore(data, runner({ ticket: 1 }), probe);
  await store.markIntent({ intentId: "i", sessionId: "s", turnId: "t", projectRoot: root, prompt: "build release" });
  await store.begin({ intentId: "i", objective: "release", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), policy: { profile: "pre-release", visualRequired: false, commands: { build: "build", ticket: "ticket", "feature-smoke": "smoke", "affected-regression": "affected" }, artifactPaths: { build: "build.zip", smoke: "smoke.json" }, redGate: { expectedExitCodes: [1], outputPattern: "ticket" } } });
  await store.recordRed("i", "ticket");
  await store.recordCommit("i", { head: "b".repeat(40), tree: "c".repeat(40), commitCount: 1, clean: true, subject: "feat(release): release (v1.2.0)", versionChanged: true, changelogChanged: true });
  await writeFile(path.join(worktree, "build.zip"), "build"); await writeFile(path.join(worktree, "smoke.json"), "{}");
  await assert.rejects(() => store.prove("i"), /super-smoke/);
});

test("proof fails when a proof command mutates the committed source state", async () => {
  const root = await temp(), data = await temp(), worktree = path.join(root, ".captain-sdlc", "worktrees", "x"); await mkdir(worktree, { recursive: true });
  let ticketRuns = 0, probes = 0;
  const changingProbe: StateProbe = async () => ({ head: "b".repeat(40), tree: "c".repeat(40), status: probes++ === 0 ? "" : " M src/x.ts" });
  const store = new LifecycleStore(data, async command => ({ exitCode: command === "ticket" && ticketRuns++ === 0 ? 1 : 0, stdout: command, stderr: "" }), changingProbe);
  await store.markIntent({ intentId: "i", sessionId: "s", turnId: "t", projectRoot: root, prompt: "implement x" });
  await store.begin({ intentId: "i", objective: "x", projectRoot: root, worktreePath: worktree, baseHead: "a".repeat(40), policy }); await store.recordRed("i", "ticket");
  await store.recordCommit("i", { head: "b".repeat(40), tree: "c".repeat(40), commitCount: 1, clean: true, subject: "feat(x): ship x (v1.2.0)", versionChanged: true, changelogChanged: true });
  await writeFile(path.join(worktree, "build.zip"), "build"); await writeFile(path.join(worktree, "smoke.json"), "{}");
  await assert.rejects(() => store.prove("i"), /source state diverged/);
});
