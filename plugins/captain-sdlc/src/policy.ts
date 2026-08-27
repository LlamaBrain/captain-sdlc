import path from "node:path";
export type Permit = { sessionId: string; worktreePath: string; phase: string; intentId?: string };
export type MutationInput = { toolName: string; cwd: string; sessionId: string; permit: Permit | null; command?: string };
const readTools = /^(view_image|update_plan|request_user_input|list_mcp_|read_mcp_|(?:mcp__|tools\.)?captain[-_]sdlc__captain_(begin_implementation|resume_implementation|record_red|run_check|commit|record_commit|prove|status))$/i;
export function mutationDecision(input: MutationInput): { allow: boolean; reason?: string } {
  if (readTools.test(input.toolName)) return { allow: true };
  if (/^(Bash|exec_command)$/i.test(input.toolName) && isStrictReadShell(input.command ?? "")) return { allow: true };
  if (!input.permit) return deny("mutation denied until captain_begin_implementation consumes this session's implementation intent");
  if (input.permit.sessionId !== input.sessionId) return deny("implementation permit belongs to another Codex session");
  const owned = path.resolve(input.permit.worktreePath);
  if (/^(apply_patch|Edit|Write)$/i.test(input.toolName)) {
    const targets = patchTargets(input.command ?? ""); if (targets.length === 0) return deny("mutation target could not be proven");
    if (targets.some(target => !inside(owned, target))) return deny(`mutation target escapes owned worktree ${owned}`);
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
const inside = (root: string, target: string) => { const relative = path.relative(root, path.resolve(target)); return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative); };
const isTestPath = (relative: string) => /(^|\/)(tests?|specs?|test-support)(\/|$)|\.(test|spec)\.[^/]+$/i.test(relative.replaceAll("\\", "/"));
function patchTargets(command: string): string[] { return [...command.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map(match => match[1].trim()); }
function cleanSingleLine(command: string) { return command.trim() !== "" && !/[\r\n;&|><`$()%!]/.test(command); }
function isStrictReadShell(command: string): boolean { if (!cleanSingleLine(command)) return false; const value = command.trim(); if (/^rg(?:\.exe)?\b/i.test(value)) return !/(?:^|\s)(?:--pre|--pre-glob|--config-path|-z)(?:\s|=|$)/i.test(value) && !process.env.RIPGREP_CONFIG_PATH; return /^(Get-Content\s+-LiteralPath\s+[^*?]+|git\s+status(?:\s+--(?:short|porcelain))?|git\s+rev-parse\s+(?:HEAD|--show-toplevel)|git\s+ls-tree\s+(?:-r\s+)?(?:HEAD|[0-9a-f]{40,64}))$/i.test(value); }
