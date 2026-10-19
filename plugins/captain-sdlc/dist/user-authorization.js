import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { putAuthorizedOnceExact, readAuthorized } from "./authority.js";
import { git } from "./workspace.js";
const guidance = "Receipts preserve the user's original authorization for the same task. Honor later revocations and the recorded operation/target; a commit receipt does not authorize push, merge, or disabling controls. Check Git hygiene, then act without asking again. Missing parser receipts do not negate authorization already present in the conversation.";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pathKey = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
// Deliberately recognize direct instructions, not discussion about permission. This
// is evidence capture, never a new mandatory approval gate or a magic-phrase rule.
export function parseUserAuthorizations(prompt) {
    const result = [];
    let fence;
    for (const raw of prompt.split(/\r?\n/)) {
        const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(raw);
        if (fence) {
            if (marker && marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim())
                fence = undefined;
            continue;
        }
        if (marker) {
            if (marker[1][0] === "~" || !marker[2].includes("`"))
                fence = { character: marker[1][0], length: marker[1].length };
            continue;
        }
        if (/^(?: {4}| {0,3}\t)/.test(raw))
            continue;
        const quote = raw.trim();
        if (/^[>"'`]/.test(quote))
            continue;
        const text = quote.replace(/[.!]+$/, "").replace(/^(?:please\s+|go ahead and\s+)/i, "");
        const negative = /^(?:do not|don't|stop|cancel)\s+/i.test(text);
        const action = negative ? text.replace(/^(?:do not|don't|stop|cancel)\s+/i, "") : text.replace(/^(?:approve|authorize)\s+(?:the\s+)?/i, "");
        const decision = negative ? "revoke" : "approve";
        if (/^(?:do (?:a |the )?)?commit(?:ting)?(?:\s+(?:it|this|that|the changes|these changes|your work|the work))?(?:\s+(?:now|already|please))?$/i.test(action)) {
            result.push({ operation: "commit", decision, quote });
            continue;
        }
        const mergeBack = /^(?:(revoke)\s+(?:the\s+)?)?merge(?:\s+(?:back|finish)|-(?:back|finish))(?:\s+(?:it|this|that|the changes|these changes))?(?:\s+(?:to|into)\s+([A-Za-z0-9_][A-Za-z0-9._/-]*))?$/i.exec(action);
        if (mergeBack) {
            result.push({ operation: "merge", decision: mergeBack[1] ? "revoke" : decision, ...(mergeBack[2] ? { targetBranch: mergeBack[2] } : {}), quote });
            continue;
        }
        const merge = /^merge(?:\s+(?:it|this|that|the changes|these changes))?\s+(?:to|into)\s+([A-Za-z0-9_][A-Za-z0-9._/-]*)$/i.exec(action);
        if (merge)
            result.push({ operation: "merge", decision, targetBranch: merge[1], quote });
    }
    return result;
}
async function repositoryScope(root) {
    const [projectRoot, commonGitDir, sourceBranch] = await Promise.all([
        git(["rev-parse", "--show-toplevel"], root),
        git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root),
        git(["branch", "--show-current"], root),
    ]);
    return { projectRoot: path.resolve(projectRoot), commonGitDir: path.resolve(commonGitDir), sourceBranch };
}
export async function recordUserAuthorizations(data, input) {
    const events = parseUserAuthorizations(input.prompt);
    if (!events.length)
        return [];
    if (!input.sessionId || !input.turnId)
        throw new Error("User authorization needs its source session and turn");
    const scope = await repositoryScope(input.projectRoot), receipts = [];
    for (const [instructionIndex, event] of events.entries()) {
        if (event.targetBranch)
            await git(["check-ref-format", "--branch", event.targetBranch], scope.projectRoot);
        const binding = { ...event, ...scope, sessionId: input.sessionId, turnId: input.turnId, instructionIndex, ...(input.intentId ? { intentId: input.intentId } : {}), ...(input.taskId ? { taskId: input.taskId } : {}), source: input.source };
        const id = hash(binding);
        try {
            receipts.push(await readAuthorized(data, "user-authorizations", id));
            continue;
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
        const receipt = { schemaVersion: 1, id, ...binding, recordedAt: new Date().toISOString() };
        try {
            receipts.push(await putAuthorizedOnceExact(data, "user-authorizations", id, receipt));
        }
        catch (error) {
            // A simultaneous replay may have published the same user event first.
            const existing = await readAuthorized(data, "user-authorizations", id);
            const { schemaVersion, id: existingId, recordedAt, ...existingBinding } = existing;
            if (schemaVersion !== 1 || existingId !== id || hash(existingBinding) !== id)
                throw error;
            receipts.push(existing);
        }
    }
    return receipts;
}
export async function userAuthorizationStatus(data, query) {
    if (!query.sessionId && !query.intentId)
        throw new Error("Select a source session or governed intent for authorization lookup");
    let names;
    try {
        names = await readdir(path.join(data, "user-authorizations"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return { receipts: [], guidance };
        throw error;
    }
    const scope = await repositoryScope(query.projectRoot), receipts = [];
    for (const name of names.filter(value => /^[a-f0-9]{64}\.json$/.test(value))) {
        const receipt = await readAuthorized(data, "user-authorizations", name.slice(0, -5));
        if (receipt.schemaVersion !== 1 || pathKey(receipt.commonGitDir) !== pathKey(scope.commonGitDir))
            continue;
        if (query.intentId ? receipt.intentId !== query.intentId : receipt.sessionId !== query.sessionId || receipt.sourceBranch !== scope.sourceBranch)
            continue;
        if (query.operation && receipt.operation !== query.operation)
            continue;
        // A generic stop applies to named targets; a generic approval does not.
        if (query.targetBranch && receipt.targetBranch !== query.targetBranch &&
            !(receipt.targetBranch === undefined && receipt.decision === "revoke"))
            continue;
        receipts.push(receipt);
    }
    receipts.sort((a, b) => a.sessionId === b.sessionId && a.turnId === b.turnId
        ? a.instructionIndex - b.instructionIndex || a.id.localeCompare(b.id)
        : a.recordedAt.localeCompare(b.recordedAt) || a.id.localeCompare(b.id));
    return { receipts, guidance };
}
