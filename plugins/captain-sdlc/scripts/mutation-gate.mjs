#!/usr/bin/env node
import { mutationDecision } from "../dist/policy.js";
import { readAuthorized } from "../dist/authority.js";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
let raw = ""; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || "{}"), data = process.env.PLUGIN_DATA || process.env.CAPTAIN_PLUGIN_DATA;
let permit = null;
if (data && input.session_id && input.turn_id) { try { permit = await readAuthorized(data, "permits", `${input.session_id}-${input.turn_id}`); } catch {} }
const auditedInput = input.tool_input?.command || input.tool_input?.cmd || input.tool_input?.patch || "";
const decision = mutationDecision({ toolName: input.tool_name || "", cwd: input.cwd || process.cwd(), sessionId: input.session_id || "", turnId: input.turn_id || "", permit, command: auditedInput });
if (decision.allow && permit && /(?:^|\.)(?:apply_patch|Edit|Write)$/i.test(input.tool_name || "")) {
  const targets = [...String(auditedInput).matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(m => path.resolve(m[1].trim()));
  for (const target of targets) for (let cursor = path.dirname(target); cursor.startsWith(path.resolve(permit.worktreePath)); cursor = path.dirname(cursor)) { try { const info = await lstat(cursor); if (info.isSymbolicLink() || !path.resolve(await realpath(cursor)).startsWith(path.resolve(permit.worktreePath))) throw new Error("reparse"); } catch (error) { if (error?.code !== "ENOENT") { decision.allow = false; decision.reason = "Captain SDLC: mutation target crosses a reparse point or physical worktree boundary."; break; } } if (cursor === path.resolve(permit.worktreePath)) break; }
}
if (!decision.allow) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: decision.reason } }));
