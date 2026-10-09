#!/usr/bin/env node
import { readAuthorized } from "../dist/authority.js";
import { latestRun, validPermit } from "./authoritative-state.mjs";
import { hooksEnabled } from "./hook-control.mjs";
import { repositoryUsesLowStrictness, verifyLowStrictCompletion } from "./governed-repository.mjs";
let raw = ""; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || "{}"), data = process.env.PLUGIN_DATA || process.env.CAPTAIN_PLUGIN_DATA; if (!data) process.exit(0);
if (!await hooksEnabled(data)) process.exit(0);
if (await repositoryUsesLowStrictness(input.cwd || process.cwd())) {
  let turn; try { turn = await readAuthorized(data, "turns", `${input.session_id}-${input.turn_id}`); } catch { process.exit(0); }
  if (!turn?.implementationRequired) process.exit(0);
  const result = await verifyLowStrictCompletion(input.cwd || process.cwd());
  if (!result.ok) process.stdout.write(JSON.stringify({ decision: "block", reason: `Captain SDLC low-strict completion check failed: ${result.reason}.` }));
  process.exit(0);
}
try { const pausedPermit = await readAuthorized(data, "permits", `${input.session_id}-${input.turn_id}`), pausedRun = await latestRun(data, pausedPermit.intentId), handoff = await readAuthorized(data, "pause-handoffs", `${pausedRun.intentId}-${pausedRun.revision}`); if (pausedRun.status === "paused" && handoff.runId === pausedRun.runId && handoff.sessionId === input.session_id && handoff.turnId === input.turn_id) process.exit(0); } catch {}
let turn; try { turn = await readAuthorized(data, "turns", `${input.session_id}-${input.turn_id}`); } catch {}
let permit; try { permit = await readAuthorized(data, "permits", `${input.session_id}-${input.turn_id}`); } catch { if (turn?.implementationRequired) process.stdout.write(JSON.stringify({ decision: "block", reason: "Captain SDLC implementation intent has no valid turn permit. Begin or resume the governed run before completion." })); process.exit(0); }
let run; try { run = await latestRun(data, permit.intentId); if (run.status !== "green") ({ run } = await validPermit(data, input.session_id, input.turn_id)); } catch { process.stdout.write(JSON.stringify({ decision: "block", reason: "Captain SDLC authoritative run state or current permit is missing or invalid." })); process.exit(0); }
try { const handoff = await readAuthorized(data, "pause-handoffs", `${run.intentId}-${run.revision}`); if (handoff.runId === run.runId && handoff.sessionId === input.session_id && handoff.turnId === input.turn_id) process.exit(0); } catch {}
if (run.phase === "hitl" && run.status === "running") {
  process.stdout.write(JSON.stringify({ systemMessage: `Captain SDLC run ${run.intentId} has completed automated proof and is pending human HITL review. Yield with the frozen review goals and evidence; plan acceptance is not complete. Retain this run and worktree for review or repair.` }));
  process.exit(0);
}
if (run.status !== "green" || run.phase !== "complete") process.stdout.write(JSON.stringify({ decision: "block", reason: `Captain SDLC run ${run.intentId} is ${run.phase}/${run.status}. Continue the governed pipeline; completion requires a green proof ledger.` }));
