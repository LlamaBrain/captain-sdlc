import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { approvedPlanDigest } from "./lifecycle.js";
import { compileSafeRegex, parseStrictSemVer, subjectVersion } from "./validation.js";
const exec = promisify(execFile), maxGitBuffer = 10 * 1024 * 1024, maxPolicyInput = 1024 * 1024;
const defaultCommitPolicy = { conventional: true, require_version_suffix: true, version_file: "VERSION", version_surfaces: [{ path: "VERSION", pattern: "(?m)^(?<version>[0-9]+\\.[0-9]+\\.[0-9]+)\\s*$" }], changelog_files: ["CHANGELOG.md"] };
const approvedGeneratedPaths = new Set([
    "library", "temp", "logs", "artifacts", "build", "builds", "obj", "bin", "dist", "coverage", "generated", ".captain-proof",
    "usersettings", ".vs", ".idea", ".gradle", "exportedobj", ".consulo", "profilercaptures", "dirigibles",
    "assets/packages-merged-link", "assets/packages-merged-link.meta", "assets/_dirigible/temp", "assets/_dirigible/temp.meta",
    "assets/streamingassets/dirigiblebuildprovenance.json", "assets/streamingassets/dirigiblebuildprovenance.json.meta",
    "assets/addressableassetsdata/link.xml", "assets/addressableassetsdata/link.xml.meta",
    "assets/addressableassetsdata/windows/addressables_content_state.bin", "assets/addressableassetsdata/windows/addressables_content_state.bin.meta",
    "assets/thirdparty/gameanalytics/resources/gameanalytics/settings.asset",
    "assets/textmesh pro/resources/fonts & materials/liberationsans sdf - fallback.asset",
    "assets/resources/performancetestruninfo.json", "assets/resources/performancetestrunsettings.json", ".captain-sdlc/unity-relaunch.log",
    "doxygen/dirigibles", "doxygen/doxygen_warnings.log",
    "plugins/captain-sdlc/bin", "plugins/captain-sdlc/temp/automation-scratch", "plugins/captain-sdlc/.captain-proof",
]);
const approvedGeneratedRootFilePatterns = new Set(["*.csproj", "*.unityproj", "*.sln", "*.suo", "*.tmp", "*.user", "*.userprefs", "*.pidb", "*.booproj", "*.svd", "*.pdb", "*.mdb", "*.opendb", "*.vc.db", "*.dotsettings", "*.dotsettings.user", "sysinfo.txt", "crashlytics-build.properties", "doxygen_warnings.log"]);
let isolatedGitControlRoot;
function scrubbedEnvironment() { const env = { ...process.env }; for (const name of Object.keys(env))
    if (/^(?:GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|QUARANTINE_PATH|SHALLOW_FILE|NAMESPACE|EXEC_PATH|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|ATTR_SOURCE|CONFIG|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_NOSYSTEM|CONFIG_COUNT|CONFIG_PARAMETERS|EXTERNAL_DIFF|DIFF_OPTS)|GIT_CONFIG_(?:KEY|VALUE)_\d+)$/i.test(name) || name === "PLUGIN_DATA" || name === "CAPTAIN_PLUGIN_DATA")
        delete env[name]; return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_ATTR_NOSYSTEM: "1" }; }
async function gitControls() { isolatedGitControlRoot ??= (async () => { const root = await mkdtemp(path.join(tmpdir(), "captain-git-controls-")); await writeFile(path.join(root, "attributes"), ""); return root; })(); return isolatedGitControlRoot; }
async function gitInvocation(args, cwd) { const controls = await gitControls(); return exec("git", ["-c", `core.hooksPath=${controls}`, "-c", `core.attributesFile=${path.join(controls, "attributes")}`, "-c", "merge.default=text", "-c", "core.fsmonitor=false", "-c", "pager.diff=false", ...args], { cwd, windowsHide: true, env: scrubbedEnvironment(), maxBuffer: maxGitBuffer }); }
export const gateRunner = async (command, cwd) => { try {
    const result = await exec(process.platform === "win32" ? "cmd.exe" : "/bin/sh", process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command], { cwd, windowsHide: true, env: scrubbedEnvironment(), maxBuffer: maxGitBuffer });
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr };
}
catch (error) {
    return { exitCode: Number(error.code) || 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
} };
export async function git(args, cwd) { return (await gitInvocation(args, cwd)).stdout.trim(); }
export async function loadPolicy(projectRoot, baseHead, planPaths, hitlChecks) {
    const text = await boundedGitShow(projectRoot, `${baseHead}:.captain-sdlc/codex-policy.json`, "trusted Codex policy"), raw = parseObject(text, "trusted Codex policy"), profile = raw.profile;
    if (profile !== "low" && profile !== "feature" && profile !== "pre-release")
        throw new Error("trusted base policy has an invalid profile");
    if (typeof raw.visualRequired !== "boolean")
        throw new Error("trusted base policy must configure visualRequired");
    const commands = stringRecord(raw.commands, "trusted policy commands");
    for (const scope of ["build", "ticket", "feature-smoke", "affected-regression", ...(raw.visualRequired ? ["visual"] : [])])
        if (!commands[scope])
            throw new Error(`trusted base policy is missing ${scope}`);
    const parsed = { profile, visualRequired: raw.visualRequired, commands };
    if (raw.hitlChecks !== undefined || hitlChecks !== undefined) {
        const checks = new Map();
        for (const source of [raw.hitlChecks ?? [], hitlChecks ?? []]) {
            if (!Array.isArray(source))
                throw new Error("HITL checks must be an array");
            for (const check of source) {
                const fields = ["id", "criterionId", "setup", "action", "expected", "evidence"];
                if (!check || fields.some(field => typeof check[field] !== "string" || !check[field].trim()))
                    throw new Error("HITL checks require id, criterionId, setup, action, expected and evidence goals");
                const normalized = Object.fromEntries(fields.map(field => [field, check[field]]));
                if (checks.has(normalized.id) && JSON.stringify(checks.get(normalized.id)) !== JSON.stringify(normalized))
                    throw new Error(`conflicting frozen HITL check: ${normalized.id}`);
                checks.set(normalized.id, normalized);
            }
        }
        parsed.hitlChecks = [...checks.values()].sort((a, b) => a.id.localeCompare(b.id));
    }
    if (raw.approvedPlanPaths !== undefined || planPaths !== undefined) {
        if ((raw.approvedPlanPaths !== undefined && (!Array.isArray(raw.approvedPlanPaths) || raw.approvedPlanPaths.some((value) => typeof value !== "string"))) || (planPaths !== undefined && (!Array.isArray(planPaths) || planPaths.some(value => typeof value !== "string"))))
            throw new Error("approvedPlanPaths must be an array of repository paths");
        parsed.approvedPlans = [];
        const seen = new Set();
        for (const value of [...(raw.approvedPlanPaths ?? []), ...(planPaths ?? [])]) {
            const relative = safeRepositoryPath(value, "approved plan");
            if (seen.has(relative.toLowerCase()))
                continue;
            seen.add(relative.toLowerCase());
            const mode = await git(["ls-tree", baseHead, "--", relative], projectRoot);
            if (!/^100(?:644|755) blob /.test(mode))
                throw new Error(`approved plan must be a tracked regular file: ${relative}`);
            const result = await gitInvocation(["show", `${baseHead}:${relative}`], projectRoot);
            if (Buffer.byteLength(result.stdout) > maxPolicyInput)
                throw new Error(`approved plan exceeds the bounded input limit: ${relative}`);
            parsed.approvedPlans.push({ path: relative, sha256: approvedPlanDigest(result.stdout) });
        }
        parsed.approvedPlans.sort((a, b) => a.path.localeCompare(b.path));
    }
    if (raw.profiles !== undefined) {
        if (!Array.isArray(raw.profiles) || raw.profiles.some((value) => value !== "low" && value !== "feature" && value !== "pre-release"))
            throw new Error("trusted policy profiles are invalid");
        parsed.profiles = [...new Set(raw.profiles)];
    }
    if (raw.artifactPaths !== undefined)
        parsed.artifactPaths = stringRecord(raw.artifactPaths, "trusted artifact paths");
    if (raw.redGate !== undefined) {
        const red = objectValue(raw.redGate, "trusted red gate");
        if (!Array.isArray(red.expectedExitCodes) || red.expectedExitCodes.length === 0 || red.expectedExitCodes.some((value) => !Number.isInteger(value)))
            throw new Error("trusted red gate exit codes are invalid");
        if (typeof red.outputPattern !== "string")
            throw new Error("trusted red gate output pattern is invalid");
        compileSafeRegex(red.outputPattern, "i", "trusted red gate pattern");
        parsed.redGate = { expectedExitCodes: red.expectedExitCodes, outputPattern: red.outputPattern };
    }
    if (raw.commitPolicyPath !== undefined && raw.commit !== undefined)
        throw new Error("trusted policy cannot configure both inline and external commit policy");
    if (raw.commitPolicyPath !== undefined) {
        if (typeof raw.commitPolicyPath !== "string")
            throw new Error("commit policy path must be a string");
        parsed.commitPolicyPath = safeRepositoryPath(raw.commitPolicyPath, "commit policy");
        const repositoryText = await boundedGitShow(projectRoot, `${baseHead}:${parsed.commitPolicyPath}`, "trusted repository policy"), repositoryPolicy = parseObject(repositoryText, "trusted repository policy");
        if (repositoryPolicy.schema_version !== 1)
            throw new Error("trusted repository policy schema_version must be 1");
        parsed.commit = validateCommitPolicy(repositoryPolicy.commit);
        parsed.commitPolicySha256 = digest(repositoryText);
    }
    else if (raw.commit !== undefined) {
        parsed.commit = validateCommitPolicy(raw.commit);
        parsed.commitPolicySha256 = digest(JSON.stringify(raw.commit));
    }
    const trackedBasePaths = splitLines(await git(["ls-tree", "-r", "--name-only", baseHead], projectRoot));
    if (raw.sourceManifestExcludes !== undefined && !Array.isArray(raw.sourceManifestExcludes))
        throw new Error("source manifest exclusions must be an array");
    parsed.sourceManifestExcludes = [];
    for (const value of (raw.sourceManifestExcludes ?? [])) {
        if (typeof value !== "string")
            throw new Error("source manifest exclusion must be a string");
        const relative = safeRepositoryPath(value, "source manifest exclusion");
        if (!approvedGeneratedPaths.has(relative.toLowerCase()))
            throw new Error(`${relative} is not an approved generated-output path`);
        if (trackedBasePaths.some(candidate => candidate.toLowerCase() === relative.toLowerCase() || candidate.toLowerCase().startsWith(`${relative.toLowerCase()}/`)))
            throw new Error(`${relative} contains tracked base files and cannot be excluded`);
        parsed.sourceManifestExcludes.push(relative);
    }
    if (raw.sourceManifestRootFileExcludes !== undefined && !Array.isArray(raw.sourceManifestRootFileExcludes))
        throw new Error("source manifest root-file exclusions must be an array");
    parsed.sourceManifestRootFileExcludes = [];
    const trackedRootFiles = trackedBasePaths.filter(value => !value.includes("/"));
    for (const value of (raw.sourceManifestRootFileExcludes ?? [])) {
        if (typeof value !== "string" || !approvedGeneratedRootFilePatterns.has(value.toLowerCase()))
            throw new Error(`${String(value)} is not an approved generated root-file pattern`);
        if (trackedRootFiles.some(file => rootFilePatternMatches(file, value)))
            throw new Error(`${value} matches a tracked base file and cannot be excluded`);
        parsed.sourceManifestRootFileExcludes.push(value);
    }
    if (parsed.hitlChecks?.length && !parsed.approvedPlans?.length)
        throw new Error("HITL checks require an approved plan selected at begin");
    return parsed;
}
export async function repositoryIdentity(projectRoot, targetBranch, targetOid) { const root = path.resolve(await git(["rev-parse", "--show-toplevel"], projectRoot)), commonGitDir = path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root)); if (targetBranch)
    await validateTargetBranch(root, targetBranch); const baseHead = await git(["rev-parse", "--verify", targetBranch ? `refs/heads/${targetBranch}^{commit}` : "HEAD^{commit}"], root); if (targetBranch && (!targetOid || baseHead.toLowerCase() !== targetOid.toLowerCase()))
    throw new Error("signed target branch oid does not match the current ref"); await assertSafeGitAttributesAtCommit(root, baseHead); return { projectRoot: root, baseHead, commonGitDir }; }
async function hydrateIgnoredUnityPlugins(root, worktree) {
    for (const parent of ["Assets", "Packages"]) {
        const sourceParent = path.join(root, parent);
        let entries;
        try {
            entries = await readdir(sourceParent, { withFileTypes: true });
        }
        catch (error) {
            if (error.code === "ENOENT")
                continue;
            throw error;
        }
        for (const entry of entries) {
            if (!entry.isDirectory())
                continue;
            const relative = parent + "/" + entry.name;
            if (await optionalGit(["check-ignore", "--", relative], root) === null)
                continue;
            await cp(path.join(sourceParent, entry.name), path.join(worktree, relative), { recursive: true, force: false, errorOnExist: false });
            const siblingMeta = relative + ".meta";
            try {
                const metadata = await lstat(path.join(root, siblingMeta));
                if (metadata.isFile())
                    await cp(path.join(root, siblingMeta), path.join(worktree, siblingMeta), { force: false, errorOnExist: false });
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
        }
    }
}
export async function ensureWorktree(projectRoot, baseHead, intentId, targetBranch, expectedCommonGitDir) {
    const root = path.resolve(projectRoot), commonGitDir = path.resolve(expectedCommonGitDir ?? await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], root)), safe = intentId.replace(/[^a-zA-Z0-9_-]/g, ""), container = path.join(root, ".captain-sdlc", "worktrees"), proposedPath = path.join(container, safe);
    if (!safe)
        throw new Error("intent id cannot produce an empty worktree name");
    await assertSafeGitAttributesAtCommit(root, baseHead);
    await assertSafeGitMetadataAttributes(root);
    await rejectReparseAncestors(root, container);
    if (targetBranch) {
        await validateTargetBranch(root, targetBranch);
        const targetRef = `refs/heads/${targetBranch}`, resolved = await git(["rev-parse", "--verify", `${targetRef}^{commit}`], root);
        if (resolved !== baseHead)
            throw new Error("target branch moved after its base was captured");
        const existing = (await worktreeEntries(root)).find(value => value.branch === targetRef);
        if (existing) {
            const worktreePath = path.resolve(existing.worktree);
            if (!isPathInside(container, worktreePath))
                throw new Error("target branch is checked out outside the canonical worktree container");
            await assertSafeGitAttributesInWorktree(worktreePath, await trackedWorktreePaths(worktreePath));
            const binding = await assertWorktreeBinding(worktreePath, targetBranch, commonGitDir, baseHead, true);
            await hydrateIgnoredUnityPlugins(root, worktreePath);
            return { projectRoot: root, worktreePath, baseHead, targetBranch, branch: binding.branch, commonGitDir, gitDir: binding.gitDir };
        }
        let binding;
        await assertMissingWorktreePath(proposedPath);
        try {
            await git(["worktree", "add", proposedPath, targetBranch], root);
            await assertSafeGitAttributesInWorktree(proposedPath, await trackedWorktreePaths(proposedPath));
            binding = await assertWorktreeBinding(proposedPath, targetBranch, commonGitDir, baseHead, true);
            await hydrateIgnoredUnityPlugins(root, proposedPath);
        }
        catch (error) {
            try {
                await git(["worktree", "remove", "--force", proposedPath], root);
            }
            catch { }
            throw error;
        }
        return { projectRoot: root, worktreePath: proposedPath, baseHead, targetBranch, branch: binding.branch, commonGitDir, gitDir: binding.gitDir };
    }
    const branch = `captain/${safe}`, branchRef = `refs/heads/${branch}`, existing = (await worktreeEntries(root)).find(value => path.resolve(value.worktree) === path.resolve(proposedPath));
    if (existing) {
        if (existing.branch !== branchRef)
            throw new Error("canonical worktree path belongs to a different branch");
        await assertSafeGitAttributesInWorktree(proposedPath, await trackedWorktreePaths(proposedPath));
        const binding = await assertWorktreeBinding(proposedPath, branch, commonGitDir, baseHead, true);
        await hydrateIgnoredUnityPlugins(root, proposedPath);
        return { projectRoot: root, worktreePath: proposedPath, baseHead, branch: binding.branch, commonGitDir, gitDir: binding.gitDir };
    }
    await assertMissingWorktreePath(proposedPath);
    await git(["worktree", "add", proposedPath, "-b", branch, baseHead], root);
    await assertSafeGitAttributesInWorktree(proposedPath, await trackedWorktreePaths(proposedPath));
    const binding = await assertWorktreeBinding(proposedPath, branch, commonGitDir, baseHead, true);
    await hydrateIgnoredUnityPlugins(root, proposedPath);
    return { projectRoot: root, worktreePath: proposedPath, baseHead, branch, commonGitDir, gitDir: binding.gitDir };
}
export async function commitEvidence(worktree, baseHead, policy, taskId, preparedMerges = [], previousPhaseHead) {
    const commitPolicy = policy?.commit ?? defaultCommitPolicy, head = await git(["rev-parse", "--verify", "HEAD^{commit}"], worktree), initialStatus = await git(["status", "--porcelain"], worktree), tree = await git(["rev-parse", `${head}^{tree}`], worktree);
    const hashes = splitLines(await git(["rev-list", "--first-parent", "--reverse", `${baseHead}..${head}`], worktree)), subject = await git(["show", "-s", "--format=%s", head], worktree), trailers = await git(["show", "-s", "--format=%(trailers:only,unfold)", head], worktree), changed = splitLines(await git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", baseHead, head], worktree));
    let phaseCommitsValid = true, preparedMergesValid = true, expectedParent = baseHead;
    const matchedPrepared = new Set();
    for (const hash of hashes) {
        const parents = (splitLines(await git(["rev-list", "--parents", "-n", "1", hash], worktree))[0] ?? "").split(" "), parent = parents[1], phaseSubject = await git(["show", "-s", "--format=%s", hash], worktree), phaseTrailers = await git(["show", "-s", "--format=%(trailers:only,unfold)", hash], worktree), phaseChanged = splitLines(await git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", parent, hash], worktree));
        if (parents.length > 2) {
            const index = preparedMerges.findIndex((prepared, candidate) => !matchedPrepared.has(candidate) && prepared.preMergeHead === parent && prepared.targetOid === parents[2]), prepared = index >= 0 ? preparedMerges[index] : undefined, bookkeeping = new Set([commitPolicy.version_file, ...commitPolicy.changelog_files, ...(commitPolicy.version_surfaces ?? []).map(surface => surface.path)]);
            if (!prepared || parents.length !== 3 || (prepared.strategy === "ours" && phaseChanged.some(changedPath => !bookkeeping.has(changedPath))))
                preparedMergesValid = false;
            else
                matchedPrepared.add(index);
        }
        if (parent !== expectedParent || !validSubject(phaseSubject, commitPolicy) || !phaseChanged.includes(commitPolicy.version_file) || !commitPolicy.changelog_files.some(value => phaseChanged.includes(value)) || (commitPolicy.require_task_trailer && !hasTaskTrailer(phaseTrailers, taskId)) || !(await versionSurfacesMatch(worktree, hash, phaseSubject, commitPolicy)) || !(await versionTransitionValid(worktree, parent, hash, phaseSubject, commitPolicy)) || !(await changelogAddsVersion(worktree, parent, hash, phaseSubject, commitPolicy)))
            phaseCommitsValid = false;
        expectedParent = hash;
    }
    if (matchedPrepared.size !== preparedMerges.length)
        preparedMergesValid = false;
    phaseCommitsValid &&= preparedMergesValid;
    const finalHead = await git(["rev-parse", "--verify", "HEAD^{commit}"], worktree), finalStatus = await git(["status", "--porcelain"], worktree);
    const previousPhaseRetained = !previousPhaseHead || hashes.includes(previousPhaseHead);
    return { head, tree, commitCount: hashes.length, clean: initialStatus === "" && finalStatus === "" && finalHead === head, subject, versionChanged: changed.includes(commitPolicy.version_file), changelogChanged: commitPolicy.changelog_files.some(value => changed.includes(value)), taskTrailerValid: !commitPolicy.require_task_trailer || hasTaskTrailer(trailers, taskId), versionSurfacesValid: await versionSurfacesMatch(worktree, head, subject, commitPolicy), preparedMergesValid, phaseCommitsValid, previousPhaseHead, previousPhaseRetained };
}
export async function commitAtomic(worktree, paths, subject, taskOutcome, taskId, commitPolicy = defaultCommitPolicy, preparedMerges = [], expectedBranch, expectedCommonGitDir, expectedHead, expectedGitDir, authorize, revoke, afterRefUpdate, validateAuthority) {
    if (!paths.length)
        throw new Error("commit paths must be explicit safe repository-relative paths");
    if (/\r|\n/.test(subject))
        throw new Error("commit subject must be a single line");
    const safePaths = paths.map(value => safeRepositoryPath(value, "commit"));
    if (safePaths.some((value, index) => value !== paths[index].replaceAll("\\", "/")))
        throw new Error("commit paths must be canonical safe repository-relative paths");
    if (!validSubject(subject, commitPolicy))
        throw new Error("commit subject does not satisfy repository policy");
    const taskTrailer = taskOutcome && taskId ? `${taskOutcome}: ${taskId}` : undefined;
    if ((taskOutcome && !taskId) || (!taskOutcome && taskId && commitPolicy.require_task_trailer) || (taskTrailer && !hasTaskTrailer(taskTrailer, taskId)) || (commitPolicy.require_task_trailer && !taskTrailer))
        throw new Error("commit must include the governed run task trailer");
    const binding = await assertWorktreeBinding(worktree, expectedBranch, expectedCommonGitDir, expectedHead, false, expectedGitDir);
    await assertSafeGitAttributesInWorktree(worktree, safePaths);
    await git(["add", "--", ...safePaths], worktree);
    const staged = splitLines(await git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-only"], worktree));
    if (!staged.length || staged.some(changed => !safePaths.some(selected => changed === selected || changed.startsWith(`${selected}/`))))
        throw new Error("commit preflight found staged paths outside the explicit selection");
    await assertWorktreeBinding(worktree, binding.branch, binding.commonGitDir, binding.head, false, binding.gitDir);
    const head = binding.head, mergeHead = await optionalGit(["rev-parse", "--verify", "MERGE_HEAD"], worktree), tree = await git(["write-tree"], worktree), candidateArgs = ["commit-tree", tree, "-p", head];
    if (mergeHead) {
        if (splitLines(mergeHead).length !== 1)
            throw new Error("commit preflight rejects octopus merge state");
        candidateArgs.push("-p", mergeHead);
    }
    candidateArgs.push("-m", subject);
    if (taskTrailer)
        candidateArgs.push("-m", taskTrailer);
    const candidate = await git(candidateArgs, worktree);
    await assertSafeGitAttributesAtCommit(worktree, candidate);
    if (!(await candidateCommitValid(worktree, candidate, head, commitPolicy, taskId, preparedMerges)))
        throw new Error("commit preflight rejected semantic version, changelog, trailer, or prepared merge evidence");
    const prepared = { preCommitHead: head, candidate, tree, ...(mergeHead ? { mergeHead } : {}) };
    if (authorize)
        await authorize(prepared);
    try {
        if (await git(["rev-parse", "--verify", "HEAD^{commit}"], worktree) !== head || await git(["write-tree"], worktree) !== tree || (await optionalGit(["rev-parse", "--verify", "MERGE_HEAD"], worktree)) !== mergeHead)
            throw new Error("commit preflight state changed before commit");
        await assertWorktreeBinding(worktree, binding.branch, binding.commonGitDir, head, false, binding.gitDir);
        if (validateAuthority)
            await validateAuthority(prepared);
        await git(["update-ref", "-m", subject, `refs/heads/${binding.branch}`, candidate, head], worktree);
        if (afterRefUpdate)
            await afterRefUpdate();
        if (mergeHead)
            await git(["reset", "--mixed", candidate], worktree);
        const actual = await git(["rev-parse", "--verify", "HEAD^{commit}"], worktree), actualValid = await candidateCommitValid(worktree, actual, head, commitPolicy, taskId, preparedMerges), actualTree = await git(["rev-parse", `${actual}^{tree}`], worktree), actualStatus = await git(["status", "--porcelain"], worktree);
        if (actual !== candidate || !actualValid || actualTree !== tree || actualStatus)
            throw new Error(`created commit diverged from validated preflight evidence (head=${actual === candidate}, semantic=${actualValid}, tree=${actualTree === tree}, clean=${!actualStatus})`);
        await assertWorktreeBinding(worktree, binding.branch, binding.commonGitDir, candidate, true, binding.gitDir);
        return prepared;
    }
    catch (error) {
        const current = await optionalGit(["rev-parse", "--verify", "HEAD^{commit}"], worktree);
        if (current === prepared.preCommitHead && revoke)
            await revoke(prepared);
        throw error;
    }
}
export async function reconcilePreparedCommit(worktree, prepared, expectedBranch, expectedCommonGitDir, expectedGitDir) {
    await assertWorktreeBinding(worktree, expectedBranch, expectedCommonGitDir, prepared.candidate, false, expectedGitDir);
    const mergeHead = await optionalGit(["rev-parse", "--verify", "MERGE_HEAD"], worktree);
    if (prepared.mergeHead) {
        if (mergeHead && mergeHead.toLowerCase() !== prepared.mergeHead.toLowerCase())
            throw new Error("prepared commit recovery found an unexpected MERGE_HEAD");
        if (mergeHead)
            await git(["reset", "--mixed", prepared.candidate], worktree);
    }
    else if (mergeHead)
        throw new Error("non-merge prepared commit recovery found MERGE_HEAD");
    const head = await git(["rev-parse", "--verify", "HEAD^{commit}"], worktree), tree = await git(["rev-parse", `${head}^{tree}`], worktree), status = await git(["status", "--porcelain"], worktree);
    if (head !== prepared.candidate || tree !== prepared.tree || status)
        throw new Error("prepared commit recovery does not match the signed clean candidate tree");
    await assertWorktreeBinding(worktree, expectedBranch, expectedCommonGitDir, prepared.candidate, true, expectedGitDir);
}
export async function applyPreparedCommit(worktree, prepared, expectedBranch, expectedCommonGitDir, expectedGitDir, validateAuthority) {
    const binding = await assertWorktreeBinding(worktree, expectedBranch, expectedCommonGitDir, prepared.preCommitHead, false, expectedGitDir);
    const candidateTree = await git(["rev-parse", `${prepared.candidate}^{tree}`], worktree), parents = (splitLines(await git(["rev-list", "--parents", "-n", "1", prepared.candidate], worktree))[0] ?? "").split(" ").slice(1), expectedParents = [prepared.preCommitHead, ...(prepared.mergeHead ? [prepared.mergeHead] : [])];
    if (candidateTree !== prepared.tree || JSON.stringify(parents) !== JSON.stringify(expectedParents))
        throw new Error("signed prepared candidate object does not match its tree and parent binding");
    const indexTree = await git(["write-tree"], worktree), mergeHead = await optionalGit(["rev-parse", "--verify", "MERGE_HEAD"], worktree), unstaged = await git(["diff", "--no-ext-diff", "--no-textconv", "--name-only"], worktree), untracked = await git(["ls-files", "--others", "--exclude-standard"], worktree);
    if (indexTree !== prepared.tree || mergeHead !== (prepared.mergeHead ?? null) || unstaged || untracked)
        throw new Error("worktree and index no longer match the signed prepared candidate");
    await assertWorktreeBinding(worktree, binding.branch, binding.commonGitDir, prepared.preCommitHead, false, binding.gitDir);
    await validateAuthority(prepared);
    await git(["update-ref", "-m", "Captain signed prepared commit recovery", `refs/heads/${binding.branch}`, prepared.candidate, prepared.preCommitHead], worktree);
    if (prepared.mergeHead)
        await git(["reset", "--mixed", prepared.candidate], worktree);
    await reconcilePreparedCommit(worktree, prepared, expectedBranch, expectedCommonGitDir, expectedGitDir);
}
export async function prepareMerge(worktree, commitOid, strategy = "ort", authorize, revoke, expectedBranch, expectedCommonGitDir, expectedHead, expectedGitDir, afterMerge, operationToken, validateAuthority) {
    await assertWorktreeBinding(worktree, expectedBranch, expectedCommonGitDir, expectedHead, false, expectedGitDir);
    if (!/^[0-9a-f]{40,64}$/i.test(commitOid))
        throw new Error("merge target must be a full commit object id");
    if (await optionalGit(["rev-parse", "--verify", "MERGE_HEAD"], worktree))
        throw new Error("merge preparation refuses a preexisting merge state");
    const preMergeHead = await git(["rev-parse", "--verify", "HEAD^{commit}"], worktree), resolved = await git(["rev-parse", "--verify", `${commitOid}^{commit}`], worktree);
    if (resolved.toLowerCase() !== commitOid.toLowerCase() || await git(["cat-file", "-t", commitOid], worktree) !== "commit")
        throw new Error("merge target is not the pinned commit object");
    await assertSafeGitAttributesAtCommit(worktree, preMergeHead);
    await assertSafeGitAttributesAtCommit(worktree, resolved);
    const mergePaths = splitLines(await git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", preMergeHead, resolved], worktree));
    await assertSafeGitAttributesInWorktree(worktree, mergePaths);
    if (await git(["status", "--porcelain"], worktree))
        throw new Error("merge preparation requires a clean worktree");
    const prepared = { preMergeHead, targetOid: resolved, strategy, ...(operationToken ? { operationToken } : {}) };
    if (authorize)
        await authorize(prepared);
    try {
        try {
            await assertWorktreeBinding(worktree, expectedBranch, expectedCommonGitDir, preMergeHead, true, expectedGitDir);
            if (validateAuthority)
                await validateAuthority(prepared);
            await gitInvocation(["merge", "--no-ff", "--no-commit", ...(strategy === "ours" ? ["-s", "ours"] : []), resolved], worktree);
            if (afterMerge)
                await afterMerge();
        }
        catch (error) {
            const mergeHead = await optionalGit(["rev-parse", "--verify", "MERGE_HEAD"], worktree), currentHead = await git(["rev-parse", "--verify", "HEAD^{commit}"], worktree), conflicts = splitLines(await git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", "--diff-filter=U"], worktree));
            if (mergeHead?.toLowerCase() === resolved.toLowerCase() && currentHead === preMergeHead && conflicts.length)
                return { commitOid: resolved, preMergeHead, strategy, status: "conflicts", conflicts };
            throw error;
        }
        const mergeHead = await git(["rev-parse", "--verify", "MERGE_HEAD"], worktree), currentHead = await git(["rev-parse", "--verify", "HEAD^{commit}"], worktree);
        if (mergeHead.toLowerCase() !== resolved.toLowerCase() || currentHead !== preMergeHead)
            throw new Error("prepared merge state does not match the pinned commit and pre-merge HEAD");
        return { commitOid: resolved, preMergeHead, strategy, status: "ready", conflicts: [] };
    }
    catch (error) {
        let cleanupError;
        try {
            const mergeHead = await optionalGit(["rev-parse", "--verify", "MERGE_HEAD"], worktree);
            if (mergeHead?.toLowerCase() === prepared.targetOid.toLowerCase()) {
                await gitInvocation(["merge", "--abort"], worktree);
                await reconcilePreparedMerge(worktree, prepared);
            }
            else if (!mergeHead)
                await reconcilePreparedMerge(worktree, prepared);
            else
                throw new Error("rejected prepared merge contains an unexpected MERGE_HEAD");
        }
        catch (cleanup) {
            cleanupError = cleanup;
        }
        if (cleanupError)
            throw new Error(`prepared merge failed and cleanup could not be proven; signed authorization was retained for recovery: ${cleanupError.message}`, { cause: error });
        if (revoke)
            await revoke(prepared);
        throw error;
    }
}
export async function abortMerge(worktree, prepared, validateAuthority) { const mergeHead = await optionalGit(["rev-parse", "--verify", "MERGE_HEAD"], worktree), currentHead = await git(["rev-parse", "--verify", "HEAD^{commit}"], worktree); if (mergeHead?.toLowerCase() !== prepared.targetOid.toLowerCase() || currentHead !== prepared.preMergeHead)
    throw new Error("current merge state does not match the pinned prepared merge"); if (validateAuthority)
    await validateAuthority(prepared); await gitInvocation(["merge", "--abort"], worktree); if (await optionalGit(["rev-parse", "--verify", "MERGE_HEAD"], worktree) || await git(["rev-parse", "--verify", "HEAD^{commit}"], worktree) !== prepared.preMergeHead || await git(["status", "--porcelain"], worktree))
    throw new Error("audited merge abort did not restore the clean pre-merge state"); }
export async function preparedMergeState(worktree, prepared) { const mergeHead = await optionalGit(["rev-parse", "--verify", "MERGE_HEAD"], worktree), currentHead = await optionalGit(["rev-parse", "--verify", "HEAD^{commit}"], worktree); if (currentHead !== prepared.preMergeHead)
    return "diverged"; if (mergeHead?.toLowerCase() === prepared.targetOid.toLowerCase())
    return "pinned"; if (mergeHead)
    return "diverged"; return await git(["status", "--porcelain"], worktree) ? "diverged" : "clean"; }
export async function reconcilePreparedMerge(worktree, prepared) { if (await optionalGit(["rev-parse", "--verify", "MERGE_HEAD"], worktree) || await git(["rev-parse", "--verify", "HEAD^{commit}"], worktree) !== prepared.preMergeHead || await git(["status", "--porcelain"], worktree))
    throw new Error("stale merge authorization can be discarded only from its clean unchanged pre-merge state"); }
const normalizeSourceStatus = (status) => status.split(/\r?\n/).filter(line => line && !(line.startsWith("?? ") && line.slice(3).trim().toLowerCase().endsWith(".meta"))).join("\n");
export async function sourceState(worktree, policy) { const topLevel = path.resolve(await git(["rev-parse", "--show-toplevel"], worktree)), gitDir = path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-dir"], worktree)), head = await git(["rev-parse", "--verify", "HEAD^{commit}"], worktree), branch = await optionalGit(["symbolic-ref", "--quiet", "--short", "HEAD"], worktree) ?? undefined, branchHead = branch ? await git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], worktree) : undefined, commonGitDir = path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktree)), initialStatus = normalizeSourceStatus(await git(["status", "--porcelain"], worktree)), tree = await git(["rev-parse", `${head}^{tree}`], worktree), manifest = await sourceManifest(worktree, policy?.sourceManifestExcludes ?? [], policy?.sourceManifestRootFileExcludes ?? []), finalHead = await git(["rev-parse", "--verify", "HEAD^{commit}"], worktree), finalStatus = normalizeSourceStatus(await git(["status", "--porcelain"], worktree)); return { head, tree, status: initialStatus || finalStatus || (head === finalHead ? "" : "HEAD changed during source-state capture"), manifest, branch, branchHead, commonGitDir, topLevel, gitDir }; }
export async function assertWorktreeBinding(worktree, expectedBranch, expectedCommonGitDir, expectedHead, requireClean = false, expectedGitDir) { const real = await realpath(worktree), owned = path.resolve(worktree); if (path.resolve(real).toLowerCase() !== owned.toLowerCase())
    throw new Error("worktree path resolves through a reparse point"); const topLevel = path.resolve(await git(["rev-parse", "--show-toplevel"], worktree)); if (topLevel.toLowerCase() !== owned.toLowerCase())
    throw new Error("Git top-level does not match the owned worktree"); const branch = await optionalGit(["symbolic-ref", "--quiet", "--short", "HEAD"], worktree); if (!branch || (expectedBranch && branch !== expectedBranch))
    throw new Error("worktree symbolic target branch binding diverged"); const commonGitDir = path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], worktree)), gitDir = path.resolve(await git(["rev-parse", "--path-format=absolute", "--git-dir"], worktree)); if (expectedCommonGitDir && commonGitDir.toLowerCase() !== path.resolve(expectedCommonGitDir).toLowerCase())
    throw new Error("worktree common Git directory binding diverged"); if (expectedGitDir && gitDir.toLowerCase() !== path.resolve(expectedGitDir).toLowerCase())
    throw new Error("linked worktree Git directory binding diverged"); const head = await git(["rev-parse", "--verify", "HEAD^{commit}"], worktree), branchHead = await git(["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], worktree); if (head !== branchHead || (expectedHead && head !== expectedHead))
    throw new Error("worktree target branch ref binding diverged"); if (requireClean && await git(["status", "--porcelain"], worktree))
    throw new Error("target branch worktree must be clean before Captain uses it"); return { branch, commonGitDir, gitDir, topLevel, head }; }
async function optionalGit(args, cwd) { try {
    return await git(args, cwd);
}
catch {
    return null;
} }
async function validateTargetBranch(root, branch) { if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.includes("..") || branch.includes("//") || branch.includes("@{") || branch.endsWith("/") || branch.endsWith(".") || branch.toLowerCase().endsWith(".lock"))
    throw new Error("target branch name is unsafe"); await git(["check-ref-format", "--branch", branch], root); }
async function worktreeEntries(root) { const fields = (await git(["worktree", "list", "--porcelain", "-z"], root)).split("\0"), result = []; let current; for (const field of fields) {
    if (!field) {
        if (current)
            result.push(current);
        current = undefined;
        continue;
    }
    if (field.startsWith("worktree "))
        current = { worktree: field.slice(9) };
    else if (current && field.startsWith("HEAD "))
        current.head = field.slice(5);
    else if (current && field.startsWith("branch "))
        current.branch = field.slice(7);
} if (current)
    result.push(current); return result; }
function isPathInside(parent, candidate) { const relative = path.relative(path.resolve(parent), path.resolve(candidate)); return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); }
async function assertMissingWorktreePath(worktreePath) { try {
    await lstat(worktreePath);
    throw new Error(`canonical worktree path already exists: ${worktreePath}`);
}
catch (error) {
    if (error.code !== "ENOENT")
        throw error;
} }
async function boundedGitShow(cwd, object, label) { const value = await git(["show", object], cwd); if (Buffer.byteLength(value) > maxPolicyInput)
    throw new Error(`${label} exceeds the bounded input limit`); return value; }
async function assertSafeGitAttributesAtCommit(cwd, commit) { for (const file of splitLines(await git(["ls-tree", "-r", "--name-only", commit], cwd)).filter(value => value.toLowerCase() === ".gitattributes" || value.toLowerCase().endsWith("/.gitattributes"))) {
    const content = await boundedGitShow(cwd, `${commit}:${file}`, "Git attributes");
    if (hasExecutableGitAttributes(content))
        throw new Error(`Git attributes may not configure clean filters or merge drivers: ${file}`);
} }
async function assertSafeGitMetadataAttributes(cwd) { const raw = await git(["rev-parse", "--git-path", "info/attributes"], cwd), file = path.resolve(cwd, raw); try {
    const info = await lstat(file);
    if (info.isSymbolicLink() || !info.isFile())
        throw new Error("Git metadata attributes must be a regular file");
    const content = await readFile(file, "utf8");
    if (Buffer.byteLength(content) > maxPolicyInput || hasExecutableGitAttributes(content))
        throw new Error("Git metadata attributes may not configure clean filters or merge drivers");
}
catch (error) {
    if (error.code !== "ENOENT")
        throw error;
} }
async function trackedWorktreePaths(cwd) { return splitLines(await git(["ls-files"], cwd)); }
async function assertSafeGitAttributesInWorktree(cwd, selectedPaths) { await assertSafeGitMetadataAttributes(cwd); const files = new Set(); const collect = async (target) => { let info; try {
    info = await lstat(target);
}
catch (error) {
    if (error.code === "ENOENT")
        return;
    throw error;
} if (info.isSymbolicLink())
    return; if (info.isFile()) {
    if (path.basename(target).toLowerCase() === ".gitattributes")
        files.add(target);
    return;
} if (!info.isDirectory())
    return; for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.name.toLowerCase() === ".git")
        continue;
    const child = path.join(target, entry.name);
    if (entry.name.toLowerCase() === ".gitattributes")
        files.add(child);
    else if (entry.isDirectory())
        await collect(child);
} }; for (const selected of selectedPaths.length ? selectedPaths : ["."]) {
    const segments = selected.replaceAll("\\", "/").split("/").filter(value => value && value !== ".");
    files.add(path.join(cwd, ".gitattributes"));
    for (let index = 1; index < segments.length; index++)
        files.add(path.join(cwd, ...segments.slice(0, index), ".gitattributes"));
    const target = path.resolve(cwd, selected);
    try {
        if ((await lstat(target)).isDirectory())
            await collect(target);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
} for (const file of files) {
    try {
        const info = await lstat(file);
        if (info.isSymbolicLink() || !info.isFile())
            throw new Error(`Git attributes must be a regular file: ${path.relative(cwd, file)}`);
        const content = await readFile(file, "utf8");
        if (Buffer.byteLength(content) > maxPolicyInput)
            throw new Error(`Git attributes exceeds the bounded input limit: ${path.relative(cwd, file)}`);
        if (hasExecutableGitAttributes(content))
            throw new Error(`Git attributes may not configure clean filters or merge drivers: ${path.relative(cwd, file)}`);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
} }
function hasExecutableGitAttributes(content) { return content.split(/\r?\n/).some(line => { const value = line.replace(/\s+#.*$/, "").trim(); return value && /(?:^|\s)(?:filter|merge)(?:\s|=|$)/i.test(value); }); }
async function rejectReparseAncestors(root, target) { for (let cursor = path.resolve(target); cursor.startsWith(path.resolve(root)); cursor = path.dirname(cursor)) {
    try {
        if ((await lstat(cursor)).isSymbolicLink())
            throw new Error(`canonical worktree container crosses a reparse point: ${cursor}`);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    if (cursor === path.resolve(root))
        break;
} }
function safeRepositoryPath(value, label) { const normalized = value.replaceAll("\\", "/"), segments = normalized.split("/"); if (path.isAbsolute(value) || segments.some(segment => segment === "" || segment === "." || segment === "..") || !/^[A-Za-z0-9._/& -]+$/.test(value))
    throw new Error(`${label} path must be a safe repository-relative path`); return normalized; }
function objectValue(value, label) { if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`); return value; }
function parseObject(text, label) { try {
    return objectValue(JSON.parse(text), label);
}
catch (error) {
    if (error.message.includes(label))
        throw error;
    throw new Error(`${label} is not valid JSON`);
} }
function stringRecord(value, label) { const record = objectValue(value, label), result = {}; for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string" || !item.trim())
        throw new Error(`${label} must contain nonempty strings`);
    result[key] = item;
} return result; }
function validateCommitPolicy(input) { const value = objectValue(input, "trusted repository commit policy"); for (const key of ["conventional", "require_version_suffix", "require_task_trailer"])
    if (value[key] !== undefined && typeof value[key] !== "boolean")
        throw new Error(`${key} must be boolean`); const conventional = value.conventional ?? true, requireVersionSuffix = value.require_version_suffix ?? true; if (!conventional && requireVersionSuffix)
    throw new Error("unsupported commit policy: deterministic version suffixes require Conventional Commit types"); if (typeof value.version_file !== "string")
    throw new Error("trusted repository commit policy must configure version_file"); const versionFile = safeRepositoryPath(value.version_file, "version file"); if (!Array.isArray(value.changelog_files) || value.changelog_files.length === 0 || value.changelog_files.some((item) => typeof item !== "string"))
    throw new Error("trusted repository commit policy must configure changelog files"); const changelogFiles = value.changelog_files.map((item) => safeRepositoryPath(item, "changelog")); if (new Set(changelogFiles).size !== changelogFiles.length)
    throw new Error("trusted changelog paths must be unique"); if (!Array.isArray(value.version_surfaces) || (requireVersionSuffix && value.version_surfaces.length === 0) || (!requireVersionSuffix && value.version_surfaces.length > 0))
    throw new Error("unsupported commit policy: version surfaces must be nonempty exactly when version suffixes are required"); const versionSurfaces = value.version_surfaces.map((inputSurface) => { const surface = objectValue(inputSurface, "version surface"); if (typeof surface.path !== "string" || typeof surface.pattern !== "string")
    throw new Error("version surface path and pattern are required"); const surfacePath = safeRepositoryPath(surface.path, "version surface"); compilePattern(surface.pattern); if (!surface.pattern.includes("?<version>") && !/(^|[^\\])\((?!\?)/.test(surface.pattern.replace(/^\(\?m\)/, "")))
    throw new Error("version surface pattern must capture the version"); return { path: surfacePath, pattern: surface.pattern }; }); if (new Set(versionSurfaces.map((surface) => surface.path)).size !== versionSurfaces.length)
    throw new Error("version surface paths must be unique"); if (requireVersionSuffix && !versionSurfaces.some((surface) => surface.path === versionFile))
    throw new Error("version surfaces must include version_file"); return { conventional, require_version_suffix: requireVersionSuffix, require_task_trailer: value.require_task_trailer ?? false, version_file: versionFile, version_surfaces: versionSurfaces, changelog_files: changelogFiles }; }
function validSubject(subject, policy) { const conventional = /^(feat|fix|refactor|perf|test|docs|build|ci|chore)(\([^)]+\))?!?: .+/.test(subject), versioned = subjectVersion(subject) !== null; return (!(policy.conventional ?? true) || conventional) && (!(policy.require_version_suffix ?? true) || versioned); }
function hasTaskTrailer(message, taskId) { if (!taskId || !/^[A-Za-z0-9._-]+$/.test(taskId))
    return false; const matches = [...message.matchAll(/(?:^|\r?\n)(?:Implements|Completes|Needs-QA):[ \t]+([^\r\n]+)(?:\r?\n|$)/g)].map(match => match[1].trim()); return matches.length === 1 && matches[0] === taskId; }
async function candidateCommitValid(worktree, hash, expectedParent, policy, taskId, preparedMerges) { const parents = (splitLines(await git(["rev-list", "--parents", "-n", "1", hash], worktree))[0] ?? "").split(" "), parent = parents[1], subject = await git(["show", "-s", "--format=%s", hash], worktree), trailers = await git(["show", "-s", "--format=%(trailers:only,unfold)", hash], worktree), changed = splitLines(await git(["diff", "--no-ext-diff", "--no-textconv", "--name-only", parent, hash], worktree)); let mergeValid = parents.length === 2; if (parents.length === 3) {
    const prepared = preparedMerges.find(value => value.preMergeHead === parent && value.targetOid === parents[2]), bookkeeping = new Set([policy.version_file, ...policy.changelog_files, ...(policy.version_surfaces ?? []).map(surface => surface.path)]);
    mergeValid = Boolean(prepared) && (prepared.strategy !== "ours" || changed.every(changedPath => bookkeeping.has(changedPath)));
} return parent === expectedParent && mergeValid && validSubject(subject, policy) && changed.includes(policy.version_file) && policy.changelog_files.some(value => changed.includes(value)) && (!policy.require_task_trailer || hasTaskTrailer(trailers, taskId)) && await versionSurfacesMatch(worktree, hash, subject, policy) && await versionTransitionValid(worktree, parent, hash, subject, policy) && await changelogAddsVersion(worktree, parent, hash, subject, policy); }
function compilePattern(pattern) { const multiline = pattern.startsWith("(?m)"), body = multiline ? pattern.slice(4) : pattern; return compileSafeRegex(body, multiline ? "m" : "", "version surface pattern"); }
async function versionSurfacesMatch(worktree, hash, subject, policy) { const surfaces = policy.version_surfaces ?? []; if (!surfaces.length)
    return !(policy.require_version_suffix ?? true); const expected = subjectVersion(subject); if (!expected)
    return false; for (const surface of surfaces) {
    try {
        const content = await boundedGitShow(worktree, `${hash}:${surface.path}`, "version surface"), expression = compilePattern(surface.pattern), matches = [...content.matchAll(new RegExp(expression.source, `${expression.flags}g`))];
        if (matches.length !== 1 || (matches[0].groups?.version ?? matches[0][1]) !== expected)
            return false;
    }
    catch {
        return false;
    }
} return true; }
async function versionAt(worktree, hash, policy) { const values = []; for (const surface of policy.version_surfaces ?? []) {
    try {
        const content = await boundedGitShow(worktree, `${hash}:${surface.path}`, "version surface"), expression = compilePattern(surface.pattern), matches = [...content.matchAll(new RegExp(expression.source, `${expression.flags}g`))], value = matches.length === 1 ? (matches[0].groups?.version ?? matches[0][1]) : undefined;
        if (!value || !parseStrictSemVer(value))
            return null;
        values.push(value);
    }
    catch {
        return null;
    }
} return values.length > 0 && values.every(value => value === values[0]) ? values[0] : null; }
async function versionTransitionValid(worktree, parent, hash, subject, policy) {
    if (!(policy.require_version_suffix ?? true))
        return true;
    const parsedSubject = /^(feat|fix|refactor|perf|test|docs|build|ci|chore)(?:\([^)]+\))?(!)?: .+/.exec(subject), suffix = subjectVersion(subject);
    // The configured version_file owns the prior release number. Stale companion
    // metadata must be repairable in the new commit without rewriting its parent.
    // The candidate still has to synchronize EVERY configured version surface.
    const canonical = policy.version_surfaces?.filter(surface => surface.path === policy.version_file) ?? [];
    const beforeValue = canonical.length === 1 ? await versionAt(worktree, parent, { ...policy, version_surfaces: canonical }) : null;
    const afterValue = await versionAt(worktree, hash, policy);
    if (!parsedSubject || !suffix || !beforeValue || !afterValue || suffix !== afterValue)
        return false;
    const before = parseStrictSemVer(beforeValue);
    if (parsedSubject[2])
        return before.major < Number.MAX_SAFE_INTEGER && afterValue === `${before.major + 1}.0.0`;
    if (parsedSubject[1] === "feat")
        return before.minor < Number.MAX_SAFE_INTEGER && afterValue === `${before.major}.${before.minor + 1}.0`;
    return before.patch < Number.MAX_SAFE_INTEGER && afterValue === `${before.major}.${before.minor}.${before.patch + 1}`;
}
async function changelogAddsVersion(worktree, parent, hash, subject, policy) { if (!(policy.require_version_suffix ?? true))
    return true; const version = subjectVersion(subject); if (!version)
    return false; const diff = await git(["diff", "--no-ext-diff", "--no-textconv", "--unified=0", parent, hash, "--", ...policy.changelog_files], worktree), marker = new RegExp(`(?:^|[^0-9])v?${version.replaceAll(".", "\\.")}(?:[^0-9]|$)`, "i"); return diff.split(/\r?\n/).some(line => /^\+(?!\+\+)/.test(line) && marker.test(line.slice(1))); }
async function sourceManifest(root, configuredExcludes, rootFileExcludes) { const lines = [], excludes = configuredExcludes.map(item => safeRepositoryPath(item, "source manifest exclusion").replace(/\/$/, "")), tracked = new Set((await git(["ls-files", "--cached", "-z"], root)).split("\0").filter(Boolean).map(item => item.replaceAll("\\", "/"))); async function walk(dir) { for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.relative(root, path.join(dir, entry.name)).replaceAll("\\", "/");
    if (excludes.some(item => relative.toLowerCase() === item.toLowerCase() || relative.toLowerCase().startsWith(`${item.toLowerCase()}/`)) || (!relative.includes("/") && rootFileExcludes.some(pattern => rootFilePatternMatches(relative, pattern))) || (relative.toLowerCase().endsWith(".meta") && !tracked.has(relative)) || relative === ".git" || relative.startsWith(".captain-sdlc/trace/") || relative.startsWith(".captain-proof/") || relative === "node_modules" || relative.includes("/node_modules/"))
        continue;
    const full = path.join(dir, entry.name), info = await lstat(full);
    if (info.isSymbolicLink())
        throw new Error(`source manifest crosses reparse point: ${relative}`);
    if (info.isDirectory())
        await walk(full);
    else if (info.isFile())
        lines.push(`${relative}:${createHash("sha256").update(await readFile(full)).digest("hex")}`);
} } await walk(root); return digest(lines.join("\n")); }
function rootFilePatternMatches(file, pattern) { const lower = file.toLowerCase(), expected = pattern.toLowerCase(); return expected.startsWith("*.") ? lower.endsWith(expected.slice(1)) : lower === expected; }
const digest = (text) => createHash("sha256").update(text).digest("hex"), splitLines = (value) => value.split(/\r?\n/).filter(Boolean);
