import { createHash } from "node:crypto";
import path from "node:path";
import { stat } from "node:fs/promises";
import { putAuthorizedOnceExact, readAuthorizedReadOnly } from "./authority.js";
import { git } from "./workspace.js";
const bucket = "user-request-sources";
const pathKey = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function assertSelectors(input) {
    if (![input.projectRoot, input.sessionId, input.turnId].every(value => typeof value === "string" && value.trim()))
        throw new Error("User request source requires exact repository, session and turn selectors");
}
async function sourceBinding(input) {
    assertSelectors(input);
    await git(["rev-parse", "--show-toplevel"], input.projectRoot);
    const commonGitDir = path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], input.projectRoot));
    const id = hash({ commonGitDir: pathKey(commonGitDir), source: "UserPromptSubmit", sessionId: input.sessionId, turnId: input.turnId });
    return { id, commonGitDir, source: "UserPromptSubmit", sessionId: input.sessionId, turnId: input.turnId };
}
function validateReceipt(receipt, binding) {
    if (receipt.schemaVersion !== 1 || receipt.id !== binding.id || receipt.source !== binding.source ||
        receipt.sessionId !== binding.sessionId || receipt.turnId !== binding.turnId ||
        pathKey(receipt.commonGitDir) !== pathKey(binding.commonGitDir) || typeof receipt.originalText !== "string" ||
        typeof receipt.recordedAt !== "string" || !Number.isFinite(Date.parse(receipt.recordedAt)) ||
        (receipt.requestKind !== undefined && receipt.requestKind !== "instruction" && receipt.requestKind !== "goal"))
        throw new Error("User request source receipt has an invalid repository or caller binding");
    return receipt;
}
export async function readUserRequestSource(data, query) {
    const binding = await sourceBinding(query);
    if (query.sourceId !== undefined && query.sourceId !== binding.id)
        throw new Error("User request source id does not match the exact repository, session and turn");
    // Missing evidence is advisory. Existing evidence must authenticate; a missing
    // signing key or a read failure must never be relabeled as absent evidence.
    try {
        await stat(path.join(data, bucket, binding.id + ".json"));
    }
    catch (error) {
        if (error.code === "ENOENT")
            return undefined;
        throw error;
    }
    return validateReceipt(await readAuthorizedReadOnly(data, bucket, binding.id), binding);
}
export async function recordUserRequestSource(data, input) {
    assertSelectors(input);
    if (input.source !== "UserPromptSubmit" || typeof input.prompt !== "string" ||
        (input.requestKind !== undefined && input.requestKind !== "instruction" && input.requestKind !== "goal"))
        throw new Error("User request source needs the exact human prompt event");
    const binding = await sourceBinding(input);
    const verifyReplay = (receipt) => {
        validateReceipt(receipt, binding);
        if (receipt.originalText !== input.prompt || receipt.requestKind !== input.requestKind)
            throw new Error("User request source is immutable for this repository, session and turn");
        return receipt;
    };
    const existing = await readUserRequestSource(data, input);
    if (existing)
        return verifyReplay(existing);
    const receipt = { schemaVersion: 1, ...binding, originalText: input.prompt,
        ...(input.requestKind ? { requestKind: input.requestKind } : {}), recordedAt: new Date().toISOString() };
    try {
        return await putAuthorizedOnceExact(data, bucket, binding.id, receipt);
    }
    catch (error) {
        // Another identical source event may have won publication with a different
        // timestamp. Verify its immutable content before accepting that replay.
        const published = await readUserRequestSource(data, input);
        if (!published)
            throw error;
        return verifyReplay(published);
    }
}
