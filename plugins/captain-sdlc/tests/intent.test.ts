import assert from "node:assert/strict";
import test from "node:test";
import { classifyImplementationIntent, extractAuthorizedTargetBranch, extractCaptainPlanTask, extractCaptainResumeIntent } from "../src/intent.js";

test("routes only explicitly declared Captain plans", () => {
  for (const prompt of ["implement inventory stacking", "fix save/load", "build the settings screen", "add controller support", "refactor the planner", "repair saving", "rename the API", "wire the adapter", "make saves work", "please get controller input working", "how can you fix this today?", "continue the four colony/spike merges", "resume the implementation"])
    assert.equal(classifyImplementationIntent(prompt), false, prompt);
  assert.equal(classifyImplementationIntent("[Captain plan: M5_2_PLAYABLE_LOOP#phase-3]"), true);
  assert.equal(classifyImplementationIntent("implement the quest\n[Captain plan: M5_2_PLAYABLE_LOOP#phase-3]"), true);
  assert.equal(classifyImplementationIntent("[Captain target: spike/colony]"), false);
});

test("does not route read-only questions", () => {
  for (const prompt of ["explain the planner", "review this diff", "what is the status?", "diagnose why save load fails"])
    assert.equal(classifyImplementationIntent(prompt), false, prompt);
});

test("extracts only one standalone explicit Captain target directive", () => {
  assert.equal(extractAuthorizedTargetBranch("integrate everything\n[Captain target: colony/spike]"), "colony/spike");
  assert.equal(extractAuthorizedTargetBranch("integrate [Captain target: colony/spike]"), undefined);
  assert.equal(extractAuthorizedTargetBranch("merge to evil/branch"), undefined);
  assert.throws(() => extractAuthorizedTargetBranch("[Captain target: ../escape]"), /invalid/);
  assert.throws(() => extractAuthorizedTargetBranch("[Captain target: colony/spike]\n[Captain target: evil/branch]"), /ambiguous/);
});

test("extracts an explicit Captain plan task key", () => {
  assert.equal(extractCaptainPlanTask("implement the quest\n[Captain plan: M5_2_PLAYABLE_LOOP#phase-3]"), "M5_2_PLAYABLE_LOOP#phase-3");
  assert.equal(extractCaptainPlanTask("implement the quest"), undefined);
  assert.throws(() => extractCaptainPlanTask("[Captain plan: ../escape]"), /invalid/);
  assert.throws(() => extractCaptainPlanTask("[Captain plan: A]\n[Captain plan: B]"), /ambiguous/);
});

test("extracts one standalone Captain resume intent", () => {
  const intentId = "intent-12345678-1234-1234-1234-123456789abc";
  assert.equal(extractCaptainResumeIntent(`continue the work\n[Captain resume: ${intentId}]`), intentId);
  assert.equal(classifyImplementationIntent(`[Captain resume: ${intentId}]`), true);
  assert.equal(extractCaptainResumeIntent("resume the work"), undefined);
  assert.throws(() => extractCaptainResumeIntent("[Captain resume: not-an-intent]"), /invalid/);
  assert.throws(() => extractCaptainResumeIntent(`[Captain resume: ${intentId}]\n[Captain resume: ${intentId}]`), /ambiguous/);
});
