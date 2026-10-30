import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, cp, mkdir, mkdtemp, readFile, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { assertWorktreeBinding, ensureWorktree, git, repositoryIdentity, sourceState } from "../src/workspace.js";
import { listIndexedLfs, safeGitDiffHeadRaw, safeGitDiffNames, safeGitDiffRaw, safeGitStatus, safeGitUnmergedNames, withShadowGit } from "../src/git-safe-status.js";

const exec = promisify(execFile);
const fixtureEnv: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
for (const key of Object.keys(fixtureEnv)) {
  if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|CONFIG_COUNT|CONFIG_PARAMETERS|CONFIG_(?:KEY|VALUE)_\d+)$/i.test(key)) delete fixtureEnv[key];
}
const runGit = (cwd: string, ...args: string[]) => exec("git", args, { cwd, env: fixtureEnv, windowsHide: true });
async function exists(file: string) { try { await access(file); return true; } catch (error: any) { if (error.code === "ENOENT") return false; throw error; } }

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "captain-lfs-security-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith("captain-lfs-security-"));
    await rm(root, { recursive: true, force: true });
  });
  await runGit(root, "init", "-b", "main");
  await runGit(root, "config", "user.name", "Captain Test");
  await runGit(root, "config", "user.email", "captain@example.invalid");
  await runGit(root, "config", "core.autocrlf", "false");
  return root;
}

type AttributeLocation = "committed" | "metadata" | "nested";
async function hostileFixture(t: TestContext, driver: "lfs" | "alien", kind: "clean" | "process", location: AttributeLocation) {
  const root = await fixture(t), relative = location === "nested" ? "nested/asset.dat" : "asset.dat";
  if (location === "nested") await mkdir(path.join(root, "nested"));
  await writeFile(path.join(root, relative), "base0000");
  if (location === "committed") await writeFile(path.join(root, ".gitattributes"), `*.dat filter=${driver}\n`);
  await runGit(root, "add", ".");
  await runGit(root, "commit", "-m", "fixture before hostile local driver");
  if (location === "metadata") await writeFile(path.join(root, ".git", "info", "attributes"), `*.dat filter=${driver}\n`);
  if (location === "nested") await writeFile(path.join(root, "nested", ".gitattributes"), `*.dat filter=${driver}\n`);
  const marker = `marker-${driver}-${kind}-${location}`;
  // This command only writes inside the disposable fixture; it acts as an execution witness.
  const command = kind === "process" ? `echo CALLED > ${marker}; exit 1` : `echo CALLED > ${marker}; cat`;
  await runGit(root, "config", `filter.${driver}.${kind}`, command);
  await writeFile(path.join(root, relative), "edit0000");
  await utimes(path.join(root, relative), new Date("2010-01-01T00:00:00Z"), new Date("2010-01-01T00:00:00Z"));
  return { root, relative, marker: path.join(root, marker), command };
}

for (const scenario of [
  { driver: "lfs", kind: "clean", location: "committed" },
  { driver: "lfs", kind: "process", location: "committed" },
  { driver: "alien", kind: "clean", location: "committed" },
  { driver: "alien", kind: "clean", location: "metadata" },
  { driver: "alien", kind: "clean", location: "nested" },
] as const) {
  test(`binding and status never execute ${scenario.location} ${scenario.driver} ${scenario.kind} driver`, async t => {
    const f = await hostileFixture(t, scenario.driver, scenario.kind, scenario.location);
    // The input is dirty or unsafe, so refusing it is permitted. Executing its driver is not.
    try { await assertWorktreeBinding(f.root, undefined, undefined, undefined, true); } catch { /* fail closed */ }
    assert.equal(await exists(f.marker), false, "Captain's binding/status executed repository-defined code");

    // Confirm this exact fixture is capable of exposing the vulnerability with ordinary Git.
    await runGit(f.root, "config", `filter.${scenario.driver}.${scenario.kind}`, f.command);
    await writeFile(path.join(f.root, f.relative), "edit1111");
    await utimes(path.join(f.root, f.relative), new Date("2010-01-02T00:00:00Z"), new Date("2010-01-02T00:00:00Z"));
    try { await runGit(f.root, "status", "--porcelain"); } catch { /* hostile process may exit nonzero */ }
    assert.equal(await exists(f.marker), true, "control: ordinary Git did not execute the configured test driver");
  });
}

for (const kind of ["clean", "process"] as const) {
  test(`binding does not execute hostile LFS ${kind} with a real pointer and hydrated asset`, async t => {
    const root = await fixture(t), relative = "fixture.asset", marker = path.join(root, `real-lfs-${kind}-marker`);
    await runGit(root, "lfs", "install", "--local");
    await writeFile(path.join(root, ".gitattributes"), "*.asset filter=lfs diff=lfs merge=lfs -text\n");
    await writeFile(path.join(root, relative), "asset-abc");
    await runGit(root, "add", ".");
    await runGit(root, "commit", "-m", "real LFS asset before hostile local driver");
    assert.match((await runGit(root, "show", `HEAD:${relative}`)).stdout, /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/);
    // Git prefers a process driver over clean; remove the real one for the clean case.
    if (kind === "clean") await runGit(root, "config", "--unset-all", "filter.lfs.process");
    const command = kind === "process" ? `echo CALLED > real-lfs-${kind}-marker; exit 1` : `echo CALLED > real-lfs-${kind}-marker; cat`;
    await runGit(root, "config", `filter.lfs.${kind}`, command);
    await writeFile(path.join(root, relative), "asset-xyz");
    await utimes(path.join(root, relative), new Date("2010-01-01T00:00:00Z"), new Date("2010-01-01T00:00:00Z"));
    try { await assertWorktreeBinding(root, undefined, undefined, undefined, true); } catch { /* fail closed */ }
    assert.equal(await exists(marker), false, "Captain executed the configured LFS driver");

    await runGit(root, "config", `filter.lfs.${kind}`, command);
    await writeFile(path.join(root, relative), "asset-123");
    await utimes(path.join(root, relative), new Date("2010-01-02T00:00:00Z"), new Date("2010-01-02T00:00:00Z"));
    try { await runGit(root, "status", "--porcelain"); } catch { /* hostile process may exit nonzero */ }
    assert.equal(await exists(marker), true, "control: ordinary Git did not execute the configured LFS driver");
  });
}

test("Unicode nested Git attributes are inspected before identity and worktree creation", async t => {
  const root = await fixture(t), nested = path.join(root, "资料"), marker = path.join(root, "unicode-marker");
  await mkdir(nested);
  await writeFile(path.join(nested, ".gitattributes"), "*.dat filter=alien\n");
  await writeFile(path.join(nested, "fixture.dat"), "asset\n");
  await runGit(root, "add", "."); await runGit(root, "commit", "-m", "Unicode nested attribute fixture");
  // Default Git display quotes this path, so splitting line-oriented output is unsafe.
  assert.match((await runGit(root, "ls-tree", "-r", "--name-only", "HEAD")).stdout, /\\[0-7]{3}/);
  await runGit(root, "config", "filter.alien.clean", "echo CALLED > unicode-marker; cat");
  const head = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  await assert.rejects(() => repositoryIdentity(root), /clean filters|merge drivers/);
  await assert.rejects(() => ensureWorktree(root, head, "unicode-check"), /clean filters|merge drivers/);
  assert.equal(await exists(marker), false);
});

test("isolated status inspects a dirty genuine LFS asset without invoking its hostile process driver", async t => {
  const root = await fixture(t), marker = path.join(root, "status-marker");
  await runGit(root, "lfs", "install", "--local");
  await writeFile(path.join(root, ".gitattributes"), "*.asset filter=lfs diff=lfs merge=lfs -text\n");
  await writeFile(path.join(root, "fixture.asset"), "asset-abc");
  await runGit(root, "add", "."); await runGit(root, "commit", "-m", "real LFS asset");
  const head = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  await runGit(root, "config", "filter.lfs.process", "echo CALLED > status-marker; exit 1");
  await writeFile(path.join(root, "fixture.asset"), "asset-xyz");
  await utimes(path.join(root, "fixture.asset"), new Date("2010-01-01T00:00:00Z"), new Date("2010-01-01T00:00:00Z"));
  // Captain's historical Git adapter trims the leading porcelain space.
  assert.match(await safeGitStatus(root, git), /^M fixture\.asset$/m);
  assert.equal(await safeGitDiffNames(root, git), "fixture.asset");
  assert.deepEqual(await safeGitDiffRaw(root, git, head), Buffer.from("fixture.asset\0"));
  assert.deepEqual(await safeGitDiffHeadRaw(root, git), Buffer.from("fixture.asset\0"));
  assert.equal(await exists(marker), false);
});

test("isolated working-tree diff never executes a metadata clean filter", async t => {
  const f = await hostileFixture(t, "alien", "clean", "metadata");
  const head = (await runGit(f.root, "rev-parse", "HEAD")).stdout.trim();
  try { await safeGitDiffNames(f.root, git); } catch { /* unsupported filter fails closed */ }
  await assert.rejects(() => safeGitDiffRaw(f.root, git, head), /unsupported Git clean filter/);
  await assert.rejects(() => safeGitDiffHeadRaw(f.root, git), /unsupported Git clean filter/);
  assert.equal(await exists(f.marker), false, "isolated diff executed a repository-defined driver");
  try { await runGit(f.root, "diff", "--no-ext-diff", "--no-textconv", "--name-only"); } catch { /* control may fail */ }
  assert.equal(await exists(f.marker), true, "control: ordinary diff did not execute the configured driver");
});

test("isolated raw LFS diff preserves NUL-delimited Unicode paths", async t => {
  const root = await fixture(t), relative = "资料.asset", asset = path.join(root, relative), marker = path.join(root, "raw-marker");
  await runGit(root, "lfs", "install", "--local");
  await writeFile(path.join(root, ".gitattributes"), "*.asset filter=lfs diff=lfs merge=lfs -text\n");
  await writeFile(asset, "asset-abc"); await runGit(root, "add", "."); await runGit(root, "commit", "-m", "Unicode LFS fixture");
  const head = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  await runGit(root, "config", "filter.lfs.process", "echo CALLED > raw-marker; exit 1");
  await writeFile(asset, "asset-xyz");
  await utimes(asset, new Date("2010-01-01T00:00:00Z"), new Date("2010-01-01T00:00:00Z"));
  assert.deepEqual(await safeGitDiffRaw(root, git, head), Buffer.from(`${relative}\0`));
  assert.equal(await exists(marker), false);
});

test("isolated status preserves genuine LFS staging, dash names, rename, and untracked files", async t => {
  const root = await fixture(t);
  await runGit(root, "lfs", "install", "--local");
  await writeFile(path.join(root, ".gitattributes"), "*.asset filter=lfs diff=lfs merge=lfs -text\n");
  await writeFile(path.join(root, "-dash.asset"), "asset-abc");
  await writeFile(path.join(root, "empty.asset"), Buffer.alloc(0));
  await writeFile(path.join(root, "before.txt"), "rename content\n");
  await runGit(root, "add", "."); await runGit(root, "commit", "-m", "fixtures");
  const head = (await runGit(root, "rev-parse", "HEAD")).stdout.trim();
  assert.equal(await safeGitStatus(root, git), "");
  const pointers = await listIndexedLfs(root, git);
  assert.equal(pointers.length, 2);
  assert.equal(pointers.find(item => item.path === "-dash.asset")?.size, 9);
  assert.equal(pointers.find(item => item.path === "empty.asset")?.size, 0);
  await writeFile(path.join(root, "-dash.asset"), "asset-xyz");
  await runGit(root, "add", "--", "-dash.asset");
  await runGit(root, "mv", "--", "before.txt", "after.txt");
  await writeFile(path.join(root, "-untracked.txt"), "untracked\n");
  const expected = (await runGit(root, "status", "--porcelain")).stdout.trim();
  assert.equal(await safeGitDiffNames(root, git), "");
  const expectedRaw = (await runGit(root, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", head, "--")).stdout;
  assert.deepEqual(await safeGitDiffRaw(root, git, head), Buffer.from(expectedRaw));
  assert.equal(await safeGitStatus(root, git), expected);
  assert.match(expected, /^M  -dash\.asset$/m);
  assert.match(expected, /^R  before\.txt -> after\.txt$/m);
  assert.match(expected, /^\?\? -untracked\.txt$/m);
});

test("isolated conflict discovery preserves unmerged paths without invoking drivers", async t => {
  const root = await fixture(t), file = path.join(root, "conflicted.txt");
  await writeFile(file, "base\n"); await runGit(root, "add", "."); await runGit(root, "commit", "-m", "base");
  await runGit(root, "switch", "-c", "topic"); await writeFile(file, "topic\n"); await runGit(root, "commit", "-am", "topic");
  await runGit(root, "switch", "main"); await writeFile(file, "main\n"); await runGit(root, "commit", "-am", "main");
  await assert.rejects(() => runGit(root, "merge", "topic"));
  await writeFile(path.join(root, ".git", "info", "attributes"), "*.txt filter=alien\n");
  await runGit(root, "config", "filter.alien.clean", "echo CALLED > conflict-marker; cat");
  const expected = (await runGit(root, "diff", "--cached", "--name-only", "--diff-filter=U")).stdout.trim();
  assert.equal(expected, "conflicted.txt");
  assert.equal(await safeGitUnmergedNames(root, git), expected);
  assert.match(await safeGitStatus(root, git), /^UU conflicted\.txt$/m);
  assert.match((await sourceState(root)).status, /^UU conflicted\.txt$/m);
  assert.equal(await exists(path.join(root, "conflict-marker")), false);
});

test("isolated status rejects an LFS asset changed after hashing and before return", async t => {
  const root = await fixture(t), asset = path.join(root, "fixture.asset");
  await runGit(root, "lfs", "install", "--local");
  await writeFile(path.join(root, ".gitattributes"), "*.asset filter=lfs diff=lfs merge=lfs -text\n");
  await writeFile(asset, "asset-abc");
  await runGit(root, "add", "."); await runGit(root, "commit", "-m", "race fixture");
  let headChecks = 0;
  const racingGit = async (args: string[], cwd: string) => {
    const result = await git(args, cwd);
    if (args[0] === "rev-parse" && args.includes("HEAD^{commit}") && ++headChecks === 2) {
      await writeFile(asset, "asset-xyz");
      await utimes(asset, new Date("2010-01-01T00:00:00Z"), new Date("2010-01-01T00:00:00Z"));
    }
    return result;
  };
  await assert.rejects(() => safeGitStatus(root, racingGit), /LFS input changed during isolated status/);
  assert.equal(headChecks, 2);
});

test("isolated status preserves safe local rename and path quoting settings", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "资料.txt"), "unchanged content\n");
  await runGit(root, "add", "."); await runGit(root, "commit", "-m", "settings fixture");
  await runGit(root, "config", "core.quotePath", "false");
  await runGit(root, "config", "status.renames", "false");
  await runGit(root, "mv", "--", "资料.txt", "renamed.txt");
  const expected = (await runGit(root, "status", "--porcelain")).stdout.trim();
  assert.equal(await safeGitStatus(root, git), expected);
  assert.match(expected, /^A  renamed\.txt$/m);
  assert.match(expected, /^D  资料\.txt$/m);
});

test("isolated status handles a shared split index", async t => {
  const root = await fixture(t), file = path.join(root, "tracked.txt");
  await writeFile(file, "before\n"); await runGit(root, "add", "."); await runGit(root, "commit", "-m", "split index fixture");
  await runGit(root, "update-index", "--split-index");
  assert.notEqual((await runGit(root, "rev-parse", "--shared-index-path")).stdout.trim(), "");
  assert.equal(await safeGitStatus(root, git), "");
  await writeFile(file, "after\n");
  assert.equal(await safeGitStatus(root, git), (await runGit(root, "status", "--porcelain")).stdout.trim());
});

for (const operation of ["stage", "write", "publish"] as const) {
  test(`isolated Git refuses a replaced object store before ${operation}`, async t => {
    const root = await fixture(t), asset = path.join(root, "fixture.txt"), objects = path.join(root, ".git", "objects");
    const original = path.join(root, ".git", "objects-original"), replacement = path.join(root, ".git", "objects-replacement");
    await writeFile(asset, "baseline\n"); await runGit(root, "add", "."); await runGit(root, "commit", "-m", "object store fixture");
    await writeFile(asset, "modified\n");
    const index = await readFile(path.join(root, ".git", "index"));
    await cp(objects, replacement, { recursive: true });
    await withShadowGit(root, git, async shadow => {
      if (operation === "publish") await shadow.stageFiles(["fixture.txt"]);
      await rename(objects, original); await rename(replacement, objects);
      try {
        const action = operation === "stage" ? () => shadow.stageFiles(["fixture.txt"]) :
          operation === "write" ? () => shadow.writeObject(Buffer.from("new object")) : () => shadow.publishIndex();
        await assert.rejects(action, /Git object store changed/);
      } finally {
        await rename(objects, replacement); await rename(original, objects);
      }
    });
    assert.deepEqual(await readFile(path.join(root, ".git", "index")), index);
    assert.equal(await readFile(asset, "utf8"), "modified\n");
  });
}

test("LFS status honors core.filemode for an executable-bit-only change", async t => {
  const root = await fixture(t), asset = path.join(root, "fixture.asset");
  await runGit(root, "lfs", "install", "--local");
  await runGit(root, "config", "core.filemode", "true");
  await writeFile(path.join(root, ".gitattributes"), "*.asset filter=lfs diff=lfs merge=lfs -text\n");
  await writeFile(asset, "asset-abc");
  await chmod(asset, 0o644);
  await runGit(root, "add", ".");
  // An executable index entry with a non-executable worktree file reproduces
  // a mode-only modification on Windows as well as on POSIX filesystems.
  await runGit(root, "update-index", "--chmod=+x", "--", "fixture.asset");
  await runGit(root, "commit", "-m", "LFS executable mode fixture");
  if ((await runGit(root, "status", "--porcelain")).stdout.trim() !== "M fixture.asset") {
    t.skip("filesystem or Git does not expose executable-bit-only changes");
    return;
  }
  assert.equal(await safeGitStatus(root, git), "M fixture.asset");
  assert.equal(await safeGitDiffNames(root, git), "fixture.asset");
  assert.deepEqual(await safeGitDiffHeadRaw(root, git), Buffer.from("fixture.asset\0"));
  await runGit(root, "config", "core.filemode", "false");
  assert.equal((await runGit(root, "status", "--porcelain")).stdout.trim(), "");
  assert.equal(await safeGitStatus(root, git), "");
  await runGit(root, "config", "--unset", "core.filemode");
  assert.equal((await runGit(root, "status", "--porcelain")).stdout.trim(), "M fixture.asset");
  assert.equal(await safeGitStatus(root, git), "M fixture.asset");
});

test("LFS status cannot hide dirty assets behind index flags", async t => {
  const root = await fixture(t), asset = path.join(root, "fixture.asset");
  await runGit(root, "lfs", "install", "--local");
  await writeFile(path.join(root, ".gitattributes"), "*.asset filter=lfs diff=lfs merge=lfs -text\n");
  await writeFile(asset, "asset-abc"); await runGit(root, "add", "."); await runGit(root, "commit", "-m", "LFS flags fixture");
  await runGit(root, "update-index", "--assume-unchanged", "--", "fixture.asset");
  await writeFile(asset, "asset-xyz");
  await utimes(asset, new Date("2010-01-01T00:00:00Z"), new Date("2010-01-01T00:00:00Z"));
  assert.match(await safeGitStatus(root, git), /^M fixture\.asset$/m);
  await runGit(root, "update-index", "--no-assume-unchanged", "--", "fixture.asset");
  await runGit(root, "update-index", "--skip-worktree", "--", "fixture.asset");
  assert.match(await safeGitStatus(root, git), /^M fixture\.asset$/m);
  assert.match((await runGit(root, "ls-files", "-v", "--", "fixture.asset")).stdout, /^S /);
});

test("tracked non-LFS changes cannot hide behind assume-unchanged or skip-worktree flags", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "assumed.txt"), "base0000");
  await writeFile(path.join(root, "sparse.txt"), "base0000");
  await runGit(root, "add", "."); await runGit(root, "commit", "-m", "hidden input flags");
  await runGit(root, "update-index", "--assume-unchanged", "--", "assumed.txt");
  await runGit(root, "update-index", "--skip-worktree", "--", "sparse.txt");
  const flagsBefore = (await runGit(root, "ls-files", "-v")).stdout;
  await writeFile(path.join(root, "assumed.txt"), "edit0000");
  await writeFile(path.join(root, "sparse.txt"), "edit0000");
  for (const name of ["assumed.txt", "sparse.txt"]) await utimes(path.join(root, name), new Date("2010-01-01T00:00:00Z"), new Date("2010-01-01T00:00:00Z"));
  assert.equal((await runGit(root, "status", "--porcelain")).stdout.trim(), "", "control: normal Git honors the hiding flags");
  const status = await safeGitStatus(root, git);
  assert.match(status, /^M assumed\.txt$/m);
  assert.match(status, /^ M sparse\.txt$/m);
  const diff = await safeGitDiffNames(root, git);
  assert.match(diff, /^assumed\.txt$/m); assert.match(diff, /^sparse\.txt$/m);
  assert.equal((await runGit(root, "ls-files", "-v")).stdout, flagsBefore, "the real index flags remain unchanged");
});

test("isolated status preserves Git's racy-clean protection when copying an index", async t => {
  const root = await fixture(t), file = path.join(root, "racy.txt"), index = path.join(root, ".git", "index"), old = new Date("2020-01-01T00:00:00Z");
  await runGit(root, "config", "core.trustctime", "false");
  await runGit(root, "config", "core.checkStat", "minimal");
  await writeFile(file, "base0000"); await utimes(file, old, old);
  await runGit(root, "add", "."); await runGit(root, "commit", "-m", "racy index fixture");
  await writeFile(file, "edit0000"); await utimes(file, old, old); await utimes(index, old, old);
  assert.match((await runGit(root, "--no-optional-locks", "status", "--porcelain")).stdout.trim(), /^M racy\.txt$/m);
  assert.match(await safeGitStatus(root, git), /^M racy\.txt$/m);
  assert.equal(await safeGitDiffNames(root, git), "racy.txt");
  await writeFile(file, "stage000"); await utimes(file, old, old); await runGit(root, "add", "--", "racy.txt");
  await writeFile(file, "other000"); await utimes(file, old, old); await utimes(index, old, old);
  assert.match((await runGit(root, "--no-optional-locks", "status", "--porcelain")).stdout.trim(), /^MM racy\.txt$/m);
  assert.match(await safeGitStatus(root, git), /^MM racy\.txt$/m);
  assert.equal(await safeGitDiffNames(root, git), "racy.txt");
});

test("repository identity and source state support real hydrated Git LFS assets", async t => {
  const root = await fixture(t), bytes = Buffer.from("portable synthetic game asset\n");
  await runGit(root, "lfs", "install", "--local");
  await writeFile(path.join(root, ".gitattributes"), "*.asset filter=lfs diff=lfs merge=lfs -text\n");
  await writeFile(path.join(root, "fixture.asset"), bytes);
  await runGit(root, "add", ".");
  await runGit(root, "commit", "-m", "fixture with genuine Git LFS asset");
  const pointer = (await runGit(root, "show", "HEAD:fixture.asset")).stdout;
  assert.match(pointer, /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/);
  assert.match(pointer, new RegExp(`oid sha256:${createHash("sha256").update(bytes).digest("hex")}`));
  assert.deepEqual(await readFile(path.join(root, "fixture.asset")), bytes);

  const identity = await repositoryIdentity(root);
  assert.equal(identity.projectRoot, path.resolve(root));
  const clean = await sourceState(root);
  assert.equal(clean.status, "");
  await writeFile(path.join(root, "fixture.asset"), Buffer.from("portable changed game asset!!\n"));
  const dirty = await sourceState(root);
  assert.match(dirty.status, /fixture\.asset/);
  assert.notEqual(dirty.manifest, clean.manifest);
});
