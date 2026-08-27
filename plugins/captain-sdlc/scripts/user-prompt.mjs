#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import path from "node:path";
import { classifyImplementationIntent } from "../dist/intent.js";
import { readAuthorized, writeAuthorized } from "../dist/authority.js";
let raw = ""; for await (const chunk of process.stdin) raw += chunk;
const input = JSON.parse(raw || "{}"), prompt = input.prompt || input.user_prompt || "";
const data = process.env.PLUGIN_DATA || process.env.CAPTAIN_PLUGIN_DATA; if (!data) throw new Error("PLUGIN_DATA is required");
let active = null; try { active = await readAuthorized(data, "active", input.session_id); } catch {}
if (active?.complete) active = null;
const implementationRequired = classifyImplementationIntent(prompt) || Boolean(active);
await writeAuthorized(data, "turns", `${input.session_id}-${input.turn_id}`, { implementationRequired });
if (!implementationRequired) process.exit(0);
const intentId = `intent-${randomUUID()}`;
const requestedProfile = /\b(pre[- ]?release|release candidate|ship (?:the )?release)\b/i.test(prompt) ? "pre-release" : "feature";
const record = { intentId, sessionId: input.session_id, turnId: input.turn_id, projectRoot: path.resolve(input.cwd), prompt, requestedProfile, ...(active ? { resumeOf: active.intentId } : {}) };
await writeAuthorized(data, "intents", intentId, record);
const instruction = active ? `Resume active Captain run ${active.intentId} by calling captain_resume_implementation with resume_intent_id=${intentId} before mutation.` : `Before mutation, call captain_begin_implementation with intent_id=${intentId}, the user's objective, and project_root=${record.projectRoot}. The trusted repository policy owns feature/pre-release and visual requirements.`;
process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `CAPTAIN SDLC ENFORCEMENT: ${instruction} Work only in the returned worktree. Follow red → implement → versioned atomic commit → scoped proof. Do not claim completion unless captain_status is green.` } }));
