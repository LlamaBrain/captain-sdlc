#!/usr/bin/env node
// PreToolUse guard (matcher: Edit|Write|NotebookEdit). Blocks edits to files
// agents should never touch directly. Exit 2 + stderr = deny with a reason the
// agent can read; exit 0 = allow. Deny holds even under skip-permissions, so
// this is the one policy layer an unattended fleet agent cannot bypass.
// Fails open on malformed input: wedging every edit is worse than one miss.

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const p =
    (input.tool_input &&
      (input.tool_input.file_path || input.tool_input.notebook_path)) ||
    '';
  if (!p) process.exit(0);

  const norm = p.replace(/\\/g, '/');
  const base = norm.split('/').pop().toLowerCase();

  const rules = [
    {
      hit: /(^|\/)\.git\//.test(norm),
      why: '.git internals are managed by git, not edited',
    },
    {
      hit:
        /^\.env(\..+)?$/.test(base) &&
        !/\.(example|sample|template)$/.test(base),
      why: 'env files hold secrets — ask the human to change them',
    },
    {
      hit: [
        'package-lock.json',
        'pnpm-lock.yaml',
        'yarn.lock',
        'cargo.lock',
        'composer.lock',
        'gemfile.lock',
      ].includes(base),
      why: 'lockfiles are generated — run the package manager instead',
    },
    {
      hit: /\.(pem|keystore)$/.test(base) || /^id_(rsa|ed25519|ecdsa)/.test(base),
      why: 'private key material is never agent-editable',
    },
  ];

  const blocked = rules.find((r) => r.hit);
  if (blocked) {
    process.stderr.write(`protect-files: blocked edit to ${p} — ${blocked.why}`);
    process.exit(2);
  }
  process.exit(0);
});
