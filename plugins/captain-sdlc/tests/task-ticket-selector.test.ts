import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LifecycleStore, type GateRunner, type StateProbe } from "../src/lifecycle.js";
import { writeAuthorized } from "../src/authority.js";

const trustedCommand = "powershell -NoProfile -ExecutionPolicy Bypass -File Tools/Captain/Invoke-Ticket.ps1 -TestFilter Baseline.All -ResultPath Temp/ticket.xml";
const selectedFilter = "Dirigible.Tests.Editor.Verification.RegistryBakeBuildPreprocessTests";
const selectedCommand = trustedCommand.replace("Baseline.All", selectedFilter);
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const red = (store: LifecycleStore, filter?: string) => (store.recordRed as any)("selector", undefined, filter);
const check = (store: LifecycleStore, scope = "ticket", filter?: string) => (store.runCheck as any)("selector", scope, filter);

async function fixture(profile: "low" | "feature" | "pre-release" = "low", command = trustedCommand) {
  const root = await mkdtemp(path.join(tmpdir(), "captain-ticket-selector-project-"));
  const data = await mkdtemp(path.join(tmpdir(), "captain-ticket-selector-authority-"));
  const worktreePath = path.join(root, ".captain-sdlc", "worktrees", "selector");
  const binding = { branch: "captain/selector", commonGitDir: path.join(root, ".git"), gitDir: path.join(root, ".git", "worktrees", "selector") };
  const probe: StateProbe = async () => ({ ...binding, head: "a".repeat(40), branchHead: "a".repeat(40), tree: "c".repeat(40), status: "", topLevel: worktreePath });
  const policy = { profile, visualRequired: false, commands: { ticket: command, "feature-smoke": "smoke", "affected-regression": "regression", build: "build" }, redGate: { expectedExitCodes: [1], outputPattern: "injected test failure" } };
  const calls: string[] = [];
  let exitCode = 1;
  const runner: GateRunner = async candidate => { calls.push(candidate); return { exitCode, stdout: "injected test failure", stderr: "" }; };
  const store = new LifecycleStore(data, runner, probe);
  await store.markIntent({ intentId: "selector", sessionId: "selector-session", turnId: "selector-turn", projectRoot: root, prompt: "verify only task-relevant tests" });
  await store.begin({ intentId: "selector", objective: "verify only task-relevant tests", projectRoot: root, worktreePath, baseHead: "a".repeat(40), ...binding, policy });
  return { store, policy, calls, root, data, pass: () => { exitCode = 0; } };
}

test("LOW ticket selector binds the derived red command and defaults green to that immutable filter", async () => {
  const { store, policy, calls, pass } = await fixture();
  const result = await red(store, selectedFilter);
  assert.deepEqual(calls, [selectedCommand]);
  const binding = { filter: selectedFilter, command: selectedCommand, commandSha256: hash(selectedCommand), policyCommandSha256: hash(trustedCommand) };
  assert.deepEqual(result.taskTicket, binding);
  assert.deepEqual(result.policy, policy, "task selection must not rewrite the captured trusted policy");
  const redEvidence = result.evidence.find((item: any) => item.kind === "tdd_red");
  assert.equal(redEvidence.commandSha256, binding.commandSha256);
  assert.equal(redEvidence.policyCommandSha256, binding.policyCommandSha256);
  assert.equal(redEvidence.ticketFilter, selectedFilter);
  pass();
  const green = await check(store);
  assert.deepEqual(calls, [selectedCommand, selectedCommand]);
  assert.deepEqual(green.taskTicket, binding);
  assert.deepEqual(green.policy, policy);
  const greenEvidence = green.evidence.at(-1);
  assert.equal(greenEvidence.commandSha256, binding.commandSha256);
  assert.equal(greenEvidence.policyCommandSha256, binding.policyCommandSha256);
  assert.equal(greenEvidence.ticketFilter, selectedFilter);
  await check(store, "ticket", selectedFilter);
  assert.equal(calls.at(-1), selectedCommand);
});

test("LOW ticket selector rejects a changed green filter before running a command", async () => {
  const { store, calls, pass } = await fixture();
  await red(store, selectedFilter); pass();
  const before = await store.status("selector");
  await assert.rejects(() => check(store, "ticket", "Another.Tests.Class"), /bound|immutable|mismatch|different/i);
  assert.equal(calls.length, 1);
  assert.deepEqual(await store.status("selector"), before);
});

test("LOW ticket selector binds on the first ticket iteration after an ordinary red", async () => {
  const { store, calls, pass } = await fixture();
  await red(store); pass();
  const green = await check(store, "ticket", selectedFilter);
  assert.deepEqual(calls, [trustedCommand, selectedCommand]);
  assert.equal(green.taskTicket.filter, selectedFilter);
  await check(store);
  assert.equal(calls.at(-1), selectedCommand);
});

for (const filter of ["", " ", "Tests;Write-Host injected", "Tests&whoami", "Tests|whoami", "Tests$(whoami)", "Tests`nOther", 'Tests"Other', "Tests'Other", "Tests\nOther", "Tests.*", "a".repeat(513)]) {
  test(`LOW ticket selector rejects unsafe or unsupported scalar ${JSON.stringify(filter)}`, async () => {
    const { store, calls } = await fixture();
    const before = await store.status("selector");
    await assert.rejects(() => red(store, filter), /filter|selector/i);
    assert.deepEqual(calls, []);
    assert.deepEqual(await store.status("selector"), before);
  });
}

for (const command of [
  "powershell -File Tools/Captain/Invoke-Ticket.ps1",
  `${trustedCommand} -TestFilter Other.Tests`,
  trustedCommand.replace("Baseline.All", "$env:CAPTAIN_FILTER"),
  trustedCommand.replace("Baseline.All", '"Baseline.All"'),
  trustedCommand.replace("-TestFilter Baseline.All", "-TestFilter:Baseline.All"),
  trustedCommand.replace("-TestFilter Baseline.All", "-TestFilter")
]) {
  test(`LOW ticket selector rejects an unsupported or ambiguous trusted filter slot ${JSON.stringify(command)}`, async () => {
    const { store, calls } = await fixture("low", command);
    await assert.rejects(() => red(store, selectedFilter), /filter|selector/i);
    assert.deepEqual(calls, []);
    assert.equal((await store.status("selector") as any).taskTicket, undefined);
  });
}

for (const profile of ["feature", "pre-release"] as const) {
  test(`ticket selector refuses specialization of the ${profile} profile`, async () => {
    const { store, calls } = await fixture(profile);
    await assert.rejects(() => red(store, selectedFilter), /low|profile/i);
    assert.deepEqual(calls, []);
    await red(store);
    const before = calls.length;
    await assert.rejects(() => check(store, "ticket", selectedFilter), /low|profile/i);
    assert.equal(calls.length, before);
  });
}

for (const scope of ["feature-smoke", "affected-regression"]) {
  test(`LOW ticket selector refuses an explicit filter for ${scope}`, async () => {
    const { store, calls } = await fixture();
    await red(store, selectedFilter);
    await assert.rejects(() => check(store, scope, selectedFilter), /ticket|scope/i);
    assert.equal(calls.length, 1);
  });
}

test("LOW ticket selector keeps unfiltered red and green commands backward compatible", async () => {
  const { store, calls, pass, policy } = await fixture();
  const result = await red(store); pass();
  assert.equal(result.taskTicket, undefined);
  const green = await check(store);
  assert.deepEqual(calls, [trustedCommand, trustedCommand]);
  assert.deepEqual(green.policy, policy);
});

for (const command of [
  'powershell -Command "Write-Host -TestFilter Baseline.All ignored"',
  "powershell -Command Write-Host -TestFilter Baseline.All ignored",
  "powershell -C Write-Host -TestFilter Baseline.All ignored",
  "powershell -EncodedCommand Zm9v -TestFilter Baseline.All",
  'powershell -File Tools/Ticket.ps1 -Literal "embedded -TestFilter Baseline.All ignored"',
  "powershell -File Tools/Ticket.ps1 -Literal 'embedded -TestFilter Baseline.All ignored'",
  "powershell -File Tools/Ticket.ps1 # ignored -TestFilter Baseline.All",
  "powershell -File Tools/Ticket.ps1 -TestFilter Baseline.All; whoami",
  "powershell -File Tools/Ticket.ps1 -TestFilter Baseline.All & whoami",
  "powershell -File Tools/Ticket.ps1 -TestFilter Baseline.All | whoami",
  "powershell -File Tools/Ticket.ps1 -TestFilter Baseline.All\nwhoami",
  "powershell -File Tools/Ticket.ps1 -TestFilter Baseline.All > Temp/output.txt",
  "cmd /c powershell -File Tools/Ticket.ps1 -TestFilter Baseline.All",
  "powershell -File Tools/Ticket.ps1 -TestFilter Baseline.All -File Other.ps1"
]) {
  test(`LOW ticket selector refuses shell text and embedded filter literals ${JSON.stringify(command)}`, async () => {
    const { store, calls } = await fixture("low", command);
    await assert.rejects(() => red(store, selectedFilter), /filter|selector/i);
    assert.deepEqual(calls, []);
    assert.equal((await store.status("selector") as any).taskTicket, undefined);
  });
}

test("LOW ticket selector supports the captured plain Unity PowerShell File command", async () => {
  const command = "powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File Tools/Captain/Invoke-FocusedUnityTicket.ps1 -TestFilter Dirigible.Tests.Editor.UI.SharedPointerButtonPrefabContractTests";
  const { store, calls } = await fixture("low", command);
  await red(store, selectedFilter);
  assert.deepEqual(calls, [command.replace("Dirigible.Tests.Editor.UI.SharedPointerButtonPrefabContractTests", selectedFilter)]);
});


for (const mutation of ["remove", "replace"] as const) {
  test(`signed ticket binding rejects a later revision that attempts to ${mutation} it`, async () => {
    const { store, data } = await fixture();
    await red(store, selectedFilter);
    const { user_request: _context, ...previous } = await store.status("selector");
    const candidate: any = { ...previous, revision: previous.revision + 1, previousRevisionSha256: hash(JSON.stringify(previous)) };
    if (mutation === "remove") delete candidate.taskTicket;
    else {
      const filter = "Replacement.Tests";
      const command = trustedCommand.replace("Baseline.All", filter);
      candidate.taskTicket = { filter, command, commandSha256: hash(command), policyCommandSha256: hash(trustedCommand) };
    }
    await writeAuthorized(data, "run-revisions", `selector-${candidate.revision}`, candidate);
    await assert.rejects(() => store.status("selector"), /ticket.*(?:immutable|binding)|immutable.*ticket/i);
  });
}

test("signed ticket binding survives ordinary pause and session resume", async () => {
  const { store, root, pass, calls } = await fixture();
  const before = await red(store, selectedFilter);
  await store.pause("selector", { summary: "Retain selected task tests across session handoff", nextSteps: ["Run selected green tests"] });
  await store.markIntent({ intentId: "selector-resume", sessionId: "next-session", turnId: "next-turn", projectRoot: root, prompt: "continue selected tests", resumeOf: "selector" });
  const resumed = await store.resume("selector-resume");
  assert.deepEqual(resumed.taskTicket, before.taskTicket);
  pass();
  const checked = await check(store);
  assert.deepEqual(checked.taskTicket, before.taskTicket);
  assert.equal(calls.at(-1), selectedCommand);
});
