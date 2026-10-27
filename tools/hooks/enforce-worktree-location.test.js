#!/usr/bin/env node
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const hook = path.join(__dirname, 'enforce-worktree-location.js');
const cwd = path.resolve(__dirname, '..', '..');
const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', windowsHide: true }).trim();
const repoRoot = path.dirname(commonDir);
const canonical = path.join(repoRoot, '.captain-sdlc', 'worktrees', 'ticket-one');

function invoke(command) {
  return spawnSync(process.execPath, [hook], { cwd, input: JSON.stringify({ cwd, tool_input: { command } }), encoding: 'utf8', windowsHide: true });
}

const outsidePath = path.join(repoRoot, '..', 'scattered-ticket');
const cases = [
  ['canonical add', `git worktree add "${canonical}" -b feat/ticket HEAD`, 0],
  ['ordinary status', 'git status --short', 0],
  ['outside add', `git worktree add "${outsidePath}" HEAD`, 2],
  ['outside move', `git worktree move "${canonical}" "${outsidePath}"`, 2],
  ['chained adds', `git worktree add "${canonical}" HEAD && git worktree add "${outsidePath}" HEAD`, 2],
  ['newline adds', `git worktree add "${canonical}" HEAD\ngit worktree add "${outsidePath}" HEAD`, 2],
  ['quote-composed operation', `git work"tree" add "${outsidePath}" HEAD`, 2],
  ['escape-composed operation', `git worktr\\ee add "${outsidePath}" HEAD`, 2],
  ['variable-composed operation', `$op = 'worktree'; git $op add "${outsidePath}" HEAD`, 2],
  ['ordinary PowerShell variables', '$message = "hello"; Write-Output $message', 0],
  ['ordinary percent format', 'printf "%s\\n" "hello"', 0],
  ['ordinary command substitution', 'echo `date`', 0],
  ['list followed by outside add', `git worktree list && git worktree add "${outsidePath}" HEAD`, 2],
  ['list followed by outside move', `git worktree list; git worktree move "${canonical}" "${outsidePath}"`, 2],
  ['Git -C context', `git -C "${path.dirname(repoRoot)}" worktree add "${canonical}" HEAD`, 2],
  ['Git attached -C context', `git -C"${path.dirname(repoRoot)}" worktree add "${canonical}" HEAD`, 2],
  ['Git --git-dir context', `git --git-dir="${commonDir}" worktree add "${canonical}" HEAD`, 2],
  ['Git --work-tree context', `git --work-tree "${repoRoot}" worktree add "${canonical}" HEAD`, 2],
  ['Git bare context', `git --bare worktree add "${canonical}" HEAD`, 2],
  ['Git configured worktree', `git -c core.worktree="${repoRoot}" worktree add "${canonical}" HEAD`, 2],
  ['Git attached configured worktree', `git -ccore.worktree="${repoRoot}" worktree add "${canonical}" HEAD`, 2],
  ['Git harmless configuration', `git -c color.ui=never worktree add "${canonical}" HEAD`, 0],
  ['escape-composed add', `git worktree a\\dd "${outsidePath}" HEAD`, 2],
  ['escape-composed move', `git worktree mo\\ve "${canonical}" "${outsidePath}"`, 2],
  ['literal Git directory environment', `env GIT_DIR=/other/.git git worktree add "${canonical}" HEAD`, 2],
  ['literal Git worktree environment', `GIT_WORK_TREE=/other git worktree add "${canonical}" HEAD`, 2],
  ['literal Git common directory environment', `env GIT_COMMON_DIR=/other/.git git worktree add "${canonical}" HEAD`, 2],
  ['orphan destination', `git worktree add --orphan "${canonical}"`, 0],
  ['option terminator', `git worktree add -- "${canonical}" HEAD`, 0],
  ['branch option before destination', `git worktree add -b feat/ticket "${canonical}" HEAD`, 0],
  ['locked worktree with reason', `git worktree add --lock --reason "review fixture" "${canonical}" HEAD`, 0],
  ['canonical move', `git worktree move "${outsidePath}" "${canonical}"`, 0],
  ['canonical root itself', `git worktree add "${path.dirname(canonical)}" HEAD`, 2],
  ['parent traversal', `git worktree add "${path.join(path.dirname(canonical), '..', 'escaped')}" HEAD`, 2],
  ['prefix sibling', `git worktree add "${path.dirname(canonical)}-outside/ticket" HEAD`, 2],
];

for (const [name, command, expected] of cases) {
  test(name, () => {
    const result = invoke(command);
    assert.equal(result.status, expected, result.stderr || result.error?.message);
    if (expected === 2) assert.match(result.stderr, /enforce-worktree-location: blocked/);
  });
}
