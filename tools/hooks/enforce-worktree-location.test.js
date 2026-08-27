#!/usr/bin/env node
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

const hook = path.join(__dirname, 'enforce-worktree-location.js');
const cwd = path.resolve(__dirname, '..', '..');
const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim();
const repoRoot = path.dirname(commonDir);
const canonical = path.join(repoRoot, '.captain-sdlc', 'worktrees', 'ticket-one');

function invoke(command) {
  return spawnSync(process.execPath, [hook], { cwd, input: JSON.stringify({ cwd, tool_input: { command } }), encoding: 'utf8' });
}

assert.equal(invoke(`git worktree add "${canonical}" -b feat/ticket HEAD`).status, 0);
assert.equal(invoke('git status --short').status, 0);
const outside = invoke(`git worktree add "${path.join(repoRoot, '..', 'scattered-ticket')}" HEAD`);
assert.equal(outside.status, 2);
assert.match(outside.stderr, /destination must be inside/);
assert.equal(invoke(`git worktree move "${canonical}" "${path.join(repoRoot, '..', 'also-scattered')}"`).status, 2);
assert.equal(invoke(`git worktree add "${canonical}" HEAD && git worktree add "${path.join(repoRoot, '..', 'escaped')}" HEAD`).status, 2);
assert.equal(invoke(`git worktree add "${canonical}" HEAD\ngit worktree add "${path.join(repoRoot, '..', 'newline-escaped')}" HEAD`).status, 2);
assert.equal(invoke(`git work"tree" add "${path.join(repoRoot, '..', 'quote-escaped')}" HEAD`).status, 2);
assert.equal(invoke(`git worktr\\ee add "${path.join(repoRoot, '..', 'slash-escaped')}" HEAD`).status, 2);
assert.equal(invoke(`$op = 'worktree'; git $op add "${path.join(repoRoot, '..', 'variable-escaped')}" HEAD`).status, 2);

console.log('enforce-worktree-location: 9 checks passed');
