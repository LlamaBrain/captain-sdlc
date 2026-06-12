#!/usr/bin/env node
// Stop hook: deterministic "done means verified". Opt-in per project — runs the
// check command from .claude/verify-gate.json at the project root and blocks the
// turn from ending (exit 2) until it passes. No config file → no-op, so
// exploratory and docs-only projects are unaffected.
//
//   .claude/verify-gate.json: { "command": "npx tsc --noEmit", "timeoutMs": 180000 }
//
// Loop safety: after MAX_BLOCKS consecutive failures in one session the gate
// stands down and lets the turn end, reporting that the check is still red.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const MAX_BLOCKS = 3;

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input = {};
  try {
    input = JSON.parse(raw);
  } catch {
    // proceed with defaults
  }
  const cwd = input.cwd || process.cwd();
  const configPath = path.join(cwd, '.claude', 'verify-gate.json');
  if (!fs.existsSync(configPath)) process.exit(0);

  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`verify-gate: unreadable ${configPath} — gate skipped (${e.message})`);
    process.exit(0);
  }
  if (!config.command) process.exit(0);

  const counterPath = path.join(
    os.tmpdir(),
    `verify-gate-${(input.session_id || 'unknown').replace(/[^a-z0-9-]/gi, '')}.count`
  );
  let blocks = 0;
  try {
    blocks = parseInt(fs.readFileSync(counterPath, 'utf8'), 10) || 0;
  } catch {
    // no counter yet
  }

  try {
    execSync(config.command, {
      cwd,
      timeout: config.timeoutMs || 180000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try { fs.unlinkSync(counterPath); } catch {}
    process.exit(0);
  } catch (e) {
    const tail = (out) => (out ? out.toString().split('\n').slice(-15).join('\n') : '');
    const detail = [tail(e.stdout), tail(e.stderr)].filter(Boolean).join('\n');
    if (blocks >= MAX_BLOCKS) {
      try { fs.unlinkSync(counterPath); } catch {}
      process.stderr.write(
        `verify-gate: check still failing after ${MAX_BLOCKS} blocked stops — standing down. Tell the user the check is red.\n${detail}`
      );
      process.exit(0);
    }
    try { fs.writeFileSync(counterPath, String(blocks + 1)); } catch {}
    process.stderr.write(
      `verify-gate: "${config.command}" failed — fix before finishing (attempt ${blocks + 1}/${MAX_BLOCKS}).\n${detail}`
    );
    process.exit(2);
  }
});
