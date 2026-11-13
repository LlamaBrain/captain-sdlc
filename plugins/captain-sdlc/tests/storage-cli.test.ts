import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await exec("git", args, { cwd, windowsHide: true })).stdout.trim();
const api = () => import(new URL("../src/storage-cli.js", import.meta.url).href);

async function fixture(t: TestContext) {
  const container = await mkdtemp(path.join(tmpdir(), "captain-ordinary-storage-")), root = path.join(container, "project");
  t.after(async () => { assert.equal(path.dirname(container), path.resolve(tmpdir())); assert.ok(path.basename(container).startsWith("captain-ordinary-storage-")); await rm(container, { recursive: true, force: true }); });
  await mkdir(root); await git(root, "init", "-b", "main"); await git(root, "config", "core.autocrlf", "false");
  await git(root, "config", "user.name", "Captain Test"); await git(root, "config", "user.email", "captain@example.invalid");
  await writeFile(path.join(root, ".gitignore"), ".captain-sdlc/storage-authority/\n.captain-sdlc/worktrees/\nartifacts/\ntarget/\n**/bin/\n**/obj/\n");
  await mkdir(path.join(root, "src")); await writeFile(path.join(root, "src", "App.csproj"), "<Project Sdk=\"Microsoft.NET.Sdk\" />\n");
  await git(root, "add", "."); await git(root, "commit", "-m", "baseline");
  return { root, head: await git(root, "rev-parse", "HEAD") };
}

test("ordinary non-Unity workflow creates a registered canonical worktree and replaces one active build slot", async t => {
  const f = await fixture(t), { runStorageCommand } = await api();
  const created = await runStorageCommand(["create", "--project", f.root, "--task", "ordinary-task"]);
  assert.equal(created.worktree_path, path.join(f.root, ".captain-sdlc", "worktrees", "ordinary-task"));
  const active = path.join(created.worktree_path, "artifacts", "active"); await mkdir(active, { recursive: true }); await writeFile(path.join(active, "obsolete.exe"), "old build");
  await runStorageCommand(["prepare-output", "--worktree", created.worktree_path, "--root", "artifacts/active"]);
  await assert.rejects(() => stat(path.join(active, "obsolete.exe")), { code: "ENOENT" });
  await assert.rejects(() => runStorageCommand(["prepare-output", "--worktree", created.worktree_path, "--root", "artifacts/new-attempt"]), /fixed|slot|root|checkpoint/i);
  assert.equal(await readFile(path.join(created.worktree_path, "src", "App.csproj"), "utf8"), "<Project Sdk=\"Microsoft.NET.Sdk\" />\n");
});

test("ordinary workflow removes only its newly registered completed merged worktree and retains a durable receipt", async t => {
  const f = await fixture(t), { runStorageCommand } = await api(), created = await runStorageCommand(["create", "--project", f.root, "--task", "merge-task"]);
  await writeFile(path.join(created.worktree_path, "task.txt"), "task\n"); await git(created.worktree_path, "add", "task.txt"); await git(created.worktree_path, "commit", "-m", "task change");
  await mkdir(path.join(created.worktree_path, "artifacts"), { recursive: true });
  await writeFile(path.join(created.worktree_path, "artifacts", "results.json"), "{\"passed\":true}\n");
  await git(f.root, "merge", "--ff-only", created.branch);
  const cleaned = await runStorageCommand(["cleanup", "--source", created.worktree_path, "--target", f.root, "--evidence", "artifacts/results.json"]);
  assert.deepEqual(cleaned.removed_worktrees, [created.worktree_path]); assert.deepEqual(cleaned.retained_worktrees, []);
  assert.ok(cleaned.evidence_root);
  await assert.rejects(() => stat(created.worktree_path), { code: "ENOENT" });
  assert.equal(await git(f.root, "rev-parse", created.branch), await git(f.root, "rev-parse", "HEAD"));
  const repeated = await runStorageCommand(["cleanup", "--source", created.worktree_path, "--target", f.root]);
  assert.deepEqual(repeated.removed_worktrees, [created.worktree_path]);
});

test("ordinary cleanup uses its signed exact output slot and preserves unclassified siblings", async t => {
  const f = await fixture(t), { runStorageCommand } = await api();
  const created = await runStorageCommand(["create", "--project", f.root, "--task", "explicit-slot"]);
  const slot = await runStorageCommand(["prepare-output", "--worktree", created.worktree_path, "--root", "target/active"]);
  await writeFile(path.join(slot.build_output_path, "payload.bin"), "disposable payload");
  const privateFile = path.join(created.worktree_path, "target/private.txt");
  await writeFile(privateFile, "retain unrelated ignored data\n");
  await git(f.root, "merge", "--ff-only", created.branch);
  const retained = await runStorageCommand(["cleanup", "--source", created.worktree_path, "--target", f.root]);
  assert.deepEqual(retained.removed_worktrees, []);
  assert.equal(await readFile(privateFile, "utf8"), "retain unrelated ignored data\n");
  await rm(privateFile);
  const cleaned = await runStorageCommand(["cleanup", "--source", created.worktree_path, "--target", f.root]);
  assert.deepEqual(cleaned.removed_worktrees, [created.worktree_path]);
  assert.deepEqual(cleaned.retained_worktrees, []);
});

test("ordinary cleanup refuses unmerged and legacy worktrees", async t => {
  const f = await fixture(t), { runStorageCommand } = await api(), created = await runStorageCommand(["create", "--project", f.root, "--task", "unmerged"]);
  await writeFile(path.join(created.worktree_path, "unique.txt"), "unmerged\n"); await git(created.worktree_path, "add", "unique.txt"); await git(created.worktree_path, "commit", "-m", "unmerged task");
  await assert.rejects(() => runStorageCommand(["cleanup", "--source", created.worktree_path, "--target", f.root]), /unmerged|ancestor|integrat/i);
  assert.equal(await readFile(path.join(created.worktree_path, "unique.txt"), "utf8"), "unmerged\n");
  const legacy = path.join(f.root, ".captain-sdlc", "worktrees", "legacy"); await git(f.root, "worktree", "add", "-b", "legacy", legacy);
  await assert.rejects(() => runStorageCommand(["cleanup", "--source", legacy, "--target", f.root]), /registered|legacy|creation/i);
  assert.ok((await stat(legacy)).isDirectory());
});

test("ordinary primary builds use a fixed slot without enrolling the checkout for removal", async t => {
  const f = await fixture(t), { runStorageCommand } = await api();
  const output = path.join(f.root, "artifacts", "active"); await mkdir(output, { recursive: true }); await writeFile(path.join(output, "old.dll"), "old\n");
  await assert.rejects(() => runStorageCommand(["prepare-output", "--worktree", f.root, "--root", ".captain-sdlc/storage-authority"]), /generated|metadata|protected|worktree|output/i);
  const prepared = await runStorageCommand(["prepare-output", "--worktree", f.root, "--root", "artifacts/active"]);
  assert.equal(prepared.build_output_path, output); await assert.rejects(() => stat(path.join(output, "old.dll")), { code: "ENOENT" });
  await assert.rejects(() => runStorageCommand(["cleanup", "--source", f.root, "--target", f.root]), /distinct|primary|registered/i);
});

test("ordinary final merge retries terminal registered predecessors in its recorded chain", async t => {
  const f = await fixture(t), { runStorageCommand } = await api(), first = await runStorageCommand(["create", "--project", f.root, "--task", "first"]);
  const second = await runStorageCommand(["create", "--project", first.worktree_path, "--task", "second"]);
  const project = path.join(first.worktree_path, "src", "App.csproj"), original = await readFile(project, "utf8"); await writeFile(project, original + "<!-- preserve unfinished local record -->\n");
  const retained = await runStorageCommand(["cleanup", "--source", first.worktree_path, "--target", second.worktree_path]);
  assert.equal(retained.removed_worktrees.length, 0); assert.equal(retained.retained_worktrees[0].worktree, first.worktree_path);
  await writeFile(project, original);
  await writeFile(path.join(second.worktree_path, "second.txt"), "second\n"); await git(second.worktree_path, "add", "second.txt"); await git(second.worktree_path, "commit", "-m", "second task");
  await git(f.root, "merge", "--ff-only", second.branch);
  const cleaned = await runStorageCommand(["cleanup", "--source", second.worktree_path, "--target", f.root]);
  assert.deepEqual(new Set(cleaned.removed_worktrees), new Set([first.worktree_path, second.worktree_path]));
  assert.deepEqual(cleaned.retained_worktrees, []);
});

test("ordinary helper refuses enrolled repositories and unknown or duplicate CLI arguments", async t => {
  const f = await fixture(t), { runStorageCommand } = await api();
  await assert.rejects(() => runStorageCommand(["create", "--project", f.root, "--task", "task", "--force"]), /argument|option/i);
  await assert.rejects(() => runStorageCommand(["create", "--project", f.root, "--project", f.root, "--task", "task"]), /duplicate|argument|option/i);
  await mkdir(path.join(f.root, ".captain-sdlc"), { recursive: true }); await writeFile(path.join(f.root, ".captain-sdlc", "codex-policy.json"), "{}\n");
  await git(f.root, "add", ".captain-sdlc/codex-policy.json"); await git(f.root, "commit", "-m", "enroll Captain");
  await assert.rejects(() => runStorageCommand(["create", "--project", f.root, "--task", "task"]), /enrolled|MCP|Captain/i);
});

test("ordinary enrolled sources remain protected when their target later unenrolls", async t => {
  const f = await fixture(t), { runStorageCommand } = await api(), created = await runStorageCommand(["create", "--project", f.root, "--task", "enrolling"]);
  const policy = path.join(created.worktree_path, ".captain-sdlc", "codex-policy.json"); await mkdir(path.dirname(policy), { recursive: true }); await writeFile(policy, "{}\n");
  await git(created.worktree_path, "add", ".captain-sdlc/codex-policy.json"); await git(created.worktree_path, "commit", "-m", "enroll source");
  await git(f.root, "merge", "--ff-only", created.branch); await git(f.root, "rm", ".captain-sdlc/codex-policy.json"); await git(f.root, "commit", "-m", "unenroll target");
  await assert.rejects(() => runStorageCommand(["cleanup", "--source", created.worktree_path, "--target", f.root]), /enrolled|MCP|Captain/i);
  assert.ok((await stat(created.worktree_path)).isDirectory());
});

test("ordinary resume preserves a terminal predecessor while its child completes cleanup", async t => {
  const f = await fixture(t), { runStorageCommand } = await api(), first = await runStorageCommand(["create", "--project", f.root, "--task", "resumed-first"]);
  const second = await runStorageCommand(["create", "--project", first.worktree_path, "--task", "resumed-second"]);
  const project = path.join(first.worktree_path, "src", "App.csproj"), original = await readFile(project, "utf8"); await writeFile(project, original + "<!-- local record -->\n");
  await runStorageCommand(["cleanup", "--source", first.worktree_path, "--target", second.worktree_path]); await writeFile(project, original);
  await runStorageCommand(["resume", "--worktree", first.worktree_path]);
  await writeFile(path.join(second.worktree_path, "second.txt"), "second\n"); await git(second.worktree_path, "add", "second.txt"); await git(second.worktree_path, "commit", "-m", "complete child"); await git(f.root, "merge", "--ff-only", second.branch);
  const cleaned = await runStorageCommand(["cleanup", "--source", second.worktree_path, "--target", f.root]);
  assert.deepEqual(cleaned.removed_worktrees, [second.worktree_path]);
  assert.equal(cleaned.retained_worktrees[0].worktree, first.worktree_path); assert.match(cleaned.retained_worktrees[0].reason, /active|leased|reserved/i);
  assert.ok((await stat(first.worktree_path)).isDirectory());
});

test("ordinary active branch reservations independently prevent direct shared cleanup", async t => {
  const f = await fixture(t), { runStorageCommand } = await api(), created = await runStorageCommand(["create", "--project", f.root, "--task", "active"]);
  const { readWorktreeRegistration } = await import("../src/worktree-storage.js"), { cleanupRegisteredWorktrees } = await import("../src/worktree-cleanup.js");
  const common = path.resolve(await git(f.root, "rev-parse", "--path-format=absolute", "--git-common-dir"));
  const registration = await readWorktreeRegistration(created.storage_authority, common, created.worktree_path);
  const cleaned = await cleanupRegisteredWorktrees(created.storage_authority, f.root, [{ registration: registration!, head: f.head }]);
  assert.deepEqual(cleaned.removed_worktrees, []); assert.match(cleaned.retained_worktrees[0].reason, /active|leased|reserved/i);
  assert.ok((await stat(created.worktree_path)).isDirectory());
});

async function detachedPreview(t:TestContext) {
  const f=await fixture(t), preview=path.join(f.root,".captain-sdlc","worktrees","landing-preview");
  await git(f.root,"worktree","add","--detach",preview,f.head);
  return {...f,preview};
}

test("pinned detached landing preview replaces one ignored output slot without adopting task cleanup",async t=>{
  const f=await detachedPreview(t),{runStorageCommand}=await api(),active=path.join(f.preview,"artifacts","active");
  await mkdir(active,{recursive:true});await writeFile(path.join(active,"old.bin"),"previous build");
  const result=await runStorageCommand(["prepare-output","--worktree",f.preview,"--root","artifacts/active","--detached-head",f.head]);
  assert.equal(result.build_output_path,active);assert.equal(result.detached_head,f.head);
  await assert.rejects(stat(path.join(active,"old.bin")),{code:"ENOENT"});
  await writeFile(path.join(active,"new.bin"),"next build");
  await runStorageCommand(["prepare-output","--worktree",f.preview,"--root","artifacts/active","--detached-head",f.head]);
  await assert.rejects(stat(path.join(active,"new.bin")),{code:"ENOENT"});
  await assert.rejects(runStorageCommand(["prepare-output","--worktree",f.preview,"--root","artifacts/another","--detached-head",f.head]),/fixed|slot|root|checkpoint/i);
  const {readWorktreeRegistration}=await import("../src/worktree-storage.js"),common=await git(f.root,"rev-parse","--path-format=absolute","--git-common-dir");
  assert.equal(await readWorktreeRegistration(path.join(f.root,".captain-sdlc","storage-authority"),common,f.preview),undefined);
  await assert.rejects(runStorageCommand(["cleanup","--source",f.preview,"--target",f.root]),/registration|registered|legacy/i);
  assert.ok((await stat(f.preview)).isDirectory());
});

test("detached output preparation rejects missing, abbreviated, wrong and moved HEAD pins before deletion",async t=>{
  const f=await detachedPreview(t),{runStorageCommand}=await api(),active=path.join(f.preview,"artifacts","active"),sentinel=path.join(active,"keep.bin");
  await mkdir(active,{recursive:true});await writeFile(sentinel,"retain stale output");
  await assert.rejects(runStorageCommand(["prepare-output","--worktree",f.preview,"--root","artifacts/active"]),/branch|detached/i);
  for(const head of [f.head.slice(0,7),"f".repeat(40)])await assert.rejects(runStorageCommand(["prepare-output","--worktree",f.preview,"--root","artifacts/active","--detached-head",head]),/head|pin|revision|OID/i);
  await writeFile(path.join(f.root,"new.txt"),"next revision");await git(f.root,"add","new.txt");await git(f.root,"commit","-m","chore: advance target");
  const next=await git(f.root,"rev-parse","HEAD");await git(f.preview,"checkout","--detach",next);
  await assert.rejects(runStorageCommand(["prepare-output","--worktree",f.preview,"--root","artifacts/active","--detached-head",f.head]),/head|pin|revision|OID/i);
  assert.equal(await readFile(sentinel,"utf8"),"retain stale output");
  await assert.rejects(runStorageCommand(["prepare-output","--worktree",f.root,"--root","artifacts/active","--detached-head",next]),/detached|branch/i);
});

test("detached output preparation preserves tracked source and refuses unsafe or linked output roots",async t=>{
  const f=await detachedPreview(t),{runStorageCommand}=await api();
  await assert.rejects(runStorageCommand(["prepare-output","--worktree",f.preview,"--root","../outside","--detached-head",f.head]),/safe|escape|relative|ignored|outside/i);
  await assert.rejects(runStorageCommand(["prepare-output","--worktree",f.preview,"--root","src","--detached-head",f.head]),/generated|source|ignored/i);
  const tracked=path.join(f.preview,"artifacts","tracked.txt");await mkdir(path.dirname(tracked),{recursive:true});await writeFile(tracked,"authored source");
  await git(f.preview,"add","-f","artifacts/tracked.txt");await git(f.preview,"commit","-m","chore: retain tracked surface");const head=await git(f.preview,"rev-parse","HEAD");
  await assert.rejects(runStorageCommand(["prepare-output","--worktree",f.preview,"--root","artifacts","--detached-head",head]),/tracked|source/i);
  assert.equal(await readFile(tracked,"utf8"),"authored source");
  const outside=path.join(path.dirname(f.root),"outside"),linked=path.join(f.preview,"target");await mkdir(outside);await writeFile(path.join(outside,"keep.bin"),"outside data");
  await symlink(outside,linked,process.platform==="win32"?"junction":"dir");
  await assert.rejects(runStorageCommand(["prepare-output","--worktree",f.preview,"--root","target","--detached-head",head]),/reparse|symlink|link/i);
  assert.equal(await readFile(path.join(outside,"keep.bin"),"utf8"),"outside data");
});

test("detached output flag cannot adopt a registered task or enable another storage command",async t=>{
  const f=await fixture(t),{runStorageCommand}=await api(),created=await runStorageCommand(["create","--project",f.root,"--task","owned"]);
  await git(created.worktree_path,"checkout","--detach",f.head);
  await assert.rejects(runStorageCommand(["prepare-output","--worktree",created.worktree_path,"--root","artifacts/active","--detached-head",f.head]),/registered task|original workflow/i);
  await assert.rejects(runStorageCommand(["resume","--worktree",created.worktree_path,"--detached-head",f.head]),/argument|option/i);
  await assert.rejects(runStorageCommand(["cleanup","--source",created.worktree_path,"--target",f.root,"--detached-head",f.head]),/argument|option/i);
});


async function enrolledDetachedPreview(t:TestContext) {
  const f=await fixture(t);
  await mkdir(path.join(f.root,".captain-sdlc"),{recursive:true});
  await writeFile(path.join(f.root,".captain-sdlc","codex-policy.json"),JSON.stringify({outputRetention:{schema_version:1,roots:{build:["artifacts/active"]}}}));
  await git(f.root,"add",".captain-sdlc/codex-policy.json");await git(f.root,"commit","-m","chore: declare enrolled output");
  const head=await git(f.root,"rev-parse","HEAD"),preview=path.join(f.root,".captain-sdlc","worktrees","enrolled-preview");
  await git(f.root,"worktree","add","--detach",preview,head);
  return {...f,head,preview};
}

test("enrolled detached previews prepare committed declared output without acquiring task ownership",async t=>{
  const f=await enrolledDetachedPreview(t),{runStorageCommand}=await api(),active=path.join(f.preview,"artifacts","active");
  await mkdir(active,{recursive:true});await writeFile(path.join(active,"old.bin"),"old output");
  const result=await runStorageCommand(["prepare-output","--worktree",f.preview,"--root","artifacts/active","--detached-head",f.head]);
  assert.equal(result.detached_head,f.head);await assert.rejects(stat(path.join(active,"old.bin")),{code:"ENOENT"});
  const {readWorktreeRegistration}=await import("../src/worktree-storage.js"),common=await git(f.root,"rev-parse","--path-format=absolute","--git-common-dir");
  assert.equal(await readWorktreeRegistration(path.join(f.root,".captain-sdlc","storage-authority"),common,f.preview),undefined);
  for(const command of [["prepare-output","--worktree",f.root,"--root","artifacts/active"],["resume","--worktree",f.preview],["cleanup","--source",f.preview,"--target",f.root]])
    await assert.rejects(runStorageCommand(command),/enrolled|symbolic|branch/i);
});

test("enrolled preview refuses undeclared locally broadened and tracked output before deletion",async t=>{
  const f=await enrolledDetachedPreview(t),{runStorageCommand}=await api(),other=path.join(f.preview,"artifacts","other");
  await mkdir(other,{recursive:true});await writeFile(path.join(other,"keep.bin"),"retain output");
  const args=["prepare-output","--worktree",f.preview,"--root","artifacts/other","--detached-head",f.head];
  await assert.rejects(runStorageCommand(args),/declared|captured|enrolled/i);
  await writeFile(path.join(f.preview,".captain-sdlc","codex-policy.json"),JSON.stringify({outputRetention:{schema_version:1,roots:{build:["artifacts/other"]}}}));
  await assert.rejects(runStorageCommand(args),/declared|captured|enrolled/i);assert.equal(await readFile(path.join(other,"keep.bin"),"utf8"),"retain output");
  await git(f.preview,"checkout","--",".captain-sdlc/codex-policy.json");
  const active=path.join(f.preview,"artifacts","active");await mkdir(active,{recursive:true});await writeFile(path.join(active,"authored.cpp"),"int authored = 1;\n");
  await git(f.preview,"add","-f","artifacts/active/authored.cpp");await git(f.preview,"commit","-m","chore: retain authored fixture");const head=await git(f.preview,"rev-parse","HEAD");
  await assert.rejects(runStorageCommand(["prepare-output","--worktree",f.preview,"--root","artifacts/active","--detached-head",head]),/tracked|source/i);
  assert.equal(await readFile(path.join(active,"authored.cpp"),"utf8"),"int authored = 1;\n");
});

test("detached output reads identity without executing LFS attributes or weakening SDK guards", async t => {
  const f = await fixture(t), { runStorageCommand } = await api();
  const { repositoryIdentity, assertSafeGitAttributesInWorktree } = await import("../src/workspace.js");
  await writeFile(path.join(f.root, ".gitattributes"), "*.uasset filter=lfs diff=lfs merge=lfs -text\n");
  await writeFile(path.join(f.root, "content.uasset"), "synthetic asset\n");
  await git(f.root, "add", ".gitattributes", "content.uasset"); await git(f.root, "commit", "-m", "chore: retain LFS policy");
  const head = await git(f.root, "rev-parse", "HEAD"), preview = path.join(f.root, ".captain-sdlc", "worktrees", "lfs-preview");
  await git(f.root, "worktree", "add", "--detach", preview, head);
  const marker = path.join(path.dirname(f.root), "filter-ran.txt"), driver = path.join(path.dirname(f.root), "filter.cjs");
  await writeFile(driver, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "executed"); process.stdin.pipe(process.stdout);\n`);
  const command = `"${process.execPath.replaceAll("\\", "/")}" "${driver.replaceAll("\\", "/")}"`;
  await git(f.root, "config", "filter.lfs.clean", command); await git(f.root, "config", "filter.lfs.smudge", command); await git(f.root, "config", "merge.lfs.driver", command);
  await assert.rejects(repositoryIdentity(f.root), /clean filters|merge drivers/i);
  await assert.rejects(runStorageCommand(["create", "--project", f.root, "--task", "refused"]), /clean filters|merge drivers/i);
  await assert.rejects(assertSafeGitAttributesInWorktree(f.root, ["content.uasset"]), /clean filters|merge drivers/i);
  const active = path.join(preview, "artifacts", "active"), sentinel = path.join(active, "old.bin");
  await mkdir(active, { recursive: true }); await writeFile(sentinel, "old output");
  const args = ["prepare-output", "--worktree", preview, "--root", "artifacts/active", "--detached-head", head];
  const result = await runStorageCommand(args); assert.equal(result.detached_head, head); await assert.rejects(stat(sentinel), { code: "ENOENT" });
  await writeFile(sentinel, "next output"); await runStorageCommand(args); await assert.rejects(stat(sentinel), { code: "ENOENT" });
  await assert.rejects(stat(marker), { code: "ENOENT" });
  await writeFile(sentinel, "retain output"); await assert.rejects(runStorageCommand([...args.slice(0, -1), "f".repeat(40)]), /head|pin|revision/i);
  assert.equal(await readFile(sentinel, "utf8"), "retain output");
});