import assert from "node:assert/strict";
import test from "node:test";
import { classifyImplementationIntent } from "../src/intent.js";

test("routes direct implementation requests", () => {
  for (const prompt of ["implement inventory stacking", "fix save/load", "build the settings screen", "add controller support", "refactor the planner", "repair saving", "rename the API", "wire the adapter", "make saves work", "please get controller input working", "how can you fix this today?"])
    assert.equal(classifyImplementationIntent(prompt), true, prompt);
});

test("does not route read-only questions", () => {
  for (const prompt of ["explain the planner", "review this diff", "what is the status?", "diagnose why save load fails"])
    assert.equal(classifyImplementationIntent(prompt), false, prompt);
});
