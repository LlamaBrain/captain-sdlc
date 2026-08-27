#!/usr/bin/env node
// PreToolUse guard for shell commands. Every Git worktree owned by a repository
// must live below <primary-repo>/.captain-sdlc/worktrees/.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let raw = '';
process.stdin.on('data', (chunk) => (raw += chunk));
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }

  const command = input.tool_input?.command || input.command || '';
  if (/[$`%]/.test(command)) deny('shell expansion is not allowed in guarded commands');
  if (/[A-Za-z]["'^][A-Za-z]/.test(command) || /git\s+\S*\\\S*\s+(?:add|move)\b/i.test(command)) deny('shell-composed command words are not allowed');
  const tokens = [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3]);
  const worktreeIndex = tokens.findIndex((token) => token.toLowerCase() === 'worktree');
  if (worktreeIndex < 0) process.exit(0);

  const action = (tokens[worktreeIndex + 1] || '').toLowerCase();
  if (action !== 'add' && action !== 'move') process.exit(0);
  if (/[;&|\r\n]/.test(command)) deny('chained worktree commands are not allowed');

  const cwd = input.cwd || process.cwd();
  const destination = action === 'add'
    ? addDestination(tokens.slice(worktreeIndex + 2))
    : tokens.at(-1);
  if (!destination) deny('could not determine the worktree destination');

  let commonDir;
  try {
    commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8' }).trim();
  } catch {
    deny('could not resolve the owning repository');
  }

  const canonicalRoot = path.resolve(path.dirname(commonDir), '.captain-sdlc', 'worktrees');
  const resolvedDestination = path.resolve(cwd, destination);
  const relative = path.relative(canonicalRoot, resolvedDestination);
  const contained = relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  if (!contained) deny(`destination must be inside ${canonicalRoot}; received ${resolvedDestination}`);
  rejectReparsePoints(path.dirname(commonDir), resolvedDestination);
  process.exit(0);
});

function addDestination(args) {
  const consumesValue = new Set(['-b', '-B', '--reason', '--orphan']);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (consumesValue.has(token)) { index += 1; continue; }
    if (token.startsWith('-')) continue;
    return token;
  }
  return null;
}

function rejectReparsePoints(repoRoot, destination) {
  const relative = path.relative(repoRoot, destination);
  let cursor = repoRoot;
  for (const part of relative.split(path.sep)) {
    cursor = path.join(cursor, part);
    if (!fs.existsSync(cursor)) continue;
    if (fs.lstatSync(cursor).isSymbolicLink()) deny(`destination crosses a symlink or junction: ${cursor}`);
  }
}

function deny(reason) {
  process.stderr.write(`enforce-worktree-location: blocked git worktree command - ${reason}`);
  process.exit(2);
}
