import path from "node:path";
export type Permit = { sessionId: string; turnId?: string; worktreePath: string; phase: string; intentId?: string; frozenPlanPaths?: string[] };
export type MutationInput = { toolName: string; cwd: string; sessionId: string; permit: Permit | null; command?: string; intentId?: string };
const readTools = /^(view_image|update_plan|request_user_input|list_mcp_|read_mcp_|(?:mcp__|tools\.)?captain[-_]sdlc__captain_(?:status|user_authorization_status|user_request_status|merge_status|doctor))$/i;
const entryTools = /^(?:mcp__|tools\.)?captain[-_]sdlc__captain_(issue_intent|begin_implementation|resume_implementation|merge_prep|merge_back|merge_begin|merge_finish|recover_merge_lease)$/i;
const governedTools = /^(?:mcp__|tools\.)?captain[-_]sdlc__captain_(prepare_documentation|record_red|run_check|prepare_merge|abort_merge|commit|record_commit|prove|migrate_plan_state|record_plan_review|record_hitl_feedback|pause_implementation)$/i;
export function mutationDecision(input: MutationInput): { allow: boolean; reason?: string } {
  const frozenReason = frozenPlanMutationReason(input); if (frozenReason) return deny(frozenReason);
  if (readTools.test(input.toolName)) return { allow: true };
  if (entryTools.test(input.toolName)) return { allow: true };
  if (/^(Bash|exec_command)$/i.test(input.toolName) && isStrictReadShell(input.command ?? "")) return { allow: true };
  if (!input.permit) return deny("mutation denied until captain_begin_implementation consumes this session's implementation intent");
  if (input.permit.sessionId !== input.sessionId) return deny("implementation permit belongs to another Codex session");
  const governed = governedTools.exec(input.toolName);
  if (governed) { if (!input.intentId || input.intentId !== input.permit.intentId) return deny("governed tool intent does not match the active permit"); const operation = governed[1].toLowerCase(), expected: Record<string, string> = { prepare_documentation: "tdd_red", record_red: "tdd_red", run_check: "implement", prepare_merge: "implement", abort_merge: "implement", commit: "implement", record_commit: "implement", prove: "prove", migrate_plan_state: "implement", record_plan_review: "hitl" }; if (operation === "pause_implementation" || operation === "record_hitl_feedback") return ["tdd_red", "implement", "prove", "hitl"].includes(input.permit.phase) ? { allow: true } : deny(`${operation} is closed during ${input.permit.phase}`); if (operation === "prepare_documentation" && input.permit.phase === "implement") return { allow: true }; if (operation === "commit" && input.permit.phase === "prove") return { allow: true }; return input.permit.phase === expected[operation] ? { allow: true } : deny(`${governed[1]} is closed during ${input.permit.phase}`); }
  const owned = path.resolve(input.permit.worktreePath);
  if (/^(apply_patch|Edit|Write)$/i.test(input.toolName)) {
    const targets = patchTargets(input.command ?? "").map(target => path.resolve(input.cwd, target)); if (targets.length === 0) return deny("mutation target could not be proven");
    if (targets.some(target => !inside(owned, target))) return deny(`mutation target escapes owned worktree ${owned}`);
    if (targets.some(target => path.relative(owned, path.resolve(target)).replaceAll("\\", "/").split("/").some(segment => segment.toLowerCase() === ".git"))) return deny("Git metadata cannot be mutated through repository editing tools");
    if (input.permit.phase === "tdd_red" && targets.some(target => !isTestPath(path.relative(owned, path.resolve(target))))) return deny("before the red gate, only test/spec files may change");
    if (input.permit.phase !== "tdd_red" && input.permit.phase !== "implement") return deny(`mutations are closed during ${input.permit.phase}`);
    return { allow: true };
  }
  if (/^(Bash|exec_command)$/i.test(input.toolName) && input.permit.phase === "implement") {
    const cwd = path.resolve(input.cwd); if (!inside(owned, cwd) && cwd !== owned) return deny(`shell cwd escapes owned worktree ${owned}`);
    if (/^git\s+add\s+--\s+(?:[A-Za-z0-9._/-]+\s*)+$/i.test((input.command ?? "").trim())) return { allow: true };
  }
  return deny(`tool ${input.toolName} is not an audited Captain mutation path`);
}
const deny = (reason: string) => ({ allow: false, reason: `Captain SDLC: ${reason}.` });
export function frozenPlanMutationReason(input: MutationInput): string | undefined {
  if (!input.permit?.frozenPlanPaths?.length || !/^(apply_patch|Edit|Write)$/i.test(input.toolName)) return undefined;
  const normalize = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
  const frozen = new Set(input.permit.frozenPlanPaths.map(target => normalize(path.resolve(input.permit!.worktreePath, target))));
  if (patchTargets(input.command ?? "").some(target => frozen.has(normalize(path.resolve(input.cwd, target)))))
    return "frozen approved plan cannot be edited; record progress separately and offer new requirements as human-reviewed follow-ups";
  return undefined;
}
const inside = (root: string, target: string) => { const relative = path.relative(root, path.resolve(target)); return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative); };
const isTestPath = (relative: string) => /(^|\/)(tests?|specs?|test-support)(\/|$)|\.(test|spec)\.[^/]+$/i.test(relative.replaceAll("\\", "/"));
function patchTargets(command: string): string[] { return [...command.matchAll(/^\*\*\* (?:(?:Add|Update|Delete) File|Move to): (.+)$/gm)].map(match => match[1].trim()); }
function cleanSingleLine(command: string) { return command.trim() !== "" && !/[\r\n;&|><`$()%!]/.test(command); }
function isStrictReadShell(command: string): boolean { if (!cleanSingleLine(command)) return false; const value = command.trim(); if (/^rg(?:\.exe)?\b/i.test(value)) return !/(?:^|\s)(?:--pre|--pre-glob|--config-path|-z)(?:\s|=|$)/i.test(value) && !process.env.RIPGREP_CONFIG_PATH; return /^(Get-Content\s+(?:(?:-Raw|-LiteralPath)\s+){0,2}(?:'[^'*?]+'|"[^"*?]+"|[A-Za-z]:\\[^\s*?]+)|git\s+status(?:\s+--(?:short|porcelain))?|git\s+rev-parse\s+(?:HEAD|--show-toplevel)|git\s+ls-tree\s+(?:-r\s+)?(?:HEAD|[0-9a-f]{40,64}))$/i.test(value); }
