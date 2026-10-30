import { link, readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { applyLfsMergeTransition, fingerprint, matches, prepareLfsFastForward, safeRelative, writeDurable } from "./git-lfs-fastforward.js";
import { safeGitJournalStatusRaw, withShadowGit } from "./git-safe-status.js";
/** Tracked status complements the manifest, which intentionally omits some directories. */
export async function assertJournalTrackedStatus(root, git, allowed, policy) {
    const normalize = (value) => process.platform === "win32" ? value.toLowerCase() : value;
    const permitted = new Set(allowed.map(value => normalize(safeRelative(value))));
    const generated = (name) => {
        const lower = name.toLowerCase(), roots = [...(policy.sourceManifestExcludes ?? []), ...Object.values(policy.outputRetention?.roots ?? {}).flat()].map(value => value.toLowerCase());
        return roots.some(value => lower === value || lower.startsWith(`${value}/`)) || lower.startsWith(".captain-sdlc/trace/") || (!lower.includes("/") && (policy.sourceManifestRootFileExcludes ?? []).some(value => value.startsWith("*.") ? lower.endsWith(value.slice(1).toLowerCase()) : lower === value.toLowerCase()));
    };
    const data = await safeGitJournalStatusRaw(root, git);
    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    }
    catch {
        throw new Error("tracked status returned invalid path encoding");
    }
    if (text && !text.endsWith("\0"))
        throw new Error("truncated tracked status");
    for (const field of text.split("\0").filter(Boolean)) {
        if (field.length < 4 || field[2] !== " ")
            throw new Error("invalid tracked status entry");
        const name = safeRelative(field.slice(3));
        if (field.slice(0, 2) === "??" && generated(name))
            continue;
        if (!permitted.has(normalize(name)))
            throw new Error(`tracked input changed outside the LFS transaction: ${name}`);
    }
}
function parseMerge(output, status, oidLength) {
    let text;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(output);
    }
    catch {
        throw new Error("isolated merge-tree returned invalid path encoding");
    }
    const fields = text.split("\0"), tree = fields.shift() ?? "";
    if (!new RegExp(`^[a-f0-9]{${oidLength}}$`).test(tree))
        throw new Error("isolated merge-tree returned an invalid tree");
    const stages = [], seen = new Set(), folded = new Map();
    while (fields.length && fields[0]) {
        const field = fields.shift(), match = /^(100644|100755) ([a-f0-9]+) ([123])\t([\s\S]+)$/.exec(field);
        if (!match || match[2].length !== oidLength)
            throw new Error("unsupported merge conflict entry");
        const name = safeRelative(match[4]);
        if (path.posix.basename(name).toLowerCase() === ".gitattributes")
            throw new Error("conflicting Git attributes require manual recovery before LFS merge");
        const key = process.platform === "win32" ? name.toLowerCase() : name;
        if (folded.has(key) && folded.get(key) !== name || seen.has(`${key}\0${match[3]}`))
            throw new Error("case-colliding or duplicate LFS merge conflict entries");
        folded.set(key, name);
        seen.add(`${key}\0${match[3]}`);
        stages.push({ path: name, mode: match[1], oid: match[2], stage: match[3] });
    }
    if (status === "clean" && stages.length || status === "conflicts" && !stages.length)
        throw new Error("isolated merge-tree status disagrees with conflict entries");
    return { tree, stages };
}
/** Prepare content privately and retain its objects with a private ref; leave the checkout and branch unchanged. */
export async function prepareLfsMerge(root, branch, ours, theirs, git, validateCommit) {
    const computed = await withShadowGit(root, git, async (shadow) => {
        const result = await shadow.mergeTree(ours, theirs), parsed = parseMerge(result.output, result.status, ours.length);
        if (result.status === "conflicts") {
            const bases = (await shadow.run(["merge-base", "--all", ours, theirs])).toString("ascii").trim().split(/\r?\n/).filter(Boolean);
            if (bases.length !== 1)
                throw new Error("conflicting LFS merges with multiple merge bases are not yet supported safely");
        }
        return { ...parsed, commit: await shadow.writeMergeCommit(parsed.tree, ours, theirs), fileMode: shadow.fileMode };
    });
    // Keep the synthetic tree and both parent histories reachable throughout recovery.
    // The private ref is retained as transaction evidence until a future audited cleanup.
    const objectPin = `refs/captain-sdlc/lfs-merges/${randomUUID()}`;
    await git(["update-ref", "-m", "Captain LFS merge object retention", objectPin, computed.commit, "0".repeat(ours.length)], root);
    if (await git(["rev-parse", "--verify", `${objectPin}^{commit}`], root) !== computed.commit)
        throw new Error("LFS merge object retention ref diverged");
    await git(["fsck", "--connectivity-only", "--no-reflogs", "--no-dangling", objectPin], root);
    await validateCommit(computed.commit);
    const transition = await prepareLfsFastForward(root, branch, ours, computed.commit, git);
    if (computed.stages.length) {
        const indexBytes = await withShadowGit(root, git, async (shadow) => {
            await shadow.run(["read-tree", computed.commit]);
            const names = [...new Set(computed.stages.map(item => item.path))];
            const zero = "0".repeat(ours.length), records = [];
            for (const name of names) {
                records.push(`0 ${zero}\t${name}\0`);
                for (const entry of computed.stages.filter(item => item.path === name))
                    records.push(`${entry.mode} ${entry.oid} ${entry.stage}\t${entry.path}\0`);
            }
            await shadow.run(["update-index", "-z", "--index-info"], Buffer.from(records.join("")));
            await shadow.run(["update-index", "--no-split-index"]);
            const bytes = await readFile(shadow.indexFile);
            if (bytes.length > 32 * 1024 * 1024)
                throw new Error("LFS merge index exceeds its bounded limit");
            return bytes;
        });
        const prepared = path.join(transition.transaction_dir, "index.merge");
        await writeDurable(prepared, indexBytes);
        const index = await fingerprint(prepared);
        if (!index)
            throw new Error("LFS merge index was not prepared");
        transition.prepared_index = prepared;
        transition.new_index = index;
    }
    const mergeHeadFile = path.join(transition.transaction_dir, "MERGE_HEAD.prepared");
    await writeDurable(mergeHeadFile, Buffer.from(`${theirs}\n`));
    const mergeHead = await fingerprint(mergeHeadFile);
    if (!mergeHead)
        throw new Error("LFS merge head was not prepared");
    const conflicts = [...new Set(computed.stages.map(item => item.path))].sort();
    const changed = new Set(transition.changes.map(item => process.platform === "win32" ? item.path.toLowerCase() : item.path));
    const witnesses = [];
    for (const name of conflicts) {
        if (changed.has(process.platform === "win32" ? name.toLowerCase() : name))
            continue;
        const before = await fingerprint(path.join(transition.root, ...name.split("/")));
        witnesses.push({ path: name, ...(before ? { before } : {}) });
    }
    return { schema_version: 1, transition, target_head: theirs, merge_head_file: mergeHeadFile, merge_head: mergeHead, conflicts, input_manifest: "", object_pin: objectPin, file_mode: computed.fileMode, conflict_witnesses: witnesses };
}
/** Resume only the signed, authenticated preimage or result at every publication step. */
export async function applyLfsMerge(plan, git, authorize, checkpoint, validateInputs) {
    const transition = plan.transition;
    if (plan.schema_version !== 1 || !/^[a-f0-9]{64}$/.test(plan.input_manifest) || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(plan.target_head) || !/^refs\/captain-sdlc\/lfs-merges\/[a-f0-9-]{36}$/.test(plan.object_pin) || typeof plan.file_mode !== "boolean" || !Array.isArray(plan.conflict_witnesses) || path.resolve(plan.merge_head_file) !== path.join(transition.transaction_dir, "MERGE_HEAD.prepared"))
        throw new Error("invalid signed LFS merge plan");
    const dest = path.join(transition.git_dir, "MERGE_HEAD");
    const validateHead = async () => {
        if (await git(["rev-parse", "--verify", `${plan.object_pin}^{commit}`], transition.root) !== transition.new_head)
            throw new Error("signed LFS merge object retention ref changed");
        if (!matches(await fingerprint(plan.merge_head_file), plan.merge_head))
            throw new Error("signed LFS merge head changed");
        const current = await fingerprint(dest);
        if (current && !matches(current, plan.merge_head))
            throw new Error("LFS merge found a foreign MERGE_HEAD");
    };
    const validateWitnesses = async () => {
        for (const witness of plan.conflict_witnesses) {
            const name = safeRelative(witness.path), current = await fingerprint(path.join(transition.root, ...name.split("/")));
            const actual = !plan.file_mode && current && witness.before ? { ...current, executable: witness.before.executable } : current;
            if (!plan.conflicts.includes(name) || !matches(actual, witness.before))
                throw new Error(`LFS merge conflict input changed: ${name}`);
        }
    };
    await authorize();
    await validateInputs();
    await validateWitnesses();
    await validateHead();
    await applyLfsMergeTransition(transition, git, async () => { await authorize(); await validateHead(); }, checkpoint);
    await authorize();
    await validateInputs();
    await validateWitnesses();
    await validateHead();
    if (!await fingerprint(dest)) {
        try {
            await link(plan.merge_head_file, dest);
        }
        catch (error) {
            if (error.code === "EEXIST")
                throw new Error("LFS merge found a foreign MERGE_HEAD");
            throw error;
        }
    }
    await validateHead();
    await checkpoint("merge-head");
}
