import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { putAuthorizedOnceExact, readAuthorizedReadOnly } from "./authority.js";
import { git } from "./workspace.js";
const bucket = "user-requests";
const guidance = "Use the original objective and expressed consent to continue the same task without asking again. "
    + "Clarify only unclear consent, changed scope or target, or revocation. Time and session changes alone do not expire approval. "
    + "Commit, merge, push, and HITL acceptance retain the scope of the actual requested action; task consent is not a blanket operation grant. "
    + "Missing parser receipts do not negate authorization already present in the conversation or a legacy handoff. This evidence is advisory, never a new permission gate.";
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const pathKey = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const scopeHash = (lines, targetBranch) => hash({ objectiveLines: lines, targetBranch: targetBranch ?? null });
const sourceIdentity = (value) => ({ source: value.source, sourceIntentId: value.sourceIntentId, sessionId: value.sessionId, turnId: value.turnId });
const queues = new Map();
const sourceTime = (receipt) => Date.parse(receipt.sourceRecordedAt ?? receipt.recordedAt);
async function serialized(key, action) {
    const previous = queues.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    queues.set(key, current);
    await previous;
    try {
        return await action();
    }
    finally {
        release();
        if (queues.get(key) === current)
            queues.delete(key);
    }
}
async function repositoryScope(projectRoot) {
    const [topLevel, commonGitDir] = await Promise.all([
        git(["rev-parse", "--show-toplevel"], projectRoot),
        git(["rev-parse", "--path-format=absolute", "--git-common-dir"], projectRoot),
    ]);
    return { projectRoot: path.resolve(topLevel), commonGitDir: path.resolve(commonGitDir) };
}
/** Remove examples and quoted material before classifying the user's own instruction. */
function objectiveCandidates(prompt) {
    const lines = [];
    let fence, quoteBlock, example = false;
    for (const raw of prompt.split(/\r?\n/)) {
        const trimmed = raw.trim();
        if (quoteBlock) {
            if (trimmed.endsWith(quoteBlock))
                quoteBlock = undefined;
            continue;
        }
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
        if (/^(?: {4}| {0,3}\t)/.test(raw) || /^[>`]/.test(trimmed))
            continue;
        const quoted = /^(["']{1,3})/.exec(trimmed);
        if (quoted) {
            if (!trimmed.slice(quoted[1].length).endsWith(quoted[1]))
                quoteBlock = quoted[1];
            continue;
        }
        if (/^(?:(?:for )?example\b|e\.g\.|sample\b|(?:do not|don't) execute this example\b|consider (?:this|the) example\b)/i.test(trimmed)) {
            example = true;
            continue;
        }
        if (!trimmed) {
            example = false;
            lines.push(raw);
            continue;
        }
        if (example || /^\[Captain (?:plan|resume|target):/i.test(trimmed))
            continue;
        lines.push(raw);
    }
    return lines;
}
const action = "(?:do|fix|repair|implement|add|build|run|verify|test|review|record|make|create|update|change|refactor|migrate|remove|delete|commit|merge|push|publish|deploy|list|show|capture|start|finish|complete|perform|execute)";
const direct = new RegExp("^(?:(?:please|then|finally|now)\\s+|go ahead and\\s+)?(?:(?:can|could|would) you\\s+(?:please\\s+)?|i (?:want|need) you to\\s+)?" + action + "\\b(?:\\s+|$)", "i");
const conditionalAction = new RegExp("^when (?:the|this|that) .+? (?:is|are) (?:done|complete|finished)\\s*[-,:]\\s*" + action + "\\b", "i");
const continuation = /^(?:please\s+)?(?:do it|do that|go ahead|continue|resume(?: (?:it|this|the same task|this task|the task))?|keep going|carry on)[.!]*$/i;
const explicitApproval = /^(?:(?:i\s+)?(?:approve|authorize)(?:\s+(?:it|this|this task|the task|that|again))*(?:[.!]\s*(?:do it|continue|go ahead))?|approved)[.!]*$/i;
const revocation = /^(?:(?:please\s+)?(?:stop|cancel)\s+(?:it|this|that|the task|this task|the work|working|implementation)\b|(?:i\s+)?revoke\s+(?:the\s+)?(?:approval|consent|authorization)\b|(?:do not|don't)\s+(?:(?:continue|resume|proceed)\b|do\s+(?:it|that|this task|the task|the same task)\b))/i;
const operationRestriction = /^(?:please\s+)?(?:(?:do not|don't|stop|cancel)\s+(?:(?:do|perform)\s+(?:a|the)\s+)?|(?:i\s+)?revoke\s+(?:the\s+)?)(commit(?:ting)?|merg(?:e|ing)|push(?:ing)?|publish(?:ing)?)\b/i;
const explicitAgain = /^(?:(?:please\s+)?(?:do|perform|execute|resume)\s+(?:it|this task|the task|the same task)\s+again)[.!]*$/i;
function soleOperation(lines) {
    const meaningful = lines.map(cleanLine).filter(Boolean);
    if (meaningful.length !== 1 || /\b(?:and|then|also)\s+(?:do|fix|repair|implement|build|run|verify|test|commit|merge|push|publish)\b/i.test(meaningful[0]))
        return undefined;
    return /^(?:(?:please|now)\s+|go ahead and\s+)?(?:(?:can|could|would) you\s+|i (?:want|need) you to\s+)?(?:(?:do|perform)\s+(?:a|the)\s+)?(commit|merge|push|publish)\b/i.exec(meaningful[0])?.[1].toLowerCase();
}
const baseOperation = (value) => value.toLowerCase().replace(/committing$/, "commit").replace(/merging$/, "merge").replace(/pushing$/, "push").replace(/publishing$/, "publish");
const discussion = /^(?:if\b|when i (?:say|ask)\b|one idea\b|it (?:would|could|might)\b|explain\b|what\b|why\b|should\b|for discussion\b|hypothetically\b)/i;
const cleanLine = (line) => line.trim().replace(/^(?:[-*+]\s+|[0-9]+[.)]\s+)/, "");
function classify(input, candidates, history) {
    const meaningful = candidates.map(cleanLine).filter(Boolean);
    const prior = effective(history), original = history.find(receipt => receipt.objectiveLines.length > 0);
    const inherited = original ? { objectiveLines: original.objectiveLines, objectiveOriginalText: original.objectiveOriginalText,
        targetBranch: original.targetBranch } : { objectiveLines: [] };
    if (meaningful.some(line => revocation.test(line) || /^(?:please\s+)?(?:stop|cancel)[.!]*$/i.test(line)))
        return { decision: "revoked", ...inherited };
    const restrictions = meaningful.map(line => operationRestriction.exec(line)).filter((match) => Boolean(match));
    if (restrictions.length) {
        const operation = original && soleOperation(original.objectiveLines);
        return { decision: operation && restrictions.some(match => baseOperation(match[1]) === operation) ? "revoked" : "unclear", ...inherited };
    }
    const approval = meaningful.length === 1 && (explicitApproval.test(meaningful[0]) || explicitAgain.test(meaningful[0]));
    const continuing = meaningful.length === 1 && continuation.test(meaningful[0]);
    if (approval || continuing) {
        const targetMatches = input.targetBranch === undefined || input.targetBranch === inherited.targetBranch;
        if (original && targetMatches && (approval || prior?.decision === "expressed"))
            return { decision: "expressed", basis: approval ? "explicit_approval" : "continuation", ...inherited };
        return { decision: "unclear", ...inherited };
    }
    const instruction = meaningful.some(line => !discussion.test(line) && (direct.test(line) || conditionalAction.test(line)));
    const goal = input.requestKind === "goal" && meaningful.length > 0 && meaningful.every(line => !discussion.test(line) && !/[?]\s*$/.test(line));
    if (instruction || goal) {
        if (prior?.decision === "revoked")
            return { decision: "unclear", ...inherited };
        if (original)
            return { decision: "expressed", basis: "direct_instruction", ...inherited };
        return { decision: "expressed", basis: "direct_instruction", objectiveLines: candidates,
            objectiveOriginalText: input.prompt, targetBranch: input.targetBranch };
    }
    return { decision: "unclear", ...inherited };
}
function effective(receipts) {
    let current;
    const defining = receipts.find(receipt => receipt.objectiveLines.length > 0), operation = defining && soleOperation(defining.objectiveLines);
    for (const receipt of receipts) {
        const restriction = operation && objectiveCandidates(receipt.originalText).map(cleanLine).some(line => {
            const match = operationRestriction.exec(line);
            return match && baseOperation(match[1]) === operation;
        });
        const meaningful = objectiveCandidates(receipt.originalText).map(cleanLine).filter(Boolean);
        const reapproval = defining && receipts.indexOf(receipt) >= receipts.indexOf(defining)
            && meaningful.length === 1 && (explicitApproval.test(meaningful[0]) || explicitAgain.test(meaningful[0]))
            && (receipt.requestedTargetBranch === undefined || receipt.requestedTargetBranch === defining.targetBranch);
        // Recollect a literal later approval after delayed baseline publication, without rewriting its signed receipt.
        const candidate = restriction ? { ...receipt, decision: "revoked" }
            : reapproval ? { ...receipt, decision: "expressed", basis: "explicit_approval" } : receipt;
        // A supporting request captured before a delayed Stop receipt cannot become implicit reapproval.
        if (current?.decision === "revoked" && candidate.decision === "expressed" && candidate.basis !== "explicit_approval")
            continue;
        if (candidate.decision !== "unclear" || !current)
            current = candidate;
    }
    return current;
}
function assertReceipt(receipt, id) {
    const required = ["sessionId", "turnId", "sourceIntentId", "intentId", "projectRoot", "commonGitDir", "inputSha256"];
    if (!receipt || receipt.schemaVersion !== 1 || receipt.id !== id || hash(sourceIdentity(receipt)) !== id
        || required.some(field => typeof receipt[field] !== "string" || !receipt[field].trim())
        || !["UserPromptSubmit", "client-adapter"].includes(receipt.source)
        || !["expressed", "unclear", "revoked"].includes(receipt.decision)
        || typeof receipt.originalText !== "string" || !Array.isArray(receipt.objectiveLines)
        || receipt.objectiveLines.some(line => typeof line !== "string")
        || scopeHash(receipt.objectiveLines, receipt.targetBranch) !== receipt.scopeSha256
        || !Number.isSafeInteger(receipt.sequence) || receipt.sequence < 0
        || typeof receipt.recordedAt !== "string" || !Number.isFinite(Date.parse(receipt.recordedAt))
        || (receipt.sourceRecordedAt !== undefined && (typeof receipt.sourceRecordedAt !== "string" || !Number.isFinite(Date.parse(receipt.sourceRecordedAt))))
        || (receipt.requestedLines !== undefined && (!Array.isArray(receipt.requestedLines) || receipt.requestedLines.some(line => typeof line !== "string")))
        || (receipt.basis !== undefined && !["direct_instruction", "continuation", "explicit_approval"].includes(receipt.basis))) {
        throw new Error("signed user request source or task binding is invalid");
    }
}
async function readReceipts(data) {
    let names;
    try {
        names = await readdir(path.join(data, bucket));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return [];
        throw error;
    }
    const receipts = [];
    for (const name of names.filter(value => /^[a-f0-9]{64}\.json$/.test(value))) {
        const id = name.slice(0, -5), receipt = await readAuthorizedReadOnly(data, bucket, id);
        assertReceipt(receipt, id);
        receipts.push(receipt);
    }
    receipts.sort((left, right) => sourceTime(left) - sourceTime(right)
        // Ambiguous simultaneous source events cannot silently override a revocation.
        || Number(left.decision === "revoked") - Number(right.decision === "revoked")
        || left.sequence - right.sequence || left.recordedAt.localeCompare(right.recordedAt) || left.id.localeCompare(right.id));
    return receipts;
}
/** Persist original user evidence. The caller authenticates task ownership and resume links. */
export async function recordUserRequest(data, input) {
    for (const field of ["projectRoot", "sessionId", "turnId", "sourceIntentId", "intentId"])
        if (typeof input[field] !== "string" || !input[field].trim())
            throw new Error("User request needs its exact source session, turn, repository and canonical task intent");
    if (typeof input.prompt !== "string" || !["UserPromptSubmit", "client-adapter"].includes(input.source)
        || (input.requestKind !== undefined && !["instruction", "goal"].includes(input.requestKind)))
        throw new Error("User request source prompt or kind is invalid");
    if (input.sourceRecordedAt !== undefined && (typeof input.sourceRecordedAt !== "string" || !Number.isFinite(Date.parse(input.sourceRecordedAt))))
        throw new Error("User request source timestamp is invalid");
    const scope = await repositoryScope(input.projectRoot);
    if (input.targetBranch !== undefined)
        await git(["check-ref-format", "--branch", input.targetBranch], scope.projectRoot);
    const inputSha256 = hash({ ...sourceIdentity(input), commonGitDir: pathKey(scope.commonGitDir), intentId: input.intentId,
        prompt: input.prompt, taskId: input.taskId ?? null, targetBranch: input.targetBranch ?? null, requestKind: input.requestKind ?? null, sourceRecordedAt: input.sourceRecordedAt ?? null });
    const id = hash(sourceIdentity(input));
    return serialized(pathKey(data) + "\0" + pathKey(scope.commonGitDir) + "\0" + input.intentId, async () => {
        const all = await readReceipts(data), existing = all.find(receipt => receipt.id === id);
        if (existing) {
            if (existing.inputSha256 !== inputSha256)
                throw new Error("User request source event is immutable and does not match the existing binding");
            return existing;
        }
        const history = all.filter(receipt => receipt.intentId === input.intentId && pathKey(receipt.commonGitDir) === pathKey(scope.commonGitDir));
        const recordedAt = new Date().toISOString(), eventTime = Date.parse(input.sourceRecordedAt ?? recordedAt);
        // Publication can be delayed; classify against the authenticated source event's actual preceding history.
        const atSource = history.filter(receipt => sourceTime(receipt) <= eventTime);
        const requestedLines = objectiveCandidates(input.prompt), event = classify(input, requestedLines, atSource);
        const receipt = {
            schemaVersion: 1, id, ...sourceIdentity(input), intentId: input.intentId, ...scope,
            ...(input.taskId ? { taskId: input.taskId } : {}), ...(input.requestKind ? { requestKind: input.requestKind } : {}),
            ...(event.targetBranch !== undefined ? { targetBranch: event.targetBranch } : {}),
            ...(input.targetBranch !== undefined ? { requestedTargetBranch: input.targetBranch } : {}),
            originalText: input.prompt, objectiveLines: event.objectiveLines, requestedLines,
            ...(event.objectiveOriginalText !== undefined ? { objectiveOriginalText: event.objectiveOriginalText } : {}),
            scopeSha256: scopeHash(event.objectiveLines, event.targetBranch),
            inputSha256, decision: event.decision, ...("basis" in event ? { basis: event.basis } : {}),
            sequence: history.length ? Math.max(...history.map(value => value.sequence)) + 1 : 0,
            recordedAt, ...(input.sourceRecordedAt !== undefined ? { sourceRecordedAt: input.sourceRecordedAt } : {}),
        };
        try {
            return await putAuthorizedOnceExact(data, bucket, id, receipt);
        }
        catch (error) {
            // Only replay this exact source event; never adopt another task's receipt.
            const published = await readAuthorizedReadOnly(data, bucket, id);
            assertReceipt(published, id);
            if (published.inputSha256 !== inputSha256)
                throw error;
            return published;
        }
    });
}
/** Recollect authenticated existing receipts without creating keys or modifying evidence. */
export async function userRequestStatus(data, query) {
    if (typeof query.intentId !== "string" || !query.intentId.trim())
        throw new Error("Select the exact canonical task intent for user request lookup");
    if (query.expectedScopeSha256 !== undefined && !/^[a-f0-9]{64}$/i.test(query.expectedScopeSha256))
        throw new Error("Expected user request scope digest is invalid");
    const missing = { status: "missing", receipts: [], objectiveLines: [],
        reason: "No source evidence for this exact task and caller; legacy conversation authority remains relevant", guidance };
    const candidates = (await readReceipts(data)).filter(receipt => receipt.intentId === query.intentId);
    // A legacy run without receipts remains usable even when its historical checkout is unavailable.
    if (!candidates.length || (query.sessionId !== undefined && !candidates.some(receipt => receipt.sessionId === query.sessionId)))
        return missing;
    const scope = await repositoryScope(query.projectRoot);
    const receipts = candidates.filter(receipt => pathKey(receipt.commonGitDir) === pathKey(scope.commonGitDir));
    if (!receipts.length || (query.sessionId !== undefined && !receipts.some(receipt => receipt.sessionId === query.sessionId)))
        return missing;
    const current = effective(receipts), defining = receipts.find(receipt => receipt.objectiveLines.length > 0), objective = defining ?? current;
    const result = {
        status: current.decision, receipts, objectiveLines: objective.objectiveLines,
        ...(objective.objectiveOriginalText !== undefined ? { originalText: objective.objectiveOriginalText } : {}),
        ...(objective.objectiveLines.length ? { scopeSha256: objective.scopeSha256 } : {}), guidance,
    };
    if (current.decision === "revoked")
        return { ...result, reason: "The user revoked this task's approval" };
    const lastRequestedTarget = receipts.slice(defining ? receipts.indexOf(defining) : 0).reverse().find(receipt => receipt.requestedTargetBranch !== undefined);
    if ((lastRequestedTarget !== undefined && lastRequestedTarget.requestedTargetBranch !== defining?.targetBranch)
        || (query.expectedScopeSha256 !== undefined && query.expectedScopeSha256.toLowerCase() !== objective.scopeSha256)
        || (query.expectedTargetBranch !== undefined && query.expectedTargetBranch !== objective.targetBranch))
        return { ...result, status: "stale", reason: "The requested scope or target differs from the recorded objective" };
    if (current.decision === "unclear")
        result.reason = "The source wording does not establish clear expressed consent for this objective";
    return result;
}
