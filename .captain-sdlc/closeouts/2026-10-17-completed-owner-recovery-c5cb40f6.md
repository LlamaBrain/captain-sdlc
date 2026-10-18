# Captain retained task-owner recovery

## Delivery

Authenticated failed-Begin recovery now accepts a separate completed retained task-owner projection only after verifying its exact shape, released revisioned session lease, original Begin, current activation and latest signed run chain. Pending work/review, active leases, malformed ownership and new-intent progress remain refused.

The signed primary repository and the registered target checkout are authenticated separately. Existing canonical task checkouts are supported. Wrong caller checkouts retain the existing request-refusal code after Git inspection derived only from trusted signed inputs.

## Identity

- Repair intent: intent-c5cb40f6-aec6-4763-b9f4-b58fc07d6450.
- Worktree: E:/Personal/captain-sdlc/.captain-sdlc/worktrees/intent-c5cb40f6-aec6-4763-b9f4-b58fc07d6450.
- Branch: fix/captain-completed-owner-recovery-20261017.
- Final implementation: 53389a2af9c746c19c0eaccd205772a65c83af3d, v0.6.3.
- Earlier implementations 925096e/v0.6.1 and 8fb583d/v0.6.2, with their failed full tickets, remain preserved.

## Evidence

- Original signed trusted red: exit 1, output SHA256 982ed13d4855b281ba7212902638bf7865bbbbcfee39d641b5124a40dad5c820.
- Immutable 87d7e97 focused baseline: 10 cases, 3 expected assertion failures and 7 passes. This separately retained replay does not replace original signed red.
- Final source-level owner/legacy guards: 22/22 green, including the original 10 completed-owner/canonical cases.
- Compatibility red: 14 cases, 13 pass/1 expected assertion failure. Compatibility green: 14/14, including trusted-path inspector assertions.
- Full diagnostic ticket at 8fb583d: 613 cases, 606 pass/7 fail. Every failure was mapped to absent legacy revision history or hidden progressed-Begin diagnostics before repair.
- Both existing progressed-Begin SDK/race cancellation guards: 2/2 green after repair.
- Final configured FEATURE proof: complete/green at 2026-10-18T03:02:59Z. Build, full ticket, public MCP smoke suite and typecheck all exited 0 at 53389a2.
- Public candidate recovery: game root owner diagnosed and revoked only intent-b18417f5-0fb5-47b9-8b24-8b96a37e5c7a at 2026-10-18T02:13:23Z through 0.6.1 public tools, preserving its previous completed owner and retained checkout. Game evidence: Logs/nighttime-visibility/recovery-diagnose.json and recovery-applied.json.
- Repair evidence directory: plugins/captain-sdlc/Temp/automation-scratch/completed-owner-repair/ (focused logs, baseline replay, all final proof results and installation receipt).
- Durable incident: Churn/2026-10-17-completed-owner-failed-begin-recovery.md.

## Installed runtime

Installed v0.6.3 into the existing registered runtime directory C:/Users/metag/.codex/plugins/cache/personal/captain-sdlc/0.6.0. Nineteen owned files were replaced atomically after verifying the original 0.6.0 server hash; prior files were backed up under the repair evidence directory's install-backup-0.6.0/. Installation receipt: install-receipt.json. A fresh installed public MCP handshake at 2026-10-18T03:03:38Z advertised 0.6.3 and returned the same signed complete/green repair status (installed-public-status.json).

Source/runtime SHA256: da36074889c4a38772002d58fd6249f6fb8125cf9037a2c195af6f9dbb7462ab.
Global plugin registration, hook definitions and existing authority data were preserved. Existing MCP processes may retain older loaded code; a fresh public stdio connection advertises the installed version.

## Limits and next owner

No merge, push or hosted CI was performed. Configured local Captain proof and installation are distinct from source integration. The game root owner continues its separately governed game fix in the existing retained checkout.

Failed-gate stdout retention and the expensive full Git-fixture ticket are recorded as nonblocking follow-ups; they were not expanded into this repair.
