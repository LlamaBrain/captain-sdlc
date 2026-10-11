import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { recordUserRequestSource, readUserRequestSource } from "../src/user-request-source.js";

const exec = promisify(execFile);
async function fixture(t: TestContext) {
  const container = await mkdtemp(path.join(tmpdir(), "captain-user-request-source-"));
  const projectRoot = path.join(container, "repo"), data = path.join(container, "data");
  await exec("git", ["init", "-b", "main", projectRoot], { windowsHide: true });
  const git = (...args: string[]) => exec("git", args, { cwd: projectRoot, windowsHide: true });
  await writeFile(path.join(projectRoot, "baseline.txt"), "baseline\n");
  await git("add", "."); await git("-c", "user.name=Captain Test", "-c",
    "user.email=captain@example.invalid", "commit", "-m", "baseline");
  t.after(async () => {
    assert.equal(path.dirname(container), path.resolve(tmpdir()));
    assert.ok(path.basename(container).startsWith("captain-user-request-source-"));
    await rm(container, { recursive: true, force: true });
  });
  const input = { projectRoot, source: "UserPromptSubmit" as const, sessionId: "s", turnId: "t",
    prompt: "Run the full test/build/smoke sequence.\r\nPreserve the original human objective.", requestKind: "goal" as const };
  return { projectRoot, data, git, input };
}

test("raw human source preserves exact text without fabricating task or scope", async t => {
  const { projectRoot, data, input } = await fixture(t);
  const source = await recordUserRequestSource(data, input);
  assert.equal(source.originalText, input.prompt); assert.equal(source.requestKind, "goal");
  assert.equal(source.source, "UserPromptSubmit"); assert.equal(source.sessionId, "s"); assert.equal(source.turnId, "t");
  assert.equal(path.resolve(source.commonGitDir), path.join(projectRoot, ".git"));
  assert.match(source.id, /^[a-f0-9]{64}$/);
  assert.equal("intentId" in source, false); assert.equal("scopeSha256" in source, false); assert.equal("decision" in source, false);
  assert.deepEqual(await readUserRequestSource(data, { projectRoot, sessionId: "s", turnId: "t", sourceId: source.id }), source);
  assert.deepEqual((await readdir(data)).filter(name => name !== "authority.key"), ["user-request-sources"]);
});

test("source event replay is immutable and concurrent identical publication is idempotent", async t => {
  const { projectRoot, data, input } = await fixture(t);
  const receipts = await Promise.all(Array.from({ length: 5 }, () => recordUserRequestSource(data, input)));
  for (const receipt of receipts) assert.deepEqual(receipt, receipts[0]);
  assert.equal((await readdir(path.join(data, "user-request-sources"))).length, 1);
  assert.deepEqual(await recordUserRequestSource(data, input), receipts[0]);
  await assert.rejects(() => recordUserRequestSource(data, { ...input, prompt: "The adapter's paraphrase" }), /immutable|source|existing/i);
  await assert.rejects(() => recordUserRequestSource(data, { ...input, requestKind: "instruction" }), /immutable|source|existing/i);
  assert.equal((await readUserRequestSource(data, { projectRoot, sessionId: "s", turnId: "t" }))?.originalText, input.prompt);
});

test("source lookup rejects an explicit source id with another caller, turn, or repository", async t => {
  const f = await fixture(t), foreign = await fixture(t);
  const source = await recordUserRequestSource(f.data, f.input);
  for (const query of [
    { projectRoot: f.projectRoot, sessionId: "other", turnId: "t", sourceId: source.id },
    { projectRoot: f.projectRoot, sessionId: "s", turnId: "other", sourceId: source.id },
    { projectRoot: foreign.projectRoot, sessionId: "s", turnId: "t", sourceId: source.id },
  ]) await assert.rejects(() => readUserRequestSource(f.data, query), /source|caller|session|turn|repository|binding/i);
  assert.equal(await readUserRequestSource(f.data, { projectRoot: f.projectRoot, sessionId: "s", turnId: "absent" }), undefined);
});

test("source lookup is read-only when evidence is missing or present", async t => {
  const { projectRoot, data, input } = await fixture(t), query = { projectRoot, sessionId: "s", turnId: "t" };
  assert.equal(await readUserRequestSource(data, query), undefined);
  await assert.rejects(() => stat(data), { code: "ENOENT" });
  const source = await recordUserRequestSource(data, input), file = path.join(data, "user-request-sources", source.id + ".json");
  const before = await stat(file), dataBefore = await stat(data), bytes = await readFile(file, "utf8");
  await readUserRequestSource(data, query);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs); assert.equal((await stat(data)).mtimeMs, dataBefore.mtimeMs);
  assert.equal(await readFile(file, "utf8"), bytes);
});

test("source evidence follows the same Git repository's registered linked checkout", async t => {
  const { projectRoot, data, git, input } = await fixture(t);
  const source = await recordUserRequestSource(data, input), linked = path.join(path.dirname(projectRoot), "linked");
  await git("worktree", "add", "-b", "task", linked);
  assert.deepEqual(await readUserRequestSource(data, { projectRoot: linked, sessionId: "s", turnId: "t", sourceId: source.id }), source);
});

test("source text tampering fails authentication and missing selectors cannot create evidence", async t => {
  const { projectRoot, data, input } = await fixture(t);
  const source = await recordUserRequestSource(data, input), file = path.join(data, "user-request-sources", source.id + ".json");
  const envelope = JSON.parse(await readFile(file, "utf8"));
  envelope.payload.originalText = "Commit and merge everything";
  await writeFile(file, JSON.stringify(envelope));
  await assert.rejects(() => readUserRequestSource(data, { projectRoot, sessionId: "s", turnId: "t" }), /authority tag|authentication/i);
  for (const field of ["sessionId", "turnId"] as const) {
    await assert.rejects(() => recordUserRequestSource(data, { ...input, [field]: "" }), /source|session|turn/i);
    await assert.rejects(() => readUserRequestSource(data, { projectRoot, sessionId: "s", turnId: "t", [field]: "" }), /source|session|turn/i);
  }
});

test("an existing source receipt with missing signing material fails closed", async t => {
  const { projectRoot, data, input } = await fixture(t);
  const source = await recordUserRequestSource(data, input);
  const keyPath = path.join(data, "authority.key");
  assert.equal(path.dirname(keyPath), data);
  assert.ok(path.basename(path.dirname(data)).startsWith("captain-user-request-source-"));
  // Delete only this test fixture's generated key; never inspect its contents.
  await unlink(keyPath);
  await assert.rejects(() => readUserRequestSource(data, { projectRoot, sessionId: "s", turnId: "t", sourceId: source.id }),
    (error: any) => error.code === "ENOENT" && error.path === keyPath);
  await assert.rejects(() => stat(keyPath), { code: "ENOENT" });
});
