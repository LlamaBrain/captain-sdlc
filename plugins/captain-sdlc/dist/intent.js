const action = /\b(implement|integrate|merge|build|create|add|change|modify|update|fix|repair|refactor|remove|delete|migrate|ship|rename|replace|wire|support)\b/i;
const goal = /\b(make|get)\b.{0,80}\b(work|working|support|handle|use)\b/i;
export function classifyImplementationIntent(prompt) { const value = prompt.trim(); if (!value || /^(explain|review|inspect|analy[sz]e|diagnose|investigate|report|summari[sz]e|what|why|where|when|status)\b/i.test(value))
    return false; if (/^how\s+(do|does|would|should)\b/i.test(value))
    return false; return action.test(value) || goal.test(value); }
export function extractAuthorizedTargetBranch(prompt) {
    const directives = prompt.split(/\r?\n/).filter(line => /^\s*\[Captain target:/i.test(line));
    if (directives.length > 1)
        throw new Error("Captain target directive is ambiguous");
    if (!directives.length)
        return undefined;
    const match = /^\s*\[Captain target:\s*([A-Za-z0-9][A-Za-z0-9._/-]*)\]\s*$/i.exec(directives[0]);
    if (!match)
        throw new Error("Captain target directive is invalid");
    const branch = match[1];
    if (branch.includes("..") || branch.includes("//") || branch.includes("@{") || branch.endsWith("/") || branch.endsWith(".") || branch.toLowerCase().endsWith(".lock"))
        throw new Error("Captain target directive is invalid");
    return branch;
}
