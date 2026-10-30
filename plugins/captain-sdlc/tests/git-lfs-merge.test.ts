import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { MergeWorkflowStore } from "../src/merge-workflow.js";
import { assertMergeTreeGitVersion, withShadowGit } from "../src/git-safe-status.js";
import { abortMerge } from "../src/workspace.js";

const exec = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1", GIT_NO_REPLACE_OBJECTS: "1" };
for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/i.test(key)) delete env[key];
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, env, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const baseA = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 17 + 3) % 256));
const baseB = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 23 + 9) % 256));
const oursA = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 31 + 13) % 256));
const theirsA = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37 + 19) % 256));
const theirsB = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 41 + 7) % 256));
const resolvedA = Buffer.from("manual resolution\0\xff", "latin1");
const ok = { exitCode: 0, stdout: "fixture gate passed", stderr: "" };

async function fixture(t: TestContext) {
  const container = await mkdtemp(path.join(tmpdir(), "captain-lfs-merge-"));
  t.after(async () => {
    assert.equal(path.dirname(container), path.resolve(tmpdir()));
    assert.ok(path.basename(container).startsWith("captain-lfs-merge-"));
    await rm(container, { recursive: true, force: true });
  });
  const target = path.join(container, "target"), source = path.join(target, ".captain-sdlc", "worktrees", "task"), data = path.join(container, "authority"), marker = path.join(container, "unsafe-driver-ran.txt");
  await mkdir(target);
  await git(target, "init", "-b", "main");
  await git(target, "config", "user.name", "Captain Test");
  await git(target, "config", "user.email", "captain@example.invalid");
  await git(target, "config", "core.autocrlf", "false");
  await git(target, "lfs", "install", "--local");
  await mkdir(path.join(target, ".captain-sdlc"));
  await writeFile(path.join(target, ".captain-sdlc/codex-policy.json"), JSON.stringify({ profile: "low", visualRequired: false,
    commands: { build: "trusted build", ticket: "trusted ticket", "feature-smoke": "trusted smoke", "affected-regression": "trusted regression" },
    commit: { conventional: true, require_version_suffix: false, require_task_trailer: false, version_file: "VERSION", version_surfaces: [], changelog_files: ["CHANGELOG.md"] } }));
  await writeFile(path.join(target, ".captain-sdlc/merge-policy.json"), JSON.stringify({ schema_version: 1, strictness: "low" }));
  await writeFile(path.join(target, ".gitignore"), ".captain-sdlc/worktrees/\n");
  await writeFile(path.join(target, ".gitattributes"), "*.uasset filter=lfs diff=lfs merge=lfs -text\n*.bin binary\n");
  await writeFile(path.join(target, "VERSION"), "1.0.0\n");
  await writeFile(path.join(target, "CHANGELOG.md"), "# Changelog\n");
  await writeFile(path.join(target, "shared.txt"), "first\nsecond\nthird\nfourth\nfifth\n");
  await writeFile(path.join(target, "raw.bin"), "first\nsecond\nthird\nfourth\nfifth\n");
  await writeFile(path.join(target, "asset_a.uasset"), baseA);
  await writeFile(path.join(target, "asset_b.uasset"), baseB);
  await git(target, "add", "."); await git(target, "commit", "-m", "fixture baseline");
  const base = await git(target, "rev-parse", "HEAD");
  await git(target, "worktree", "add", "-b", "task", source);
  const args = { source_worktree: source, target_worktree: target, target_branch: "main", session_id: "lfs-divergent-session" };
  return { container, target, source, data, marker, base, args };
}

async function commitFiles(root: string, files: string[], message: string) {
  await git(root, "add", "--", ...files);
  await git(root, "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}
async function poisonConfiguredDrivers(f: Awaited<ReturnType<typeof fixture>>) {
  const command = `node -e "require('node:fs').writeFileSync('${f.marker.replaceAll("\\", "/")}', 'unsafe driver ran')"`;
  for (const setting of ["filter.lfs.clean", "filter.lfs.smudge", "filter.lfs.process", "merge.lfs.driver"]) await git(f.target, "config", "--local", setting, command);
}
async function assertNoUnsafeDriver(f: Awaited<ReturnType<typeof fixture>>) { await assert.rejects(access(f.marker), { code: "ENOENT" }); }
function interruptOnce(store: MergeWorkflowStore, phase: string) {
  let hit = false;
  (store as any).lfsMergeCheckpoint = async (current: string) => { if (!hit && current === phase) { hit = true; throw new Error(`simulated interruption: ${phase}`); } };
  return () => hit;
}
async function interruptedId(store: MergeWorkflowStore, args: Awaited<ReturnType<typeof fixture>>["args"]) {
  let mergeId = "";
  await assert.rejects(store.prep(args), (error: any) => {
    assert.match(String(error), /simulated interruption/);
    assert.equal(typeof error.merge_id, "string");
    mergeId = error.merge_id;
    return true;
  });
  return mergeId;
}

test("isolated merge-tree requires Git 2.43 or newer", () => {
  assert.throws(() => assertMergeTreeGitVersion("git version 2.42.2"), /2\.43/);
  assert.throws(() => assertMergeTreeGitVersion("git version unknown"), /version|2\.43/i);
  assert.doesNotThrow(() => assertMergeTreeGitVersion("git version 2.43.0"));
  assert.doesNotThrow(() => assertMergeTreeGitVersion("git version 2.50.1.windows.1"));
  assert.doesNotThrow(() => assertMergeTreeGitVersion("git version 3.0.0"));
});

test("divergent LFS merge rejects custom merge assignments in local info attributes", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "task.txt"), "source task\n"); await commitFiles(f.source, ["task.txt"], "fix(test): source task");
  await writeFile(path.join(f.target, "asset_b.uasset"), theirsB); await commitFiles(f.target, ["asset_b.uasset"], "fix(test): target asset");
  const attrs = await git(f.source, "rev-parse", "--path-format=absolute", "--git-path", "info/attributes");
  await writeFile(attrs, "*.txt merge=untrusted\n");
  const command = `node -e "require('node:fs').writeFileSync('${f.marker.replaceAll("\\", "/")}', 'unsafe driver ran')"`;
  await git(f.target, "config", "--local", "merge.untrusted.driver", command);
  await assert.rejects(new MergeWorkflowStore(f.data, async () => ok).prep(f.args), /metadata attributes|merge drivers/i);
  await assert.rejects(git(f.source, "rev-parse", "--verify", "MERGE_HEAD"));
  assert.equal(await git(f.source, "for-each-ref", "--format=%(refname)", "refs/captain-sdlc/lfs-merges/"), "");
  await assertNoUnsafeDriver(f);
});

test("isolated merge-tree returns binary LFS conflicts and preserves text auto-merge without drivers", async t => {
  const f = await fixture(t), special = "asset [one].uasset";
  await writeFile(path.join(f.source, "shared.txt"), "source first\nsecond\nthird\nfourth\nfifth\n");
  await writeFile(path.join(f.source, "asset_a.uasset"), oursA);
  await writeFile(path.join(f.source, special), oursA);
  const sourceHead = await commitFiles(f.source, ["shared.txt", "asset_a.uasset", special], "fix(test): source merge inputs");
  await writeFile(path.join(f.target, "shared.txt"), "first\nsecond\nthird\nfourth\ntarget fifth\n");
  await writeFile(path.join(f.target, "asset_a.uasset"), theirsA);
  await writeFile(path.join(f.target, special), theirsB);
  const targetHead = await commitFiles(f.target, ["shared.txt", "asset_a.uasset", special], "fix(test): target merge inputs");
  await poisonConfiguredDrivers(f);
  const merge = await withShadowGit(f.source, (args, cwd) => git(cwd, ...args), shadow => shadow.mergeTree(sourceHead, targetHead));
  assert.equal(merge.status, "conflicts");
  const fields = merge.output.toString("utf8").split("\0"), tree = fields[0];
  assert.match(tree, /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/);
  assert.equal(await git(f.source, "cat-file", "-t", tree), "tree", "merged objects survive shadow cleanup");
  assert.equal(await git(f.source, "show", `${tree}:shared.txt`), "source first\nsecond\nthird\nfourth\ntarget fifth");
  const stages = fields.filter(field => /^100(?:644|755) [a-f0-9]+ [123]\t/.test(field));
  assert.equal(stages.filter(field => field.endsWith("\tasset_a.uasset")).length, 3);
  assert.equal(stages.filter(field => field.endsWith(`\t${special}`)).length, 2, "add/add LFS conflicts retain both staged pointers");
  await assertNoUnsafeDriver(f);
});

test("isolated merge-tree uses signed source attributes rather than mutable worktree attributes", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "shared.txt"), "source first\nsecond\nthird\nfourth\nfifth\n");
  const sourceHead = await commitFiles(f.source, ["shared.txt"], "fix(test): source text");
  await writeFile(path.join(f.target, "shared.txt"), "first\nsecond\nthird\nfourth\ntarget fifth\n");
  await writeFile(path.join(f.target, "asset_a.uasset"), theirsA);
  const targetHead = await commitFiles(f.target, ["shared.txt", "asset_a.uasset"], "fix(test): target changes");
  await poisonConfiguredDrivers(f);
  await writeFile(path.join(f.source, ".gitattributes"), "*.uasset filter=lfs diff=lfs merge=lfs -text\nshared.txt -merge\n");
  const merge = await withShadowGit(f.source, (args, cwd) => git(cwd, ...args), shadow => shadow.mergeTree(sourceHead, targetHead));
  assert.equal(merge.status, "clean");
  const tree = merge.output.toString("utf8").split("\0")[0];
  assert.equal(await git(f.source, "show", `${tree}:shared.txt`), "source first\nsecond\nthird\nfourth\ntarget fifth");
  await assertNoUnsafeDriver(f);
});

test("isolated merge-tree preserves non-LFS binary attributes", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "raw.bin"), "source first\nsecond\nthird\nfourth\nfifth\n");
  const sourceHead = await commitFiles(f.source, ["raw.bin"], "fix(test): source binary");
  await writeFile(path.join(f.target, "raw.bin"), "first\nsecond\nthird\nfourth\ntarget fifth\n");
  const targetHead = await commitFiles(f.target, ["raw.bin"], "fix(test): target binary");
  await poisonConfiguredDrivers(f);
  const merge = await withShadowGit(f.source, (args, cwd) => git(cwd, ...args), shadow => shadow.mergeTree(sourceHead, targetHead));
  assert.equal(merge.status, "conflicts");
  const fields = merge.output.toString("utf8").split("\0");
  assert.equal(fields.filter(field => /^100(?:644|755) [a-f0-9]+ [123]\traw\.bin$/.test(field)).length, 3);
  await assertNoUnsafeDriver(f);
});

test("divergent source text and target LFS edits prepare together with ordinary text auto-merge", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "shared.txt"), "source first\nsecond\nthird\nfourth\nfifth\n");
  const sourceHead = await commitFiles(f.source, ["shared.txt"], "fix(test): source text");
  await writeFile(path.join(f.target, "shared.txt"), "first\nsecond\nthird\nfourth\ntarget fifth\n");
  await writeFile(path.join(f.target, "asset_a.uasset"), theirsA);
  const targetHead = await commitFiles(f.target, ["shared.txt", "asset_a.uasset"], "fix(test): target text and LFS");
  await poisonConfiguredDrivers(f);
  const pending = await new MergeWorkflowStore(f.data, async () => ok).prep(f.args);
  assert.equal(pending.state, "needs_commit");
  assert.deepEqual(pending.conflicts, []);
  assert.equal(await git(f.source, "rev-parse", "MERGE_HEAD"), targetHead);
  assert.equal(await git(f.source, "rev-parse", "HEAD"), sourceHead);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), targetHead);
  assert.equal(await readFile(path.join(f.source, "shared.txt"), "utf8"), "source first\nsecond\nthird\nfourth\ntarget fifth\n");
  assert.deepEqual(await readFile(path.join(f.source, "asset_a.uasset")), theirsA);
  assert.match(await git(f.source, "show", ":asset_a.uasset"), new RegExp(`oid sha256:${sha(theirsA)}`));
  await assertNoUnsafeDriver(f);
});

test("divergent edits to different LFS assets retain both hydrated results", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "asset_a.uasset"), oursA);
  const sourceHead = await commitFiles(f.source, ["asset_a.uasset"], "fix(test): source LFS asset");
  await writeFile(path.join(f.target, "asset_b.uasset"), theirsB);
  const targetHead = await commitFiles(f.target, ["asset_b.uasset"], "fix(test): target LFS asset");
  await poisonConfiguredDrivers(f);
  const pending = await new MergeWorkflowStore(f.data, async () => ok).prep(f.args);
  assert.equal(pending.state, "needs_commit");
  assert.equal(await git(f.source, "rev-parse", "HEAD"), sourceHead);
  assert.equal(await git(f.source, "rev-parse", "MERGE_HEAD"), targetHead);
  assert.deepEqual(await readFile(path.join(f.source, "asset_a.uasset")), oursA);
  assert.deepEqual(await readFile(path.join(f.source, "asset_b.uasset")), theirsB);
  assert.match(await git(f.source, "show", ":asset_a.uasset"), new RegExp(`oid sha256:${sha(oursA)}`));
  assert.match(await git(f.source, "show", ":asset_b.uasset"), new RegExp(`oid sha256:${sha(theirsB)}`));
  await assertNoUnsafeDriver(f);
});

test("conflicting LFS binaries stay unmerged until explicit resolution and then retain both parents", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "asset_a.uasset"), oursA);
  const sourceHead = await commitFiles(f.source, ["asset_a.uasset"], "fix(test): source conflicting asset");
  await writeFile(path.join(f.target, "asset_a.uasset"), theirsA);
  const targetHead = await commitFiles(f.target, ["asset_a.uasset"], "fix(test): target conflicting asset");
  await poisonConfiguredDrivers(f);
  const store = new MergeWorkflowStore(f.data, async () => ok), pending = await store.prep(f.args);
  assert.equal(pending.state, "needs_resolution");
  assert.ok(pending.conflicts.includes("asset_a.uasset"));
  const stages = await git(f.source, "ls-files", "--unmerged", "--", "asset_a.uasset");
  assert.match(stages, /\b1\s+asset_a\.uasset/);
  assert.match(stages, /\b2\s+asset_a\.uasset/);
  assert.match(stages, /\b3\s+asset_a\.uasset/);
  for (const [stage, expected] of [[1, baseA], [2, oursA], [3, theirsA]] as const) assert.match(await git(f.source, "show", `:${stage}:asset_a.uasset`), new RegExp(`oid sha256:${sha(expected)}`));
  assert.deepEqual(await readFile(path.join(f.source, "asset_a.uasset")), oursA, "binary conflict retains ours for explicit human resolution");
  await writeFile(path.join(f.source, "asset_a.uasset"), resolvedA);
  await writeFile(path.join(f.source, "VERSION"), "1.0.1\n");
  await writeFile(path.join(f.source, "CHANGELOG.md"), "# Changelog\n- Resolve LFS conflict\n");
  const ready = await store.prep({ ...f.args, merge_id: pending.merge_id, commit: { paths: ["asset_a.uasset", "VERSION", "CHANGELOG.md"], subject: "chore(merge): resolve LFS conflict" } });
  assert.equal(ready.state, "ready");
  await assert.rejects(git(f.source, "rev-parse", "--verify", "MERGE_HEAD"));
  assert.equal(await git(f.source, "ls-files", "--unmerged"), "");
  assert.equal(await git(f.source, "diff", "--cached", "--name-only", "--no-ext-diff"), "");
  const parents = (await git(f.source, "rev-list", "--parents", "-n", "1", "HEAD")).split(" ");
  assert.deepEqual(parents.slice(1), [sourceHead, targetHead]);
  assert.deepEqual(await readFile(path.join(f.source, "asset_a.uasset")), resolvedA);
  assert.match(await git(f.source, "show", "HEAD:asset_a.uasset"), new RegExp(`oid sha256:${sha(resolvedA)}`));
  await assertNoUnsafeDriver(f);
});

test("ordinary text conflicts in an LFS repository retain markers and support explicit two-parent resolution", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "shared.txt"), "source first\nsecond\nthird\nfourth\nfifth\n");
  const sourceHead = await commitFiles(f.source, ["shared.txt"], "fix(test): source text conflict");
  await writeFile(path.join(f.target, "shared.txt"), "target first\nsecond\nthird\nfourth\nfifth\n");
  const targetHead = await commitFiles(f.target, ["shared.txt"], "fix(test): target text conflict");
  await poisonConfiguredDrivers(f);
  const store = new MergeWorkflowStore(f.data, async () => ok), pending = await store.prep(f.args);
  assert.equal(pending.state, "needs_resolution"); assert.ok(pending.conflicts.includes("shared.txt"));
  const text = await readFile(path.join(f.source, "shared.txt"), "utf8");
  assert.match(text, /<<<<<<<.*\nsource first\n=======\ntarget first\n>>>>>>>/);
  const stages = await git(f.source, "ls-files", "--unmerged", "--", "shared.txt");
  for (const stage of [1, 2, 3]) assert.match(stages, new RegExp(`\\b${stage}\\s+shared\\.txt`));
  await writeFile(path.join(f.source, "shared.txt"), "resolved first\nsecond\nthird\nfourth\nfifth\n");
  await writeFile(path.join(f.source, "VERSION"), "1.0.1\n");
  await writeFile(path.join(f.source, "CHANGELOG.md"), "# Changelog\n- Resolve text conflict\n");
  const ready = await store.prep({ ...f.args, merge_id: pending.merge_id, commit: { paths: ["shared.txt", "VERSION", "CHANGELOG.md"], subject: "chore(merge): resolve text conflict" } });
  assert.equal(ready.state, "ready");
  assert.deepEqual((await git(f.source, "rev-list", "--parents", "-n", "1", "HEAD")).split(" ").slice(1), [sourceHead, targetHead]);
  await assert.rejects(git(f.source, "rev-parse", "--verify", "MERGE_HEAD"));
  assert.equal(await git(f.source, "ls-files", "--unmerged"), "");
  assert.equal(await git(f.source, "diff", "--cached", "--name-only", "--no-ext-diff"), "");
  await assertNoUnsafeDriver(f);
});

test("aborting an LFS merge never invokes repository-defined drivers or loses conflict data", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "asset_a.uasset"), oursA); await commitFiles(f.source, ["asset_a.uasset"], "fix(test): source conflicting asset");
  await writeFile(path.join(f.target, "asset_a.uasset"), theirsA); const targetHead = await commitFiles(f.target, ["asset_a.uasset"], "fix(test): target conflicting asset");
  await poisonConfiguredDrivers(f);
  const pending = await new MergeWorkflowStore(f.data, async () => ok).prep(f.args);
  assert.equal(pending.state, "needs_resolution");
  assert.ok(pending.prepared_merge);
  try {
    await abortMerge(f.source, pending.prepared_merge!);
    await assert.rejects(git(f.source, "rev-parse", "--verify", "MERGE_HEAD"));
  } catch (error) {
    assert.match(String(error), /lfs|safe|unsupported|abort/i);
    assert.equal(await git(f.source, "rev-parse", "MERGE_HEAD"), targetHead);
    assert.match(await git(f.source, "ls-files", "--unmerged", "--", "asset_a.uasset"), /\b[123]\s+asset_a\.uasset/);
  }
  assert.deepEqual(await readFile(path.join(f.source, "asset_a.uasset")), oursA);
  await assertNoUnsafeDriver(f);
});

test("a signed divergent merge resumes after interruption without replacing its merge operation", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "task.txt"), "source task\n"); await commitFiles(f.source, ["task.txt"], "fix(test): source task");
  await writeFile(path.join(f.target, "asset_b.uasset"), theirsB); const targetHead = await commitFiles(f.target, ["asset_b.uasset"], "fix(test): target asset");
  await poisonConfiguredDrivers(f);
  const store = new MergeWorkflowStore(f.data, async () => ok), hit = interruptOnce(store, "prepared");
  const mergeId = await interruptedId(store, f.args);
  assert.equal(hit(), true);
  const resumed = await new MergeWorkflowStore(f.data, async () => ok).prep({ ...f.args, merge_id: mergeId });
  assert.equal(resumed.merge_id, mergeId);
  assert.equal(resumed.state, "needs_commit");
  assert.equal(await git(f.source, "rev-parse", "MERGE_HEAD"), targetHead);
  assert.deepEqual(await readFile(path.join(f.source, "asset_b.uasset")), theirsB);
  await assertNoUnsafeDriver(f);
});

test("prepared auto-merge objects remain reachable after Git garbage collection", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "shared.txt"), "source first\nsecond\nthird\nfourth\nfifth\n");
  await commitFiles(f.source, ["shared.txt"], "fix(test): source text");
  await writeFile(path.join(f.target, "shared.txt"), "first\nsecond\nthird\nfourth\ntarget fifth\n");
  await writeFile(path.join(f.target, "asset_b.uasset"), theirsB);
  await commitFiles(f.target, ["shared.txt", "asset_b.uasset"], "fix(test): target text and asset");
  const store = new MergeWorkflowStore(f.data, async () => ok); interruptOnce(store, "prepared");
  const mergeId = await interruptedId(store, f.args);
  await git(f.target, "gc", "--prune=now");
  const pending = await new MergeWorkflowStore(f.data, async () => ok).prep({ ...f.args, merge_id: mergeId });
  assert.equal(pending.state, "needs_commit");
  assert.equal(await git(f.source, "show", ":shared.txt"), "source first\nsecond\nthird\nfourth\ntarget fifth");
});

test("recovery refuses a removed merge object retention ref", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "task.txt"), "source task\n"); await commitFiles(f.source, ["task.txt"], "fix(test): source task");
  await writeFile(path.join(f.target, "asset_b.uasset"), theirsB); await commitFiles(f.target, ["asset_b.uasset"], "fix(test): target asset");
  const store = new MergeWorkflowStore(f.data, async () => ok); interruptOnce(store, "prepared");
  const mergeId = await interruptedId(store, f.args);
  const ref = await git(f.target, "for-each-ref", "--format=%(refname)", "refs/captain-sdlc/lfs-merges/");
  assert.match(ref, /^refs\/captain-sdlc\/lfs-merges\/[a-f0-9-]+$/); await git(f.target, "update-ref", "-d", ref);
  await assert.rejects(new MergeWorkflowStore(f.data, async () => ok).prep({ ...f.args, merge_id: mergeId }), /ref|revision|unknown|ambiguous|retention/i);
  await assert.rejects(git(f.source, "rev-parse", "--verify", "MERGE_HEAD"));
  assert.deepEqual(await readFile(path.join(f.source, "asset_b.uasset")), baseB);
});

test("conflicting criss-cross LFS merges fail closed before publication", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "source-base.txt"), "source base\n"); const a = await commitFiles(f.source, ["source-base.txt"], "fix(test): source base");
  await writeFile(path.join(f.target, "target-base.txt"), "target base\n"); const b = await commitFiles(f.target, ["target-base.txt"], "fix(test): target base");
  const left = await git(f.source, "commit-tree", `${a}^{tree}`, "-p", a, "-p", b, "-m", "merge left base");
  const right = await git(f.target, "commit-tree", `${b}^{tree}`, "-p", b, "-p", a, "-m", "merge right base");
  await git(f.source, "update-ref", "refs/heads/task", left, a); await git(f.target, "update-ref", "refs/heads/main", right, b);
  await writeFile(path.join(f.source, "shared.txt"), "source first\nsecond\nthird\nfourth\nfifth\n");
  const sourceHead = await commitFiles(f.source, ["shared.txt"], "fix(test): source text conflict");
  await writeFile(path.join(f.target, "shared.txt"), "target first\nsecond\nthird\nfourth\nfifth\n");
  await commitFiles(f.target, ["shared.txt"], "fix(test): target text conflict");
  const bases = (await git(f.source, "merge-base", "--all", "HEAD", "main")).split(/\r?\n/);
  assert.equal(bases.length, 2);
  await assert.rejects(new MergeWorkflowStore(f.data, async () => ok).prep(f.args), /multiple merge bases/i);
  assert.equal(await git(f.source, "rev-parse", "HEAD"), sourceHead);
  await assert.rejects(git(f.source, "rev-parse", "--verify", "MERGE_HEAD"));
  assert.equal(await readFile(path.join(f.source, "shared.txt"), "utf8"), "source first\nsecond\nthird\nfourth\nfifth\n");
});

test("a foreign edit after interrupted divergent publication is preserved and blocks recovery", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "task.txt"), "source task\n"); const sourceHead = await commitFiles(f.source, ["task.txt"], "fix(test): source task");
  await writeFile(path.join(f.target, "A-incoming.txt"), "incoming\n");
  await writeFile(path.join(f.target, "asset_b.uasset"), theirsB);
  const targetHead = await commitFiles(f.target, ["A-incoming.txt", "asset_b.uasset"], "fix(test): target changes");
  await poisonConfiguredDrivers(f);
  const store = new MergeWorkflowStore(f.data, async () => ok), hit = interruptOnce(store, "file");
  const mergeId = await interruptedId(store, f.args);
  assert.equal(hit(), true);
  const file = path.join(f.source, "A-incoming.txt"), foreign = "foreign user edit\n";
  await writeFile(file, foreign);
  await assert.rejects(new MergeWorkflowStore(f.data, async () => ok).prep({ ...f.args, merge_id: mergeId }), /user|conflict|changed|diverg/i);
  assert.equal(await readFile(file, "utf8"), foreign);
  assert.equal(await git(f.source, "rev-parse", "HEAD"), sourceHead);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), targetHead);
  await assertNoUnsafeDriver(f);
});

test("an unrelated Git operation appearing during LFS merge recovery blocks publication", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "task.txt"), "source task\n"); await commitFiles(f.source, ["task.txt"], "fix(test): source task");
  await writeFile(path.join(f.target, "asset_b.uasset"), theirsB); const targetHead = await commitFiles(f.target, ["asset_b.uasset"], "fix(test): target asset");
  const store = new MergeWorkflowStore(f.data, async () => ok); interruptOnce(store, "prepared");
  const mergeId = await interruptedId(store, f.args);
  const operation = await git(f.source, "rev-parse", "--path-format=absolute", "--git-path", "CHERRY_PICK_HEAD");
  await writeFile(operation, `${targetHead}\n`);
  await assert.rejects(new MergeWorkflowStore(f.data, async () => ok).prep({ ...f.args, merge_id: mergeId }), /preexisting Git operation CHERRY_PICK_HEAD/i);
  assert.equal(await readFile(operation, "utf8"), `${targetHead}\n`);
  await assert.rejects(git(f.source, "rev-parse", "--verify", "MERGE_HEAD"));
});

test("an unrelated source edit after merge planning blocks recovery and is preserved", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "task.txt"), "source task\n"); await commitFiles(f.source, ["task.txt"], "fix(test): source task");
  await writeFile(path.join(f.target, "asset_b.uasset"), theirsB); await commitFiles(f.target, ["asset_b.uasset"], "fix(test): target asset");
  const store = new MergeWorkflowStore(f.data, async () => ok); interruptOnce(store, "prepared");
  const mergeId = await interruptedId(store, f.args), foreign = "foreign source edit\n";
  await writeFile(path.join(f.source, "task.txt"), foreign);
  await assert.rejects(new MergeWorkflowStore(f.data, async () => ok).prep({ ...f.args, merge_id: mergeId }), /user|source|changed|diverg/i);
  assert.equal(await readFile(path.join(f.source, "task.txt"), "utf8"), foreign);
  await assert.rejects(git(f.source, "rev-parse", "--verify", "MERGE_HEAD"));
});

test("a changed binary conflict input after merge planning is preserved and blocks recovery", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "asset_a.uasset"), oursA); await commitFiles(f.source, ["asset_a.uasset"], "fix(test): source asset");
  await writeFile(path.join(f.target, "asset_a.uasset"), theirsA); await commitFiles(f.target, ["asset_a.uasset"], "fix(test): target asset");
  const store = new MergeWorkflowStore(f.data, async () => ok); interruptOnce(store, "prepared");
  const mergeId = await interruptedId(store, f.args);
  await writeFile(path.join(f.source, "asset_a.uasset"), resolvedA);
  await assert.rejects(new MergeWorkflowStore(f.data, async () => ok).prep({ ...f.args, merge_id: mergeId }), /user|conflict|changed|diverg/i);
  assert.deepEqual(await readFile(path.join(f.source, "asset_a.uasset")), resolvedA);
  await assert.rejects(git(f.source, "rev-parse", "--verify", "MERGE_HEAD"));
});

test("an ignored source-manifest input edited during recovery is preserved and blocks publication", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, ".gitignore"), ".captain-sdlc/worktrees/\nhidden-input.dat\n");
  await writeFile(path.join(f.source, "task.txt"), "source task\n"); await commitFiles(f.source, ["task.txt", ".gitignore"], "fix(test): source task");
  const input = path.join(f.source, "hidden-input.dat"); await writeFile(input, "initial\n");
  await writeFile(path.join(f.target, "asset_b.uasset"), theirsB); await commitFiles(f.target, ["asset_b.uasset"], "fix(test): target asset");
  const store = new MergeWorkflowStore(f.data, async () => ok); interruptOnce(store, "prepared");
  const mergeId = await interruptedId(store, f.args); await writeFile(input, "foreign ignored input\n");
  await assert.rejects(new MergeWorkflowStore(f.data, async () => ok).prep({ ...f.args, merge_id: mergeId }), /source|input|changed|diverg/i);
  assert.equal(await readFile(input, "utf8"), "foreign ignored input\n");
  await assert.rejects(git(f.source, "rev-parse", "--verify", "MERGE_HEAD"));
});

test("a tracked file under a normally excluded directory cannot change during merge recovery", async t => {
  const f = await fixture(t), file = path.join(f.source, "node_modules", "tracked.txt");
  await mkdir(path.dirname(file)); await writeFile(file, "tracked source\n");
  await git(f.source, "add", "-f", "node_modules/tracked.txt"); await git(f.source, "commit", "-m", "fix(test): track excluded directory input");
  await writeFile(path.join(f.target, "asset_b.uasset"), theirsB); await commitFiles(f.target, ["asset_b.uasset"], "fix(test): target asset");
  const store = new MergeWorkflowStore(f.data, async () => ok); interruptOnce(store, "prepared");
  const mergeId = await interruptedId(store, f.args); await writeFile(file, "foreign tracked input\n");
  await assert.rejects(new MergeWorkflowStore(f.data, async () => ok).prep({ ...f.args, merge_id: mergeId }), /source|input|changed|diverg/i);
  assert.equal(await readFile(file, "utf8"), "foreign tracked input\n");
  await assert.rejects(git(f.source, "rev-parse", "--verify", "MERGE_HEAD"));
});

test("an untracked nonignored file under a skipped directory blocks merge recovery", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "task.txt"), "source task\n"); await commitFiles(f.source, ["task.txt"], "fix(test): source task");
  await writeFile(path.join(f.target, "asset_b.uasset"), theirsB); await commitFiles(f.target, ["asset_b.uasset"], "fix(test): target asset");
  const store = new MergeWorkflowStore(f.data, async () => ok); interruptOnce(store, "prepared");
  const mergeId = await interruptedId(store, f.args), directory = path.join(f.source, "node_modules");
  await mkdir(directory); const file = path.join(directory, "foreign.txt"); await writeFile(file, "foreign untracked input\n");
  await assert.rejects(new MergeWorkflowStore(f.data, async () => ok).prep({ ...f.args, merge_id: mergeId }), /source|input|changed|diverg/i);
  assert.equal(await readFile(file, "utf8"), "foreign untracked input\n");
  await assert.rejects(git(f.source, "rev-parse", "--verify", "MERGE_HEAD"));
});

test("approved generated outputs may change during merge recovery", async t => {
  const f = await fixture(t), policyFile = path.join(f.source, ".captain-sdlc", "codex-policy.json");
  const policy = JSON.parse(await readFile(policyFile, "utf8")); policy.sourceManifestExcludes = ["Library"];
  await writeFile(policyFile, JSON.stringify(policy)); await writeFile(path.join(f.source, "task.txt"), "source task\n");
  await commitFiles(f.source, ["task.txt", ".captain-sdlc/codex-policy.json"], "fix(test): source task and output policy");
  await writeFile(path.join(f.target, "asset_b.uasset"), theirsB); await commitFiles(f.target, ["asset_b.uasset"], "fix(test): target asset");
  const store = new MergeWorkflowStore(f.data, async () => ok); interruptOnce(store, "prepared");
  const mergeId = await interruptedId(store, f.args), directory = path.join(f.source, "Library");
  await mkdir(directory); await writeFile(path.join(directory, "generated.bin"), "generated output\n");
  const pending = await new MergeWorkflowStore(f.data, async () => ok).prep({ ...f.args, merge_id: mergeId });
  assert.equal(pending.state, "needs_commit");
});

test("Prep rejects LFS storage configured only for the target worktree", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "asset_a.uasset"), oursA); await commitFiles(f.source, ["asset_a.uasset"], "fix(test): source LFS asset");
  await git(f.target, "config", "--local", "extensions.worktreeConfig", "true");
  await git(f.target, "config", "--worktree", "lfs.storage", path.join(f.container, "other-lfs"));
  const store = new MergeWorkflowStore(f.data, async () => ok);
  await assert.rejects(store.prep(f.args), /lfs\.storage|lfs storage/i);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.base);
  assert.deepEqual(await readFile(path.join(f.target, "asset_a.uasset")), baseA);
});

test("a target-only LFS storage change invalidates signed readiness", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.source, "asset_a.uasset"), oursA); await commitFiles(f.source, ["asset_a.uasset"], "fix(test): source LFS asset");
  await git(f.target, "config", "--local", "extensions.worktreeConfig", "true");
  const store = new MergeWorkflowStore(f.data, async () => ok), ready = await store.prep(f.args);
  assert.equal(ready.state, "ready"); assert.equal(ready.receipt_valid, true);
  await git(f.target, "config", "--worktree", "lfs.storage", path.join(f.container, "other-lfs"));
  const status = await store.status({ merge_id: ready.merge_id, session_id: f.args.session_id });
  assert.equal(status.receipt_valid, false);
  await assert.rejects(store.back({ merge_id: ready.merge_id, session_id: f.args.session_id }), /lfs\.storage|lfs storage|stale|input/i);
  assert.equal(await git(f.target, "rev-parse", "HEAD"), f.base);
  assert.deepEqual(await readFile(path.join(f.target, "asset_a.uasset")), baseA);
});
