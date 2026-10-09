#!/usr/bin/env node
import { mutationDecision, frozenPlanMutationReason } from "../dist/policy.js";
import { validPermit } from "./authoritative-state.mjs";
import { repositoryIsGoverned, repositoryUsesLowStrictness } from "./governed-repository.mjs";
import { hooksEnabled } from "./hook-control.mjs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
let raw = ""; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || "{}"), data = process.env.PLUGIN_DATA || process.env.CAPTAIN_PLUGIN_DATA;
const auditedInput = /^(Edit|Write)$/i.test(input.tool_name || "") && typeof input.tool_input?.file_path === "string"
  ? `*** Update File: ${input.tool_input.file_path}`
  : input.tool_input?.command || input.tool_input?.cmd || input.tool_input?.patch || "";
if (/(?:^|[\\/])hook-control\.mjs\s+(?:on|off|status)\s*$/i.test(String(auditedInput).trim())) process.exit(0);
if (data && !await hooksEnabled(data)) process.exit(0);
let permit = null;
if (data && input.session_id && input.turn_id) { try { ({ permit } = await validPermit(data, input.session_id, input.turn_id)); } catch {} }
const frozenReason = frozenPlanMutationReason({ toolName: input.tool_name || "", cwd: input.cwd || process.cwd(), sessionId: input.session_id || "", permit, command: auditedInput });
if (frozenReason) { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Captain SDLC: ${frozenReason}.` } })); process.exit(0); }
if (await repositoryUsesLowStrictness(input.cwd || process.cwd())) process.exit(0);
if (!await repositoryIsGoverned(input.cwd || process.cwd())) process.exit(0);
const decision = mutationDecision({ toolName: input.tool_name || "", cwd: input.cwd || process.cwd(), sessionId: input.session_id || "", turnId: input.turn_id || "", permit, command: auditedInput, intentId: input.tool_input?.intent_id || input.tool_input?.resume_intent_id });
if (decision.allow && permit && /(?:^|\.)(?:apply_patch|Edit|Write)$/i.test(input.tool_name || "")) {
  const targets = [...String(auditedInput).matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map(m => path.resolve(input.cwd || process.cwd(), m[1].trim()));
  const owned = path.resolve(permit.worktreePath), physicalOwned = path.resolve(await realpath(owned));
  const insideOrSame = candidate => { const relative = path.relative(owned, path.resolve(candidate)); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
  for (const target of targets) for (let cursor = target; insideOrSame(cursor); cursor = path.dirname(cursor)) { try { const info = await lstat(cursor); const physical = path.resolve(await realpath(cursor)), relative = path.relative(physicalOwned, physical); if (info.isSymbolicLink() || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) throw new Error("reparse"); } catch (error) { if (error?.code !== "ENOENT") { decision.allow = false; decision.reason = "Captain SDLC: mutation target crosses a reparse point or physical worktree boundary."; break; } } if (path.resolve(cursor).toLowerCase() === owned.toLowerCase()) break; }
}
if (!decision.allow) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason } }));
