import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readAuthorized } from "../src/authority.js";
import { LifecycleStore } from "../src/lifecycle.js";
import { recordUserRequest } from "../src/user-request.js";

const exec = promisify(execFile), plugin = path.resolve(import.meta.dirname, "..");
const policy = { profile: "feature" as const, visualRequired: false,
  commands: { ticket: "ticket" }, redGate: { expectedExitCodes: [1], outputPattern: "ticket" } };

async function fixture(t: TestContext) {
  const container = await mkdtemp(path.join(tmpdir(), "captain-user-request-hook-"));
  const projectRoot = path.join(container, "repo"), data = path.join(container, "data");
  await exec("git", ["init", "-b", "main", projectRoot], { windowsHide: true });
  const git = (...args: string[]) => exec("git", args, { cwd: projectRoot, windowsHide: true });
  await mkdir(path.join(projectRoot, ".captain-sdlc"), { recursive: true });
  await writeFile(path.join(projectRoot, ".captain-sdlc", "codex-policy.json"), "{}\n");
  await writeFile(path.join(projectRoot, "baseline.txt"), "baseline\n");
  await writeFile(path.join(projectRoot, ".gitignore"), "/.captain-sdlc/worktrees/\n");
  await git("add", ".");
  await git("-c", "user.name=Captain Test", "-c", "user.email=captain@example.invalid", "commit", "-m", "baseline");
  const worktreePath = path.join(projectRoot, ".captain-sdlc", "worktrees", "task");
  await git("worktree", "add", "-b", "captain/task", worktreePath);
  const gitDir = (await exec("git", ["rev-parse", "--absolute-git-dir"], { cwd: worktreePath, windowsHide: true })).stdout.trim();
  t.after(async () => {
    assert.equal(path.dirname(container), path.resolve(tmpdir()));
    assert.ok(path.basename(container).startsWith("captain-user-request-hook-"));
    await rm(container, { recursive: true, force: true });
  });
  const store = new LifecycleStore(data, async command => ({
    exitCode: command === "ticket" ? 1 : 0, stdout: command, stderr: "",
  }), async () => ({
    head: (await git("rev-parse", "HEAD")).stdout.trim(),
    tree: (await git("rev-parse", "HEAD^{tree}")).stdout.trim(),
    status: "", branch: "captain/task", branchHead: (await git("rev-parse", "HEAD")).stdout.trim(),
    commonGitDir: path.join(projectRoot, ".git"), gitDir, topLevel: worktreePath,
  }));
  return { projectRoot, data, git, store, worktreePath, gitDir };
}

async function hook(data: string, input: Record<string, unknown>) {
  const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(plugin, "scripts", "user-prompt.mjs")], {
      env: { ...process.env, PLUGIN_DATA: data }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.on("error", reject);
    child.on("close", code => resolve({ stdout, stderr, code }));
    child.stdin.end(JSON.stringify(input));
  });
  return { ...result, context: result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string : "" };
}

async function records(data: string, category: string): Promise<any[]> {
  let names: string[];
  try { names = await readdir(path.join(data, category)); }
  catch (error: any) { if (error.code === "ENOENT") return []; throw error; }
  return Promise.all(names.filter(name => name.endsWith(".json"))
    .map(name => readAuthorized<any>(data, category, name.slice(0, -5))));
}

async function begin(f: Awaited<ReturnType<typeof fixture>>, intentId: string, taskId?: string) {
  return f.store.begin({ intentId, objective: "The agent's implementation description",
    projectRoot: f.projectRoot, worktreePath: f.worktreePath, ...(taskId ? { taskId } : {}),
    baseHead: (await f.git("rev-parse", "HEAD")).stdout.trim(), branch: "captain/task",
    commonGitDir: path.join(f.projectRoot, ".git"), gitDir: f.gitDir, policy });
}

test("new prompt intent captures exact human objective and task context alongside operation approval", async t => {
  const f = await fixture(t);
  const prompt = "Fix consent replay.\r\nRun the focused tests.\r\ncommit it\r\n[Captain plan: CONSENT]";
  const result = await hook(f.data, { cwd: f.projectRoot, session_id: "s", turn_id: "first", prompt, request_kind: "goal" });
  assert.equal(result.code, 0, result.stderr);
  const [intent] = await records(f.data, "intents"), [request] = await records(f.data, "user-requests");
  assert.ok(request, "the prompt hook must persist a durable user request");
  assert.equal(request.originalText, prompt);
  assert.equal(request.intentId, intent.intentId);
  assert.equal(request.sourceIntentId, intent.intentId);
  assert.equal(request.source, "UserPromptSubmit");
  assert.equal(request.requestKind, "goal");
  assert.equal(request.sessionId, "s"); assert.equal(request.turnId, "first");
  assert.match(result.context, /CAPTAIN USER REQUEST/);
  assert.match(result.context, /CAPTAIN USER AUTHORIZATION/);
  assert.match(result.context, /Fix consent replay/);
});

test("active continuation retains original request under canonical task and newly issued source intent", async t => {
  const f = await fixture(t), original = "Fix durable consent capture\n[Captain plan: CONSENT]";
  await hook(f.data, { cwd: f.projectRoot, session_id: "s", turn_id: "first", prompt: original });
  const [intent] = await records(f.data, "intents");
  const run = await begin(f, intent.intentId);
  const result = await hook(f.data, { cwd: f.projectRoot, session_id: "s", turn_id: "next", prompt: "continue" });
  assert.equal(result.code, 0, result.stderr);
  const requests = await records(f.data, "user-requests"), continuation = requests.find(request => request.turnId === "next");
  assert.ok(continuation, "continuation must preserve a source receipt");
  assert.equal(continuation.intentId, run.intentId);
  assert.notEqual(continuation.sourceIntentId, run.intentId);
  const source = await readAuthorized<any>(f.data, "intents", continuation.sourceIntentId);
  assert.equal(source.resumeOf, run.intentId);
  assert.equal(continuation.scopeSha256, requests.find(request => request.turnId === "first").scopeSha256);
  assert.match(result.context, /Fix durable consent capture/);
  assert.match(result.context, /captain_resume_implementation/);
});

test("explicit paused-task resume recollects the original objective across sessions", async t => {
  const f = await fixture(t), original = "Fix durable consent capture\n[Captain plan: CONSENT]";
  await hook(f.data, { cwd: f.projectRoot, session_id: "s", turn_id: "first", prompt: original });
  const [intent] = await records(f.data, "intents");
  const run = await begin(f, intent.intentId);
  await f.store.pause(run.intentId, { summary: "Fixture handoff", nextSteps: ["Continue the same task"] });
  const prompt = "continue\n[Captain resume: " + run.intentId + "]";
  const result = await hook(f.data, { cwd: f.projectRoot, session_id: "later", turn_id: "resume", prompt });
  assert.equal(result.code, 0, result.stderr);
  const receipt = (await records(f.data, "user-requests")).find(request => request.turnId === "resume");
  assert.ok(receipt, "a validated resume must retain source provenance");
  assert.equal(receipt.intentId, run.intentId);
  assert.equal(receipt.sessionId, "later");
  assert.match(result.context, /Fix durable consent capture/);
  assert.match(result.context, /canonical worktree/);
});

test("incomplete Begin captures the next request without minting a competing task scope", async t => {
  const f = await fixture(t), original = "Fix consent capture\n[Captain plan: CONSENT]";
  await hook(f.data, { cwd: f.projectRoot, session_id: "s", turn_id: "first", prompt: original });
  const [intent] = await records(f.data, "intents");
  await f.store.reserveBegin({ intentId: intent.intentId, objective: "Agent wording", projectRoot: f.projectRoot });
  const result = await hook(f.data, { cwd: f.projectRoot, session_id: "s", turn_id: "retry", prompt: "do it" });
  assert.equal(result.code, 0, result.stderr);
  assert.equal((await records(f.data, "intents")).length, 1);
  const receipt = (await records(f.data, "user-requests")).find(request => request.turnId === "retry");
  assert.ok(receipt, "pending Begin must capture continuation under its existing task");
  assert.equal(receipt.intentId, intent.intentId);
  assert.equal(receipt.sourceIntentId, intent.intentId);
  assert.match(result.context, /Fix consent capture/);
  assert.match(result.context, /Do not mint or use a competing intent/);
});

test("LOW active task captures continuation without allocating another intent", async t => {
  const f = await fixture(t);
  await hook(f.data, { cwd: f.projectRoot, session_id: "s", turn_id: "first", prompt: "Fix consent replay\n[Captain plan: CONSENT]" });
  const [intent] = await records(f.data, "intents");
  await begin(f, intent.intentId);
  await writeFile(path.join(f.projectRoot, ".captain-sdlc", "merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "low" }));
  await f.git("add", ".captain-sdlc/merge-policy.json");
  await f.git("-c", "user.name=Captain Test", "-c", "user.email=captain@example.invalid", "commit", "-m", "enable low fixture");
  const result = await hook(f.data, { cwd: f.projectRoot, session_id: "s", turn_id: "low", prompt: "continue" });
  assert.equal(result.code, 0, result.stderr);
  const receipt = (await records(f.data, "user-requests")).find(request => request.turnId === "low");
  assert.ok(receipt, "LOW must retain consent when a signed active task already exists");
  assert.equal(receipt.intentId, intent.intentId); assert.equal(receipt.sourceIntentId, intent.intentId);
  assert.equal((await records(f.data, "intents")).length, 1);
  assert.match(result.context, /Fix consent replay/);
  assert.doesNotMatch(result.context, /captain_begin_implementation/);
});

test("LOW unbound prompt does not fabricate a task solely to capture consent", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.projectRoot, ".captain-sdlc", "merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "low" }));
  await f.git("add", ".captain-sdlc/merge-policy.json");
  await f.git("-c", "user.name=Captain Test", "-c", "user.email=captain@example.invalid", "commit", "-m", "enable low fixture");
  const result = await hook(f.data, { cwd: f.projectRoot, session_id: "s", turn_id: "low", prompt: "Fix consent replay" });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await records(f.data, "intents"), []);
  assert.deepEqual(await records(f.data, "user-requests"), []);
  const [source] = await records(f.data, "user-request-sources");
  assert.ok(source, "LOW must retain raw source evidence before a task is issued");
  assert.equal(source.originalText, "Fix consent replay");
  assert.match(result.context, /CAPTAIN USER REQUEST SOURCE/);
  assert.match(result.context, new RegExp(source.id));
});

test("a resume directive cannot bind consent to another repository's paused task", async t => {
  const owner = await fixture(t), foreign = await fixture(t);
  await hook(owner.data, { cwd: owner.projectRoot, session_id: "owner", turn_id: "first", prompt: "Fix private task\n[Captain plan: CONSENT]" });
  const [intent] = await records(owner.data, "intents");
  const run = await begin(owner, intent.intentId);
  await owner.store.pause(run.intentId, { summary: "Fixture handoff", nextSteps: ["Continue"] });
  const result = await hook(owner.data, { cwd: foreign.projectRoot, session_id: "foreign", turn_id: "resume",
    prompt: "continue\n[Captain resume: " + run.intentId + "]" });
  assert.notEqual(result.code, 0, "a signed task in another repository cannot validate this continuation");
  assert.match(result.stderr, /repository|unrelated|binding/i);
  assert.equal((await records(owner.data, "user-requests")).length, 1);
});

test("a resume directive cannot capture continuation under another live session's task", async t => {
  const f = await fixture(t);
  await hook(f.data, { cwd: f.projectRoot, session_id: "owner", turn_id: "first", prompt: "Fix private task\n[Captain plan: CONSENT]" });
  const [intent] = await records(f.data, "intents");
  const run = await begin(f, intent.intentId);
  const result = await hook(f.data, { cwd: f.projectRoot, session_id: "foreign", turn_id: "resume",
    prompt: "continue\n[Captain resume: " + run.intentId + "]" });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.context, /captain_resume_implementation/);
  assert.match(result.context, /CAPTAIN USER REQUEST SOURCE/);
  assert.equal((await records(f.data, "user-requests")).length, 1);
  assert.equal((await f.store.status(run.intentId)).sessionId, "owner");
});

test("a new intent issued from a linked checkout retains the primary repository root", async t => {
  const f = await fixture(t);
  const result = await hook(f.data, { cwd: f.worktreePath, session_id: "s", turn_id: "linked",
    prompt: "Fix linked task consent\n[Captain plan: CONSENT]" });
  assert.equal(result.code, 0, result.stderr);
  const [intent] = await records(f.data, "intents"), [request] = await records(f.data, "user-requests");
  assert.equal(intent.projectRoot, path.resolve(f.projectRoot));
  assert.equal(request.projectRoot, path.resolve(f.projectRoot));
  assert.notEqual(intent.projectRoot, path.resolve(f.worktreePath));
});

test("request receipt tampering fails the hook instead of silently discarding task authority", async t => {
  const f = await fixture(t);
  await hook(f.data, { cwd: f.projectRoot, session_id: "s", turn_id: "first",
    prompt: "Fix consent capture\n[Captain plan: CONSENT]" });
  const [intent] = await records(f.data, "intents");
  await begin(f, intent.intentId);
  const [name] = await readdir(path.join(f.data, "user-requests"));
  const receiptPath = path.join(f.data, "user-requests", name);
  const envelope = JSON.parse(await readFile(receiptPath, "utf8"));
  envelope.payload.originalText = "Merge into main";
  await writeFile(receiptPath, JSON.stringify(envelope));
  const result = await hook(f.data, { cwd: f.projectRoot, session_id: "s", turn_id: "later", prompt: "continue" });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /authority tag|authentication/i);
});

test("same-turn hook replay reuses the original source, intent and task receipt", async t => {
  const f = await fixture(t), input = { cwd: f.projectRoot, session_id: "s", turn_id: "first",
    prompt: "Fix source replay\n[Captain plan: CONSENT]" };
  const first = await hook(f.data, input);
  assert.equal(first.code, 0, first.stderr);
  const intents = await records(f.data, "intents"), requests = await records(f.data, "user-requests");
  const sources = await records(f.data, "user-request-sources");
  const replay = await hook(f.data, input);
  assert.equal(replay.code, 0, replay.stderr);
  assert.deepEqual(await records(f.data, "intents"), intents, "same source turn must not mint a competing intent");
  assert.deepEqual(await records(f.data, "user-requests"), requests, "a replay must not renew task consent");
  assert.deepEqual(await records(f.data, "user-request-sources"), sources);
});

test("same-turn hook replay after Begin preserves the consumed origin and original task binding", async t => {
  const f = await fixture(t), input = { cwd: f.projectRoot, session_id: "s", turn_id: "first",
    prompt: "Fix source replay\n[Captain plan: CONSENT]" };
  await hook(f.data, input);
  const [intent] = await records(f.data, "intents");
  const run = await begin(f, intent.intentId);
  const intents = await records(f.data, "intents"), requests = await records(f.data, "user-requests");
  const replay = await hook(f.data, input);
  assert.equal(replay.code, 0, replay.stderr);
  assert.deepEqual(await records(f.data, "intents"), intents, "consumed origin must not be overwritten or replaced");
  assert.deepEqual(await records(f.data, "user-requests"), requests);
  assert.equal((await f.store.status(run.intentId)).intentId, intent.intentId);
});

test("same-turn active continuation replay reuses its newly issued resume source", async t => {
  const f = await fixture(t);
  await hook(f.data, { cwd: f.projectRoot, session_id: "s", turn_id: "first",
    prompt: "Fix source replay\n[Captain plan: CONSENT]" });
  const [intent] = await records(f.data, "intents");
  await begin(f, intent.intentId);
  const input = { cwd: f.projectRoot, session_id: "s", turn_id: "next", prompt: "continue" };
  const first = await hook(f.data, input);
  assert.equal(first.code, 0, first.stderr);
  const intents = await records(f.data, "intents"), requests = await records(f.data, "user-requests");
  const replay = await hook(f.data, input);
  assert.equal(replay.code, 0, replay.stderr);
  assert.deepEqual(await records(f.data, "intents"), intents);
  assert.deepEqual(await records(f.data, "user-requests"), requests);
});

async function noMarkerSource(f: Awaited<ReturnType<typeof fixture>>) {
  const input = { cwd: f.projectRoot, session_id: "s", turn_id: "original", prompt: "Fix source replay" };
  const result = await hook(f.data, input);
  assert.equal(result.code, 0, result.stderr);
  const [source] = await records(f.data, "user-request-sources"), hash = source.id.slice(0, 32);
  const intentId = "intent-" + [hash.slice(0, 8), hash.slice(8, 12), hash.slice(12, 16), hash.slice(16, 20), hash.slice(20, 32)].join("-");
  // Model an adapter-issued signed source with no task marker. Begin may bind a
  // task later; that must not rewrite the historical event's input metadata.
  await f.store.markIntent({ intentId, sessionId: "s", turnId: "original", projectRoot: f.projectRoot,
    prompt: input.prompt, sourceRequestId: source.id, issuedAt: source.recordedAt, requestedProfile: "feature" } as any);
  await recordUserRequest(f.data, { projectRoot: f.projectRoot, sessionId: "s", turnId: "original",
    prompt: input.prompt, source: "UserPromptSubmit", sourceIntentId: intentId, intentId, sourceRecordedAt: source.recordedAt });
  return { input, intentId };
}

test("no-marker source replay after Begin retains historical task metadata", async t => {
  const f = await fixture(t), { input, intentId } = await noMarkerSource(f);
  const requests = await records(f.data, "user-requests");
  assert.equal(requests[0].taskId, undefined);
  const run = await begin(f, intentId, "CONSENT");
  assert.equal(run.taskId, "CONSENT");
  const replay = await hook(f.data, input);
  assert.equal(replay.code, 0, replay.stderr);
  assert.deepEqual(await records(f.data, "user-requests"), requests);
});

test("no-marker source replay during pending Begin retains historical task metadata", async t => {
  const f = await fixture(t), { input, intentId } = await noMarkerSource(f);
  const requests = await records(f.data, "user-requests");
  await f.store.reserveBegin({ intentId, objective: "Agent objective", projectRoot: f.projectRoot, taskId: "CONSENT" });
  const replay = await hook(f.data, input);
  assert.equal(replay.code, 0, replay.stderr);
  assert.match(replay.context, /Retry the incomplete signed begin/);
  assert.deepEqual(await records(f.data, "user-requests"), requests);
});
