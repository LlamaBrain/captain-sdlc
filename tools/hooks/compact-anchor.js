#!/usr/bin/env node
// SessionStart hook (matcher: compact). Re-injects critical anchors after every
// context compaction — the rules most likely to be lost to compaction amnesia.
// stdout becomes additional context for the session. A project can override the
// defaults by providing .claude/anchors.md at its root.

const fs = require('fs');
const path = require('path');

const DEFAULT_ANCHORS = `# Post-compaction anchors
- A parallel agent fleet may be editing this repo concurrently. Trust committed
  state (git log), not working-tree snapshots; don't redo or race in-flight work.
- Never claim work complete without running the project's check (type check /
  lint / tests). If no check exists, say so explicitly instead of "done".
- The pre-compaction summary may have drifted: re-read a file before editing it
  if your knowledge of it predates the compaction.`;

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let cwd = process.cwd();
  try {
    const input = JSON.parse(raw);
    if (input.cwd) cwd = input.cwd;
  } catch {
    // fall through with process.cwd()
  }
  const projectAnchors = path.join(cwd, '.claude', 'anchors.md');
  let text = DEFAULT_ANCHORS;
  try {
    if (fs.existsSync(projectAnchors)) {
      text = fs.readFileSync(projectAnchors, 'utf8');
    }
  } catch {
    // unreadable project file → defaults
  }
  process.stdout.write(text);
  process.exit(0);
});
