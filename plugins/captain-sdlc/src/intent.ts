export function classifyImplementationIntent(prompt: string): boolean { return extractCaptainPlanTask(prompt) !== undefined || extractCaptainResumeIntent(prompt) !== undefined; }
export function extractCaptainPlanTask(prompt: string): string | undefined {
  const directives = prompt.split(/\r?\n/).filter(line => /^\s*\[Captain plan:/i.test(line));
  if (directives.length > 1) throw new Error("Captain plan directive is ambiguous");
  if (!directives.length) return undefined;
  const match = /^\s*\[Captain plan:\s*([A-Za-z0-9][A-Za-z0-9._#-]*)\]\s*$/i.exec(directives[0]);
  if (!match || match[1].includes("..")) throw new Error("Captain plan directive is invalid");
  return match[1];
}
export function extractCaptainResumeIntent(prompt: string): string | undefined {
  const directives = prompt.split(/\r?\n/).filter(line => /^\s*\[Captain resume:/i.test(line));
  if (directives.length > 1) throw new Error("Captain resume directive is ambiguous");
  if (!directives.length) return undefined;
  const match = /^\s*\[Captain resume:\s*(intent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\s*$/i.exec(directives[0]);
  if (!match) throw new Error("Captain resume directive is invalid");
  return match[1];
}
export function extractAuthorizedTargetBranch(prompt: string): string | undefined {
  const directives = prompt.split(/\r?\n/).filter(line => /^\s*\[Captain target:/i.test(line));
  if (directives.length > 1) throw new Error("Captain target directive is ambiguous");
  if (!directives.length) return undefined;
  const match = /^\s*\[Captain target:\s*([A-Za-z0-9][A-Za-z0-9._/-]*)\]\s*$/i.exec(directives[0]);
  if (!match) throw new Error("Captain target directive is invalid");
  const branch = match[1];
  if (branch.includes("..") || branch.includes("//") || branch.includes("@{") || branch.endsWith("/") || branch.endsWith(".") || branch.toLowerCase().endsWith(".lock")) throw new Error("Captain target directive is invalid");
  return branch;
}
