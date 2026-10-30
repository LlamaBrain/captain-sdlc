import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { stageLfsSelection } from "../src/git-lfs-stage.js";
import { git as captainGit } from "../src/workspace.js";

const exec = promisify(execFile);
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0" };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS", "GIT_LFS_SKIP_SMUDGE"]) delete env[key];
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, env, windowsHide: true })).stdout.trim();
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const baseline = Buffer.from(Array.from({ length: 513 }, (_, i) => (i * 13) % 256));
const modified = Buffer.from(Array.from({ length: 513 }, (_, i) => (i * 31 + 3) % 256));
const added = Buffer.from("new binary asset\0\xff", "latin1");

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "captain-lfs-stage-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(tmpdir())); assert.ok(path.basename(root).startsWith("captain-lfs-stage-")); await rm(root, { recursive: true, force: true }); });
  await git(root, "init", "-b", "main");
  await git(root, "config", "user.name", "Captain Test"); await git(root, "config", "user.email", "captain@example.invalid");
  await git(root, "config", "core.autocrlf", "false"); await git(root, "lfs", "install", "--local");
  await writeFile(path.join(root, ".gitattributes"), "*.uasset filter=lfs diff=lfs merge=lfs -text\n*.txt text eol=lf\n");
  await mkdir(path.join(root, "assets"));
  await writeFile(path.join(root, "assets", "changed.uasset"), baseline);
  if (process.platform !== "win32") await chmod(path.join(root, "assets", "changed.uasset"), 0o755);
  await writeFile(path.join(root, "assets", "deleted.uasset"), baseline);
  await writeFile(path.join(root, "assets", "plain.txt"), "original\n");
  await writeFile(path.join(root, "other.txt"), "baseline\n");
  await git(root, "add", ".");
  await git(root, "update-index", "--chmod=+x", "assets/changed.uasset");
  await git(root, "commit", "-m", "fixture baseline");
  return root;
}
async function hostileLfsFilter(root: string) {
  const program = path.join(root, "malicious-filter.cjs"), marker = path.join(root, "FILTER_EXECUTED");
  await writeFile(program, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed');process.exit(1);`);
  const command = `"${process.execPath.replaceAll("\\", "/")}" "${program.replaceAll("\\", "/")}"`;
  await git(root, "config", "filter.lfs.process", command);
  await git(root, "config", "filter.lfs.clean", command);
  await git(root, "config", "filter.lfs.smudge", command);
  return marker;
}
async function indexBytes(root: string) { return readFile(path.resolve(root, await git(root, "rev-parse", "--git-path", "index"))); }
async function assertNoMarker(marker: string) { await assert.rejects(readFile(marker), (error: any) => error.code === "ENOENT"); }

async function conflictingAssets(root: string) {
  await git(root, "switch", "-c", "topic");
  await writeFile(path.join(root, "assets", "changed.uasset"), modified);
  await writeFile(path.join(root, "assets", "plain.txt"), "topic\n");
  await git(root, "add", "assets"); await git(root, "commit", "-m", "topic changes");
  await git(root, "switch", "main");
  await writeFile(path.join(root, "assets", "changed.uasset"), added);
  await writeFile(path.join(root, "assets", "plain.txt"), "main\n");
  await git(root, "add", "assets"); await git(root, "commit", "-m", "main changes");
  await assert.rejects(git(root, "merge", "topic"));
  const conflicts = (await git(root, "diff", "--name-only", "--diff-filter=U")).split("\n").sort();
  assert.deepEqual(conflicts, ["assets/changed.uasset", "assets/plain.txt"]);
}

test("conflict staging refuses unselected unresolved paths without changing the index", async t => {
  const root = await fixture(t); await conflictingAssets(root);
  await writeFile(path.join(root, "assets", "plain.txt"), "resolved text\n");
  const marker = await hostileLfsFilter(root), before = await indexBytes(root);
  await assert.rejects(stageLfsSelection(root, ["assets/plain.txt"], captainGit), /unselected.*conflict|conflict.*unselected/i);
  assert.deepEqual(await indexBytes(root), before);
  await assertNoMarker(marker);
});

test("explicit regular LFS and text conflict resolutions stage safely", async t => {
  const root = await fixture(t); await conflictingAssets(root);
  const resolved = Buffer.from("resolved real LFS conflict\0\xff", "latin1"), asset = path.join(root, "assets", "changed.uasset");
  await writeFile(path.join(root, "assets", "plain.txt"), "resolved text\n");
  await writeFile(asset, resolved);
  const marker = await hostileLfsFilter(root), selected = ["assets/changed.uasset", "assets/plain.txt"];
  await stageLfsSelection(root, selected, captainGit);
  await assertNoMarker(marker);
  assert.equal(await git(root, "ls-files", "-u"), "");
  assert.equal(await git(root, "show", ":assets/plain.txt"), "resolved text");
  const pointer = await git(root, "show", ":assets/changed.uasset");
  assert.match(pointer, new RegExp(`oid sha256:${hash(resolved)}\\nsize ${resolved.length}`));
  const object = path.join(root, ".git", "lfs", "objects", hash(resolved).slice(0, 2), hash(resolved).slice(2, 4), hash(resolved));
  assert.deepEqual(await readFile(object), resolved);
});

test("explicit deletion resolves LFS and ordinary modify/delete conflicts safely", async t => {
  const root = await fixture(t);
  await git(root, "switch", "-c", "delete-side");
  await unlink(path.join(root, "assets", "deleted.uasset")); await unlink(path.join(root, "assets", "plain.txt"));
  await git(root, "add", "-u", "assets"); await git(root, "commit", "-m", "delete assets");
  await git(root, "switch", "main");
  await writeFile(path.join(root, "assets", "deleted.uasset"), modified); await writeFile(path.join(root, "assets", "plain.txt"), "modified\n");
  await git(root, "add", "assets"); await git(root, "commit", "-m", "modify assets");
  await assert.rejects(git(root, "merge", "delete-side"));
  assert.deepEqual((await git(root, "diff", "--name-only", "--diff-filter=U")).split("\n").sort(), ["assets/deleted.uasset", "assets/plain.txt"]);
  await unlink(path.join(root, "assets", "deleted.uasset")); await unlink(path.join(root, "assets", "plain.txt"));
  const marker = await hostileLfsFilter(root);
  await stageLfsSelection(root, ["assets/deleted.uasset", "assets/plain.txt"], captainGit);
  assert.equal(await git(root, "ls-files", "-u"), "");
  await assert.rejects(git(root, "show", ":assets/deleted.uasset"));
  await assert.rejects(git(root, "show", ":assets/plain.txt"));
  assert.match(await git(root, "diff", "--cached", "--name-status"), /D\s+assets\/deleted\.uasset/);
  await assertNoMarker(marker);
});

test("ordinary symlink staging records the link without following it", async t => {
  const root = await fixture(t), file = path.join(root, "assets", "ordinary-link");
  await unlink(path.join(root, ".gitattributes")); await git(root, "add", "-u", ".gitattributes"); await git(root, "commit", "-m", "use ordinary Git");
  try { await symlink("../other.txt", file, "file"); }
  catch (error: any) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip(`creating symlinks is unavailable: ${error.code}`); throw error; }
  await git(root, "config", "core.symlinks", "true");
  const marker = await hostileLfsFilter(root);
  await stageLfsSelection(root, ["assets/ordinary-link"], captainGit);
  assert.match(await git(root, "ls-files", "--stage", "--", "assets/ordinary-link"), /^120000 /);
  assert.equal(await git(root, "show", ":assets/ordinary-link"), "../other.txt");
  assert.equal(await readlink(file), "../other.txt");
  await assertNoMarker(marker);
});

test("an LFS-filtered symlink is refused without changing the index", async t => {
  const root = await fixture(t), file = path.join(root, "assets", "unsafe.uasset");
  try { await symlink("../other.txt", file, "file"); }
  catch (error: any) { if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) return t.skip(`creating symlinks is unavailable: ${error.code}`); throw error; }
  const before = await indexBytes(root), marker = await hostileLfsFilter(root);
  await assert.rejects(stageLfsSelection(root, ["assets/unsafe.uasset"], captainGit), /lfs|symlink|regular/i);
  assert.deepEqual(await indexBytes(root), before); await assertNoMarker(marker);
});

test("ordinary tracked submodules stage their checked-out commit without filters", async t => {
  const root = await fixture(t), external = await mkdtemp(path.join(tmpdir(), "captain-lfs-submodule-"));
  t.after(async () => { assert.equal(path.dirname(external), path.resolve(tmpdir())); assert.ok(path.basename(external).startsWith("captain-lfs-submodule-")); await rm(external, { recursive: true, force: true }); });
  await unlink(path.join(root, ".gitattributes")); await git(root, "add", "-u", ".gitattributes"); await git(root, "commit", "-m", "use ordinary Git");
  await git(external, "init", "-b", "main"); await git(external, "config", "user.name", "Captain Test"); await git(external, "config", "user.email", "captain@example.invalid");
  await writeFile(path.join(external, "file.txt"), "initial\n"); await git(external, "add", "."); await git(external, "commit", "-m", "initial submodule");
  await git(root, "-c", "protocol.file.allow=always", "submodule", "add", external, "vendor/plugin"); await git(root, "commit", "-m", "add submodule");
  const nested = path.join(root, "vendor", "plugin");
  await git(nested, "config", "user.name", "Captain Test"); await git(nested, "config", "user.email", "captain@example.invalid");
  await writeFile(path.join(nested, "file.txt"), "next\n"); await git(nested, "add", "."); await git(nested, "commit", "-m", "submodule update");
  const head = await git(nested, "rev-parse", "HEAD"), marker = await hostileLfsFilter(root);
  await stageLfsSelection(root, ["vendor/plugin"], captainGit);
  assert.match(await git(root, "ls-files", "--stage", "--", "vendor/plugin"), new RegExp(`^160000 ${head} 0\\s+vendor/plugin$`));
  await assertNoMarker(marker);
});

test("stage selected LFS assets as pointers without executing configured filters", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "other.txt"), "already staged\n");
  await git(root, "add", "other.txt");
  await writeFile(path.join(root, "assets", "changed.uasset"), modified);
  await writeFile(path.join(root, "assets", "new file.uasset"), added);
  await unlink(path.join(root, "assets", "deleted.uasset"));
  await writeFile(path.join(root, "assets", "plain.txt"), "first\r\nsecond\r\n");
  const marker = await hostileLfsFilter(root);
  await stageLfsSelection(root, ["assets"], captainGit);
  await assertNoMarker(marker);
  const changedPointer = await git(root, "show", ":assets/changed.uasset");
  const addedPointer = await git(root, "show", ":assets/new file.uasset");
  assert.match(changedPointer, new RegExp(`^version https://git-lfs.github.com/spec/v1\\noid sha256:${hash(modified)}\\nsize ${modified.length}$`));
  assert.match(addedPointer, new RegExp(`^version https://git-lfs.github.com/spec/v1\\noid sha256:${hash(added)}\\nsize ${added.length}$`));
  assert.equal(await git(root, "show", ":assets/plain.txt"), "first\nsecond", "normal Git text conversion remains active");
  await assert.rejects(git(root, "show", ":assets/deleted.uasset"));
  assert.equal(await git(root, "show", ":other.txt"), "already staged", "unrelated pre-existing staged content is retained");
  assert.match(await git(root, "ls-files", "--stage", "--", "assets/changed.uasset"), /^100755 /, "existing executable bit remains in the index");
  const object = path.join(root, ".git", "lfs", "objects", hash(modified).slice(0, 2), hash(modified).slice(2, 4), hash(modified));
  assert.deepEqual(await readFile(object), modified);
});

test("LFS staging respects an intentional executable-bit change when core.filemode is true", { skip: process.platform === "win32" }, async t => {
  const root = await fixture(t), file = path.join(root, "assets", "changed.uasset");
  await chmod(file, 0o644); await writeFile(file, modified);
  const marker = await hostileLfsFilter(root);
  await stageLfsSelection(root, ["assets/changed.uasset"], captainGit);
  assert.match(await git(root, "ls-files", "--stage", "--", "assets/changed.uasset"), /^100644 /);
  await assertNoMarker(marker);
});

test("empty LFS assets are staged using Git LFS empty-file passthrough", async t => {
  const root = await fixture(t), file = path.join(root, "assets", "empty.uasset");
  await writeFile(file, Buffer.alloc(0));
  await stageLfsSelection(root, ["assets/empty.uasset"], captainGit);
  assert.equal(await git(root, "cat-file", "-s", ":assets/empty.uasset"), "0");
});

test("object corruption fails without changing the real index", async t => {
  const root = await fixture(t);
  await writeFile(path.join(root, "assets", "changed.uasset"), modified);
  const oid = hash(modified), objectDir = path.join(root, ".git", "lfs", "objects", oid.slice(0, 2), oid.slice(2, 4));
  await mkdir(objectDir, { recursive: true }); await writeFile(path.join(objectDir, oid), Buffer.alloc(modified.length, 9));
  const before = await indexBytes(root), marker = await hostileLfsFilter(root);
  await assert.rejects(stageLfsSelection(root, ["assets/changed.uasset"], captainGit), /lfs|object|integrity|hash|digest|checksum/i);
  assert.deepEqual(await indexBytes(root), before);
  await assertNoMarker(marker);
});

test("unhydrated pointer content is not silently staged as a new binary asset", async t => {
  const root = await fixture(t), pointer = await git(root, "show", "HEAD:assets/changed.uasset");
  await writeFile(path.join(root, "assets", "changed.uasset"), `${pointer}\n`);
  const before = await indexBytes(root), marker = await hostileLfsFilter(root);
  await assert.rejects(stageLfsSelection(root, ["assets/changed.uasset"], captainGit), /lfs|pointer|hydrat/i);
  assert.deepEqual(await indexBytes(root), before);
  await assertNoMarker(marker);
});

test("nonexistent selections fail without altering the real index", async t => {
  const root = await fixture(t), before = await indexBytes(root);
  await assert.rejects(stageLfsSelection(root, ["assets/never-existed.uasset"], captainGit), /path|selection|match/i);
  assert.deepEqual(await indexBytes(root), before);
});

test("an already staged LFS deletion remains staged", async t => {
  const root = await fixture(t);
  await git(root, "rm", "assets/deleted.uasset");
  await stageLfsSelection(root, ["assets/deleted.uasset"], captainGit);
  assert.match(await git(root, "diff", "--cached", "--name-status"), /^D\s+assets\/deleted\.uasset$/);
});

for (const source of ["local", "include", "worktree"] as const) {
  test(`configured lfs.storage in ${source} config is rejected without changing the index`, async t => {
    const root = await fixture(t);
    if (source === "local") await git(root, "config", "lfs.storage", path.join(root, "other-lfs-store"));
    if (source === "include") {
      const config = path.join(root, "additional.cfg");
      await writeFile(config, "[lfs]\n\tstorage = custom-lfs-store\n");
      await git(root, "config", "--local", "include.path", config.replaceAll("\\", "/"));
    }
    if (source === "worktree") {
      await git(root, "config", "extensions.worktreeConfig", "true");
      await git(root, "config", "--worktree", "lfs.storage", path.join(root, "other-lfs-store"));
    }
    await writeFile(path.join(root, "assets", "changed.uasset"), modified);
    const before = await indexBytes(root);
    await assert.rejects(stageLfsSelection(root, ["assets/changed.uasset"], captainGit), /lfs\.storage/i);
    assert.deepEqual(await indexBytes(root), before);
  });
}

test("an unrelated configured clean filter is rejected without execution or index changes", async t => {
  const root = await fixture(t), marker = await hostileLfsFilter(root);
  const program = path.join(root, "malicious-filter.cjs");
  const command = `"${process.execPath.replaceAll("\\", "/")}" "${program.replaceAll("\\", "/")}"`;
  await git(root, "config", "filter.hostile.clean", command);
  await writeFile(path.join(root, "assets", ".gitattributes"), "*.uasset filter=hostile\n");
  await writeFile(path.join(root, "assets", "changed.uasset"), modified);
  const before = await indexBytes(root);
  await assert.rejects(stageLfsSelection(root, ["assets/changed.uasset"], captainGit), /filter/i);
  assert.deepEqual(await indexBytes(root), before);
  await assertNoMarker(marker);
});
