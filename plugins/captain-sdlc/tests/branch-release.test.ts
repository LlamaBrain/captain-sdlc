import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as checkerModule from "../src/release-intent.js";
import { assertReleaseIntentChecker } from "../src/release-intent.js";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { commitEvidence, git, loadPolicy } from "../src/workspace.js";
import { proofScopes } from "../src/lifecycle.js";

async function fixture(command = true) {
  const root = await mkdtemp(path.join(tmpdir(), "captain-branch-release-"));
  await mkdir(path.join(root, ".captain-sdlc"));
  const checkerPath=path.join(await mkdtemp(path.join(tmpdir(),"captain-installed-checker-")),"checker.mjs");
  const checkerCode="process.exit(0);\n"; await writeFile(checkerPath,checkerCode);
  const policy = {
    profile: "feature", visualRequired: false,
    commands: { build: "node -e 0", ticket: "node -e 0", "feature-smoke": "node -e 0",
      "affected-regression": "node -e 0",  },
    ...(command ? { releaseIntentChecker: { path:checkerPath, sha256:createHash("sha256").update(checkerCode).digest("hex") } } : {}),
    commit: { mode: "branch_driven", conventional: true, require_version_suffix: false,
      version_file: "VERSION", version_surfaces: [{ path: "VERSION", pattern: "^(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)$" }],
      changelog_files: ["CHANGELOG.md"], require_task_trailer: true }
  };
  await writeFile(path.join(root, ".captain-sdlc/codex-policy.json"), JSON.stringify(policy));
  await writeFile(path.join(root, "VERSION"), "1.0.0");
  await writeFile(path.join(root, "CHANGELOG.md"), "# Changelog\n");
  await git(["init", "-b", "feat/example"], root);
  await git(["config", "user.name", "Fixture"], root);
  await git(["config", "user.email", "fixture@example.invalid"], root);
  await git(["add", "."], root);
  await git(["commit", "-m", "chore: fixture"], root);
  return { root, base: await git(["rev-parse", "HEAD"], root) };
}
test("branch-driven policy requires trusted release-intent proof", async () => {
  const f = await fixture(false);
  await assert.rejects(loadPolicy(f.root, f.base), /release-intent/);
});
test("branch-driven feature retains versions and adds release-intent proof gate", async () => {
  const f = await fixture(), policy = await loadPolicy(f.root, f.base);
  assert.equal(policy.commit?.mode, "branch_driven");
  assert.ok(proofScopes({profile:"feature",visualRequired:false,policy} as any).includes("release-intent"));
  await writeFile(path.join(f.root,"feature.txt"), "feature");
  await git(["add","feature.txt"],f.root);
  await git(["commit","-m","feat(core): add feature\n\nImplements: task-42\nCaptain-Run: test-run"],f.root);
  const evidence=await commitEvidence(f.root,f.base,policy,"task-42");
  assert.equal(evidence.phaseCommitsValid,true);
  assert.equal(evidence.versionSurfacesValid,true);
  assert.equal(evidence.versionChanged,false);
  assert.equal(evidence.changelogChanged,false);
});
test("branch-driven feature rejects changed version and undescribed break", async () => {
  const f=await fixture(), policy=await loadPolicy(f.root,f.base);
  await writeFile(path.join(f.root,"VERSION"),"1.0.1");
  await git(["add","VERSION"],f.root);
  await git(["commit","-m","feat(core)!: break API\n\nImplements: task-42"],f.root);
  assert.equal((await commitEvidence(f.root,f.base,policy,"task-42")).phaseCommitsValid,false);
});
for (const scenario of [
  { subject: "fix(core): repair", file: "VERSION", content: "1.0.1", valid: false },
  { subject: "feat(core)!: break", file: "feature.txt", content: "feature", valid: false },
  { subject: "feat(core)!: break\n\nBREAKING CHANGE: use replacement call", file: "feature.txt", content: "feature", valid: true },
  { subject: "docs(core): update shared changelog", file: "CHANGELOG.md", content: "# Changed", valid: false },
]) test("branch mode isolated check: " + scenario.subject, async () => {
  const f=await fixture(), policy=await loadPolicy(f.root,f.base);
  await writeFile(path.join(f.root,scenario.file),scenario.content);
  await git(["add",scenario.file],f.root);
  await git(["commit","-m",scenario.subject+"\n\nImplements: task-42"],f.root);
  assert.equal((await commitEvidence(f.root,f.base,policy,"task-42")).phaseCommitsValid,scenario.valid);
});
test("branch mode preserves Seam 7 content-derived task IDs", async () => {
  const f=await fixture(), policy=await loadPolicy(f.root,f.base), task="M05#squads#abc123def456";
  await writeFile(path.join(f.root,"feature.txt"),"feature");
  await git(["add","feature.txt"],f.root);
  await git(["commit","-m","fix(core): repair\n\nCompletes: "+task+"\nCaptain-Run: test-run"],f.root);
  const evidence=await commitEvidence(f.root,f.base,policy,task);
  assert.equal(evidence.phaseCommitsValid,true);
  assert.equal(evidence.taskTrailerPresent,true);
});
test("release-intent checker is external and pinned by its trusted-base digest", async () => {
  const f=await fixture(), policy=await loadPolicy(f.root,f.base);
  assert.ok(policy.releaseIntentChecker);
  await assertReleaseIntentChecker(policy.releaseIntentChecker!,[f.root]);
  await writeFile(policy.releaseIntentChecker!.path,"process.exit(0); // replaced");
  await assert.rejects(assertReleaseIntentChecker(policy.releaseIntentChecker!,[f.root]),/digest/);
});

async function configure(f: {root:string,base:string}, update: (policy:any)=>void) {
  const file=path.join(f.root,".captain-sdlc/codex-policy.json"), value=JSON.parse(await readFile(file,"utf8"));
  update(value); await writeFile(file,JSON.stringify(value));
  await git(["add","."],f.root); await git(["commit","-m","chore: configure fixture"],f.root);
  f.base=await git(["rev-parse","HEAD"],f.root);
}
test("trusted custom types remain valid and actual breaks require descriptions", async () => {
  const f=await fixture();
  await configure(f,p=>{p.commit.type_impacts={update:"patch"};});
  const policy=await loadPolicy(f.root,f.base);
  await writeFile(path.join(f.root,"feature.txt"),"feature");
  await git(["add","feature.txt"],f.root); await git(["commit","-m","update(core): revise behavior\n\nImplements: task-42"],f.root);
  assert.equal((await commitEvidence(f.root,f.base,policy,"task-42")).phaseCommitsValid,true);
});
test("JSON mirror versions are protected while unrelated metadata may change", async () => {
  const f=await fixture();
  await writeFile(path.join(f.root,"package-lock.json"),JSON.stringify({version:"1.0.0",packages:{"":{version:"1.0.0",name:"old"}}},null,2));
  await configure(f,p=>{p.commit.version_surfaces.push({path:"package-lock.json",pattern:'(?m)^  "version": "(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)",$',json_pointers:["/version","/packages//version"]});});
  const policy=await loadPolicy(f.root,f.base);
  const file=path.join(f.root,"package-lock.json"), value=JSON.parse(await readFile(file,"utf8"));
  value.packages[""].name="new"; await writeFile(file,JSON.stringify(value,null,2)); await git(["add","package-lock.json"],f.root);
  await git(["commit","-m","fix(core): rename metadata\n\nImplements: task-42"],f.root);
  assert.equal((await commitEvidence(f.root,f.base,policy,"task-42")).phaseCommitsValid,true);
  value.packages[""].version="1.0.1"; await writeFile(file,JSON.stringify(value,null,2)); await git(["add","package-lock.json"],f.root);
  await git(["commit","-m","fix(core): alter mirror\n\nImplements: task-42"],f.root);
  assert.equal((await commitEvidence(f.root,f.base,policy,"task-42")).phaseCommitsValid,false);
});

test("installed checker executes paths with spaces directly and strips authority keys", async () => {
  const run=(checkerModule as any).runReleaseIntentChecker;
  assert.equal(typeof run,"function");
  const root=await mkdtemp(path.join(tmpdir(),"captain checker spaces "));
  const file=path.join(root,"checker.mjs"), code='console.log(process.env.CAPTAIN_SEQUENCE_AUTH_KEY ?? "absent");';
  await writeFile(file,code);
  const previous=process.env.CAPTAIN_SEQUENCE_AUTH_KEY;
  process.env.CAPTAIN_SEQUENCE_AUTH_KEY="fixture-private-key";
  try {
    const result=await run({path:file,sha256:createHash("sha256").update(code).digest("hex")},root,[]);
    assert.equal(result.exitCode,0); assert.equal(result.stdout.trim(),"absent");
  } finally {
    if(previous===undefined) delete process.env.CAPTAIN_SEQUENCE_AUTH_KEY; else process.env.CAPTAIN_SEQUENCE_AUTH_KEY=previous;
  }
});
