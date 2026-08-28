#!/usr/bin/env node
import { readAuthorized } from "../dist/authority.js";
import { latestRun, validPermit } from "./authoritative-state.mjs";
let raw = ""; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || "{}"), data = process.env.PLUGIN_DATA || process.env.CAPTAIN_PLUGIN_DATA; if (!data) process.exit(0);
let turn; try { turn = await readAuthorized(data, "turns", `${input.session_id}-${input.turn_id}`); } catch {}
let permit; try { permit = await readAuthorized(data, "permits", `${input.session_id}-${input.turn_id}`); } catch { if (turn?.implementationRequired) process.stdout.write(JSON.stringify({ decision: "block", reason: "Captain SDLC implementation intent has no valid turn permit. Begin or resume the governed run before completion." })); process.exit(0); }
let run; try { run = await latestRun(data, permit.intentId); if (run.status !== "green") ({ run } = await validPermit(data, input.session_id, input.turn_id)); } catch { process.stdout.write(JSON.stringify({ decision: "block", reason: "Captain SDLC authoritative run state or current permit is missing or invalid." })); process.exit(0); }
if (run.status !== "green" || run.phase !== "complete") process.stdout.write(JSON.stringify({ decision: "block", reason: `Captain SDLC run ${run.intentId} is ${run.phase}/${run.status}. Continue the governed pipeline; completion requires a green proof ledger.` }));
