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
  const tokens = [...command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)]
    .map((match) => match[1] ?? match[2] ?? match[3]);
  const worktreeIndex = tokens.findIndex((token, index) =>
    token.toLowerCase() === 'worktree' && /^(?:add|move)$/i.test(tokens[index + 1] || ''));
  const composedWords = /[A-Za-z]["'^][A-Za-z]/.test(command)
    || /git\s+\S*\\\S*\s+(?:add|move)\b/i.test(command);
  const composedWorktree = (composedWords || worktreeIndex < 0)
    && /\bworktree\s+(?:add|move)\b/i.test(command.replace(/["'^\\]/g, ''));
  const indirectWorktree = /\bworktree\b/i.test(command) && /\bgit\s+["']?[$`%]/i.test(command);
  if (worktreeIndex < 0 && !composedWorktree && !indirectWorktree) process.exit(0);

  if (/[$`%]/.test(command)) deny('shell expansion is not allowed in guarded commands');
  if (composedWords || composedWorktree) deny('shell-composed command words are not allowed');
  const action = (tokens[worktreeIndex + 1] || '').toLowerCase();
  if (/[;&|\r\n]/.test(command)) deny('chained worktree commands are not allowed');
  // The hook resolves the repository from cwd; alternate Git contexts must not
  // be checked against that unrelated repository's containment root.
  const globalArgs = tokens.slice(0, worktreeIndex);
  if (/\bGIT_(?:DIR|WORK_TREE|COMMON_DIR)=/i.test(command) || globalArgs.some((token, index) =>
    /^-C/.test(token) || /^--(?:git-dir|work-tree)(?:=|$)/.test(token)
    || token === '--bare' || /^-ccore\.worktree=/i.test(token)
    || (token === '-c' && /^core\.worktree=/i.test(globalArgs[index + 1] || '')))) {
    deny('unsupported Git repository context; run from the owning repository without Git context options or environment overrides');
  }

  const cwd = input.cwd || process.cwd();
  const destination = action === 'add'
    ? addDestination(tokens.slice(worktreeIndex + 2))
    : tokens.at(-1);
  if (!destination) deny('could not determine the worktree destination');

  let commonDir;
  try {
    commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', windowsHide: true }).trim();
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
  const consumesValue = new Set(['-b', '-B', '--reason']);
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === '--') return args[index + 1] || null;
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
