#!/usr/bin/env node
// PreToolUse guard (matcher: Bash). Blocks `git commit` while HEAD is a
// protected branch, so work starts on dev / feature/* and reaches main only by
// squash PR (ADR-0017). Git hygiene is correctness, not taste (ADR-0012), so
// the tool owns it rather than a convention doc. Exit 2 + stderr = deny; exit
// 0 = allow. The squash gate itself is enforced server-side by the GitHub
// ruleset — this catches the local foot-gun before the bad commit exists.
// Default protects `main`; a project widens the set via
// .claude/branch-policy.json: { "protected": ["main", "dev"] }.
// Fails open on anything unexpected: wedging every commit is worse than a miss.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const cmd = (input.tool_input && input.tool_input.command) || '';
  // Only commits matter. Crude match covers `git commit`, `git -C x commit`,
  // and chained `... && git commit`. ponytail: misses exotic aliases/wrappers.
  if (!/\bgit\b[^|&;]*\bcommit\b/.test(cmd)) process.exit(0);

  const cwd = input.cwd || process.cwd();

  let branch;
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd,
      encoding: 'utf8',
    }).trim();
  } catch {
    process.exit(0); // not a git repo / detached HEAD — don't interfere
  }

  let protectedBranches = ['main'];
  try {
    const cfg = JSON.parse(
      fs.readFileSync(path.join(cwd, '.claude', 'branch-policy.json'), 'utf8')
    );
    if (Array.isArray(cfg.protected)) protectedBranches = cfg.protected;
  } catch {
    /* no policy file — keep the default */
  }

  if (protectedBranches.includes(branch)) {
    process.stderr.write(
      `protect-branch: blocked commit on protected branch "${branch}" — ` +
        `work on dev or feature/* and squash to ${branch} via PR (ADR-0017). ` +
        `Override in .claude/branch-policy.json.`
    );
    process.exit(2);
  }
  process.exit(0);
});
