const action = /\b(implement|build|create|add|change|modify|update|fix|repair|refactor|remove|delete|migrate|ship|rename|replace|wire|support)\b/i;
const goal = /\b(make|get)\b.{0,80}\b(work|working|support|handle|use)\b/i;
export function classifyImplementationIntent(prompt: string): boolean { const value = prompt.trim(); if (!value || /^(explain|review|inspect|analy[sz]e|diagnose|investigate|report|summari[sz]e|what|why|where|when|status)\b/i.test(value)) return false; if (/^how\s+(do|does|would|should)\b/i.test(value)) return false; return action.test(value) || goal.test(value); }
