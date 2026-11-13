import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
const key = (value) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const oid = (value) => typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const hash = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const inside = (file, root) => { const relative = path.relative(path.resolve(root), path.resolve(file)); return !relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)); };
async function pinned(file, forbiddenRoots) {
    if (!file || typeof file.path !== "string" || !path.isAbsolute(file.path) || !/^[A-Za-z0-9:/\\._ -]+$/.test(file.path) || !hash(file.sha256))
        throw new Error("release-intent requires an absolute installed checker path and SHA-256");
    const absolute = path.resolve(file.path), info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || key(await realpath(absolute)) !== key(absolute))
        throw new Error("release-intent checker must be a canonical regular file");
    if (forbiddenRoots.some(root => inside(absolute, root)))
        throw new Error("release-intent checker must be installed outside the repository");
    const bytes = await readFile(absolute);
    if (sha(bytes) !== file.sha256)
        throw new Error("release-intent checker digest changed from trusted base");
    return bytes;
}
function managedAssembly(bytes) {
    if (bytes.length < 64 || bytes.readUInt16LE(0) !== 0x5a4d)
        return false;
    const pe = bytes.readUInt32LE(0x3c);
    if (pe > bytes.length - 256 || bytes.toString("ascii", pe, pe + 4) !== "PE\0\0")
        return false;
    const header = pe + 24, magic = bytes.readUInt16LE(header), directories = magic === 0x10b ? header + 96 : magic === 0x20b ? header + 112 : 0;
    return directories > 0 && directories + 120 <= bytes.length && bytes.readUInt32LE(directories + 112) !== 0 && bytes.readUInt32LE(directories + 116) >= 72;
}
function nativeExecutable(bytes) {
    return bytes.length >= 4 && (bytes.readUInt16LE(0) === 0x5a4d || [0x7f454c46, 0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca].includes(bytes.readUInt32BE(0)));
}
export async function assertReleaseIntentChecker(checker, forbiddenRoots) {
    const bytes = await pinned(checker, forbiddenRoots);
    if (checker.kind !== undefined && checker.kind !== "script" && checker.kind !== "native")
        throw new Error("unsupported release-intent checker kind");
    if (checker.args && (!Array.isArray(checker.args) || checker.args.some(arg => typeof arg !== "string" || !/^[A-Za-z0-9:/\\._ =#-]+$/.test(arg))))
        throw new Error("release-intent checker arguments must be literal bounded tokens");
    if (checker.kind !== "native")
        return;
    if (path.extname(checker.path).toLowerCase() !== ".dll" || !managedAssembly(bytes))
        throw new Error("native release-intent checker requires a managed DLL assembly");
    if (typeof checker.executable !== "string" || !/^dotnet(?:\.exe)?$/i.test(path.basename(checker.executable)))
        throw new Error("native release-intent checker requires the installed dotnet executable");
    const executable = await pinned({ path: checker.executable, sha256: checker.executableSha256 }, forbiddenRoots);
    if (!nativeExecutable(executable))
        throw new Error("native release-intent executable must be a native dotnet binary");
    if (!Array.isArray(checker.dependencies) || !checker.dependencies.length || checker.dependencies.length > 128)
        throw new Error("native checker requires complete dependency integrity pins");
    const directory = path.dirname(checker.path), names = new Set([path.basename(checker.path)]);
    for (const dependency of checker.dependencies) {
        if (!dependency || key(path.dirname(dependency.path)) !== key(directory) || names.has(path.basename(dependency.path)))
            throw new Error("native checker dependencies must be unique installed sibling files");
        names.add(path.basename(dependency.path));
        await pinned(dependency, forbiddenRoots);
    }
    if (JSON.stringify((await readdir(directory)).sort()) !== JSON.stringify([...names].sort()))
        throw new Error("native checker installed dependency file set changed");
    const stem = path.basename(checker.path, ".dll");
    if (!names.has(stem + ".deps.json") || !names.has(stem + ".runtimeconfig.json"))
        throw new Error("native checker requires pinned runtime configuration dependencies");
    const args = checker.args;
    if (!args || args.length !== 6 || args[0] !== "release" || args[1] !== "check" || args[2] !== "--target-branch" || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(args[3]) || args[3].includes("..") || args[4] !== "--authority-store" || !path.isAbsolute(args[5]) || forbiddenRoots.some(root => inside(args[5], root)))
        throw new Error("native checker arguments must select one target and external state store; context arguments are parent-owned");
}
export function releaseIntentCommand(checker) {
    return [checker.kind === "native" ? checker.executable : process.execPath, checker.path, ...(checker.args ?? []), ...(checker.kind === "native" ? ["--captain-context-stdin"] : [])].map(value => '"' + value + '"').join(" ");
}
function environment(native = false) {
    const env = { ...process.env };
    for (const name of Object.keys(env))
        if (/^GIT_/i.test(name) || ["CAPTAIN_SEQUENCE_AUTH_KEY", "PLUGIN_DATA", "CAPTAIN_PLUGIN_DATA", "NODE_OPTIONS", "NODE_PATH"].includes(name)
            || (native && (/^(?:CAPTAIN_|NODE_|DOTNET_|CORECLR_|COR_|COMPLUS_|LD_|DYLD_)/i.test(name) || ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].includes(name))))
            delete env[name];
    return { ...env, GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
}
export async function runReleaseIntentChecker(checker, cwd, forbiddenRoots) {
    if (checker.kind === "native")
        throw new Error("native checker requires the trusted parent authority operation");
    await assertReleaseIntentChecker(checker, forbiddenRoots);
    let result;
    try {
        const output = await promisify(execFile)(process.execPath, [checker.path, ...(checker.args ?? [])], { cwd, windowsHide: true, env: environment(), maxBuffer: 10 * 1024 * 1024 });
        result = { exitCode: 0, ...output };
    }
    catch (error) {
        result = { exitCode: Number(error.code) || 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
    }
    await assertReleaseIntentChecker(checker, forbiddenRoots);
    return result;
}
function validateContext(context) {
    if (!context || !oid(context.base) || !oid(context.head) || !oid(context.tree))
        throw new Error("native checker requires exact parent-owned revision context");
    const d = context.decision;
    if (d && (!hash(d.report_digest) || !hash(d.finding_digest) || !["confirm-major", "reject-major", "revise"].includes(d.choice) || typeof d.actor !== "string" || !d.actor.trim() || d.actor.length > 200 || typeof d.reason !== "string" || !d.reason.trim() || d.reason.length > 12000 || typeof d.all_findings !== "boolean" || (d.choice === "reject-major" && !d.all_findings)))
        throw new Error("compatibility adjudication requires actual human feedback for all reviewed findings");
}
async function summaryOf(result, checker, context, forbiddenRoots) {
    if (result.stdout.length > 1024 * 1024)
        throw new Error("native checker summary exceeds its bounded response");
    let value;
    try {
        value = JSON.parse(result.stdout);
    }
    catch {
        throw new Error("native checker returned an invalid structured summary");
    }
    if (!value || !["ready", "needs_human", "needs_revision", "blocked"].includes(value.Status) || !Array.isArray(value.Errors) || value.Errors.length > 32 || value.Errors.some((e) => typeof e !== "string" || e.length > 2000))
        throw new Error("native checker summary is incomplete");
    if ((value.Status === "ready") !== (result.exitCode === 0))
        throw new Error("native checker status contradicts its exit code");
    if (value.Status !== "blocked" && (!oid(value.Base) || (value.PolicyBase ?? value.Base) !== context.base || value.Head !== context.head || value.Tree !== context.tree || !["none", "patch", "minor", "major"].includes(value.Bump)))
        throw new Error("native checker revision context differs from the signed run");
    if (value.Status === "blocked" && value.Coverage == null)
        value.Coverage = [];
    if (!Array.isArray(value.Coverage) || value.Coverage.length > 64)
        throw new Error("native checker coverage summary is invalid");
    const coverage = value.Coverage.map((gap) => {
        if (!gap || typeof gap.Name !== "string" || gap.Name.length > 64 || gap.Status !== "unavailable" || typeof gap.Reason !== "string" || !gap.Reason.trim() || gap.Reason.length > 2000 || typeof gap.Affected !== "boolean" || !["block", "report"].includes(gap.OnUnavailable))
            throw new Error("native checker coverage evidence is invalid");
        return { name: gap.Name, status: gap.Status, reason: gap.Reason, affected: gap.Affected, onUnavailable: gap.OnUnavailable };
    });
    const store = checker.args[5];
    async function report(file, expected) {
        if (typeof file !== "string" || !path.isAbsolute(file) || !inside(file, store) || forbiddenRoots.some(root => inside(file, root)))
            throw new Error("native checker report must remain in its external state store");
        const stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 || key(await realpath(file)) !== key(file))
            throw new Error("native checker report is not a bounded canonical file");
        const digest = sha(await readFile(file));
        if (expected && digest !== expected)
            throw new Error("native checker report digest does not match its retained evidence");
        return digest;
    }
    if (value.Status !== "blocked") {
        if (!hash(value.ReportDigest) || !hash(value.FindingDigest))
            throw new Error("native checker report and finding digests are required");
        await report(value.ReportPath, value.ReportDigest);
    }
    if (["needs_human", "needs_revision"].includes(value.Status) && !value.HumanReportPath)
        throw new Error("native compatibility gate requires its retained human report");
    const humanReportSha256 = value.HumanReportPath ? await report(value.HumanReportPath, undefined) : undefined;
    return { status: value.Status, base: value.Base ?? null, policyBase: value.PolicyBase ?? value.Base ?? null, head: value.Head ?? null, tree: value.Tree ?? null, bump: value.Bump ?? null, reportDigest: value.ReportDigest ?? null, findingDigest: value.FindingDigest ?? null, reportPath: value.ReportPath ?? null, humanReportPath: value.HumanReportPath ?? null, ...(humanReportSha256 ? { humanReportSha256 } : {}), errors: value.Errors, coverage };
}
/** Called only through authority.ts, which owns the private key provider. */
export async function runNativeReleaseIntentChecker(checker, cwd, forbiddenRoots, context, authority) {
    validateContext(context);
    await assertReleaseIntentChecker(checker, forbiddenRoots);
    const secret = await authority();
    if (secret.length !== 32)
        throw new Error("native checker authority is invalid");
    const encoded = secret.toString("base64");
    let result;
    try {
        const pending = promisify(execFile)(checker.executable, [checker.path, ...checker.args, "--captain-context-stdin", "--project-root", cwd], { cwd, windowsHide: true, env: environment(true), maxBuffer: 10 * 1024 * 1024 });
        pending.child.stdin.on("error", () => { });
        pending.child.stdin.end(JSON.stringify({ ...context, authority_key: encoded }) + "\n");
        const output = await pending;
        result = { exitCode: 0, ...output };
    }
    catch (error) {
        result = { exitCode: Number(error.code) || 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message };
    }
    const containsAuthority = (text) => {
        let decoded;
        try {
            decoded = JSON.parse(text);
        }
        catch { /* Check escaped diagnostics as well as JSON. */ }
        return text.includes(encoded) || text.replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16))).includes(encoded)
            || (decoded !== undefined && JSON.stringify(decoded).includes(encoded));
    };
    if (containsAuthority(result.stdout) || containsAuthority(result.stderr))
        throw new Error("native checker returned private authority material");
    await assertReleaseIntentChecker(checker, forbiddenRoots);
    result.summary = await summaryOf(result, checker, context, forbiddenRoots);
    return result;
}
