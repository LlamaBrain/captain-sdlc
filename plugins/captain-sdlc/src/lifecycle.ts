import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readAuthorized, writeAuthorized } from "./authority.js";
export type Profile = "feature" | "pre-release";
export type GateResult = { exitCode: number; stdout: string; stderr: string };
export type GateRunner = (command: string, cwd: string) => Promise<GateResult>;
export type SourceState = { head: string; tree: string; status: string; manifest?: string };
export type StateProbe = (cwd: string) => Promise<SourceState>;
export type ProjectPolicy = { profile: Profile; profiles?: Profile[]; visualRequired: boolean; commands: Record<string, string>; artifactPaths?: Record<string, string>; redGate?: { expectedExitCodes: number[]; outputPattern: string } };
export type Intent = { intentId: string; sessionId: string; turnId: string; projectRoot: string; prompt: string; requestedProfile?: Profile; capability?: string; consumed?: boolean; resumeOf?: string };
export type Run = { schemaVersion: 1; runId: string; intentId: string; sessionId: string; turnId: string; objective: string; projectRoot: string; worktreePath: string; baseHead: string; profile: Profile; visualRequired: boolean; startedAt: string; phase: "tdd_red" | "implement" | "prove" | "complete"; status: "running" | "green" | "red"; policy: ProjectPolicy; committedState?: SourceState; evidence: Array<Record<string, unknown>> };
export type BeginInput = Omit<Run, "schemaVersion" | "runId" | "sessionId" | "turnId" | "startedAt" | "phase" | "status" | "committedState" | "evidence" | "profile" | "visualRequired">;
export type CommitEvidence = { head: string; tree?: string; commitCount: number; clean: boolean; subject: string; versionChanged: boolean; changelogChanged: boolean; phaseCommitsValid?: boolean };
export class LifecycleStore {
  constructor(private readonly dataRoot: string, private readonly runner: GateRunner, private readonly probe?: StateProbe) {}
  async markIntent(intent: Intent): Promise<void> { await this.save("intents", intent.intentId, intent); }
  async validateIntent(intentId: string, projectRoot: string): Promise<Intent> { const intent = await this.load<Intent>("intents", intentId); if (intent.consumed || intent.resumeOf) throw new Error("implementation intent is invalid or consumed"); if (path.resolve(intent.projectRoot) !== path.resolve(projectRoot)) throw new Error("intent project root mismatch"); return intent; }
  async begin(input: BeginInput): Promise<Run> {
    const intent = await this.load<Intent>("intents", input.intentId); if (intent.consumed) throw new Error("implementation intent already consumed");
    if (path.resolve(intent.projectRoot) !== path.resolve(input.projectRoot)) throw new Error("intent project root mismatch");
    const canonical = path.join(path.resolve(input.projectRoot), ".captain-sdlc", "worktrees") + path.sep;
    if (!path.resolve(input.worktreePath).startsWith(canonical)) throw new Error("worktree is outside the canonical repository container");
    if (!/^[0-9a-f]{40,64}$/i.test(input.baseHead)) throw new Error("base HEAD must be a full object id");
    await this.save("intents", input.intentId, { ...intent, consumed: true });
    const profile = intent.requestedProfile ?? input.policy.profile; if (!(input.policy.profiles ?? [input.policy.profile]).includes(profile)) throw new Error(`requested ${profile} sequence is not allowed by trusted policy`);
    const run: Run = { schemaVersion: 1, runId: `codex-${randomUUID()}`, sessionId: intent.sessionId, turnId: intent.turnId, startedAt: new Date().toISOString(), phase: "tdd_red", status: "running", evidence: [], ...input, profile, visualRequired: input.policy.visualRequired };
    await this.save("runs", input.intentId, run); await this.save("permits", `${intent.sessionId}-${intent.turnId}`, this.permit(run)); await this.save("active", intent.sessionId, { intentId: input.intentId }); return run;
  }
  async resume(resumeIntentId: string): Promise<Run> {
    const intent = await this.load<Intent>("intents", resumeIntentId); if (intent.consumed || !intent.resumeOf) throw new Error("resume intent is invalid or consumed");
    const active = await this.load<{ intentId: string }>("active", intent.sessionId); if (active.intentId !== intent.resumeOf) throw new Error("resume intent does not match active run");
    const run = await this.run(intent.resumeOf); if (run.status === "green") throw new Error("completed run cannot be resumed");
    await this.save("intents", resumeIntentId, { ...intent, consumed: true }); const resumed = { ...run, turnId: intent.turnId };
    await this.save("runs", resumed.intentId, resumed); await this.save("permits", `${intent.sessionId}-${intent.turnId}`, this.permit(resumed)); return resumed;
  }
  async recordRed(intentId: string, command?: string): Promise<Run> {
    const run = await this.run(intentId); this.phase(run, "tdd_red"); const configured = run.policy.commands.ticket;
    if (!configured || (command && command !== configured)) throw new Error("red test must use the trusted ticket command");
    const result = await this.runner(configured, run.worktreePath), red = run.policy.redGate;
    if (!red || !red.expectedExitCodes.includes(result.exitCode) || !new RegExp(red.outputPattern, "i").test(`${result.stdout}\n${result.stderr}`)) throw new Error("TDD red gate must be an expected failing test result, not an infrastructure failure");
    return this.update({ ...run, phase: "implement", evidence: [...run.evidence, { kind: "tdd_red", commandSha256: digest(configured), exitCode: result.exitCode, outputSha256: digest(`${result.stdout}\n${result.stderr}`) }] });
  }
  async recordCommit(intentId: string, commit: CommitEvidence): Promise<Run> {
    const run = await this.run(intentId); this.phase(run, "implement");
    if (!commit.clean || commit.commitCount < 1 || !/^[0-9a-f]{40,64}$/i.test(commit.head) || commit.head === run.baseHead) throw new Error("commit gate requires at least one clean atomic phase commit after base");
    if (!/^(feat|fix|refactor|perf|test|docs|build|ci|chore)(\([^)]+\))?!?: .+ \(v\d+\.\d+\.\d+\)$/.test(commit.subject)) throw new Error("commit must be Conventional Commit with SemVer suffix");
    if (!commit.versionChanged || !commit.changelogChanged) throw new Error("commit must update VERSION and CHANGELOG");
    if (commit.commitCount > 1 && !commit.phaseCommitsValid) throw new Error("every repair phase commit must independently satisfy Conventional Commit, SemVer, VERSION, and CHANGELOG policy");
    if (!commit.tree || !/^[0-9a-f]{40,64}$/i.test(commit.tree)) throw new Error("commit tree must be captured");
    if (!this.probe) throw new Error("source-state probe is required"); const committedState = await this.probe(run.worktreePath); if (committedState.head !== commit.head || committedState.tree !== commit.tree || committedState.status !== "") throw new Error("commit evidence no longer matches the clean probed commit");
    return this.update({ ...run, phase: "prove", committedState, evidence: [...run.evidence, { kind: "commit", ...commit }] });
  }
  async runCheck(intentId: string, scope: string): Promise<Run> {
    const run = await this.run(intentId); this.phase(run, "implement");
    const command = run.policy.commands[scope]; if (!command || !["ticket", "feature-smoke", "affected-regression"].includes(scope)) throw new Error("iteration check must be a trusted implementation scope");
    const result = await this.runner(command, run.worktreePath);
    return this.update({ ...run, evidence: [...run.evidence, { kind: "iteration", scope, commandSha256: digest(command), exitCode: result.exitCode }] });
  }
  async prove(intentId: string): Promise<Run> {
    try { return await this.proveAttempt(intentId); } catch (error) { const latest = await this.run(intentId); if (latest.phase === "prove") await this.update({ ...latest, phase: "implement", status: "red", evidence: [...latest.evidence, { kind: "proof_error", messageSha256: digest(String((error as Error).message)) }] }); throw error; }
  }
  private async proveAttempt(intentId: string): Promise<Run> {
    const run = await this.run(intentId); this.phase(run, "prove");
    if (!this.probe || !run.committedState) throw new Error("source-state probe is required"); await this.assertCommitted(run);
    const scopes = run.profile === "pre-release" ? ["build", "ticket", "feature-smoke", "affected-regression", "super-smoke", ...(run.visualRequired ? ["visual"] : [])] : ["build", "ticket", "feature-smoke", "affected-regression", ...(run.visualRequired ? ["visual"] : [])];
    for (const scope of scopes) if (!run.policy.commands[scope]) throw new Error(`${scope} proof command is required`);
    const bindings: Record<string, string> = { build: "build", "feature-smoke": "smoke", visual: "visual" }, before: Record<string, string | null> = {};
    for (const [scope, role] of Object.entries(bindings)) if (scopes.includes(scope)) { const relative = run.policy.artifactPaths?.[role]; if (!relative) throw new Error(`${role} artifact is required by trusted policy`); before[role] = await optionalHash(run.worktreePath, relative); }
    const proof = [];
    const artifacts: Record<string, unknown> = {};
    for (const scope of scopes) { const command = run.policy.commands[scope], result = await this.runner(command, run.worktreePath); proof.push({ scope, commandSha256: digest(command), exitCode: result.exitCode }); if (result.exitCode !== 0) { await this.update({ ...run, phase: "implement", status: "red", evidence: [...run.evidence, ...proof] }); throw new Error(`${scope} proof failed; run returned to implement for repair`); } await this.assertCommitted(run); const role = bindings[scope]; if (role) { const relative = run.policy.artifactPaths![role]; const absolute = await safeArtifact(run.worktreePath, relative); const after = await hashPath(absolute); if (role === "visual") await assertImage(absolute); artifacts[role] = { path: relative, sha256: after, priorSha256: before[role], producedBy: scope }; } }
    for (const [role, item] of Object.entries(artifacts) as Array<[string, any]>) { const finalHash = await hashPath(await safeArtifact(run.worktreePath, item.path)); if (finalHash !== item.sha256) throw new Error(`${role} artifact changed after its producing proof command`); }
    const completed = await this.update({ ...run, phase: "complete", status: "green", evidence: [...run.evidence, ...proof, { kind: "artifacts", artifacts }] });
    await this.save("active", run.sessionId, { intentId: "none", complete: true }); return completed;
  }
  async status(intentId: string): Promise<Run> { return this.run(intentId); }
  async permitFor(sessionId: string, turnId: string): Promise<ReturnType<LifecycleStore["permit"]> | null> { try { return await this.load("permits", `${sessionId}-${turnId}`); } catch { return null; } }
  private permit(run: Run) { return { sessionId: run.sessionId, turnId: run.turnId, worktreePath: run.worktreePath, phase: run.phase, intentId: run.intentId }; }
  private phase(run: Run, expected: Run["phase"]) { if (run.phase !== expected) throw new Error(`expected ${expected} phase, found ${run.phase}`); }
  private async run(id: string) { return this.load<Run>("runs", id); }
  private async update(run: Run) { await this.save("runs", run.intentId, run); await this.save("permits", `${run.sessionId}-${run.turnId}`, this.permit(run)); return run; }
  private async assertCommitted(run: Run) { const current = await this.probe!(run.worktreePath), expected = run.committedState!; if (current.head !== expected.head || current.tree !== expected.tree || current.status !== "" || (expected.manifest && current.manifest !== expected.manifest)) throw new Error("proof source state diverged from the clean committed tree or ignored-input manifest"); }
  private async load<T>(bucket: string, id: string): Promise<T> { return readAuthorized<T>(this.dataRoot, bucket, safeId(id)); }
  private async save(bucket: string, id: string, value: unknown) { await writeAuthorized(this.dataRoot, bucket, safeId(id), value); }
}
const safeId = (id: string) => { if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("unsafe id"); return id; };
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
async function safeArtifact(root: string, relative: string) { if (path.isAbsolute(relative)) throw new Error("artifact must be relative"); const full = path.resolve(root, relative), prefix = path.resolve(root) + path.sep; if (!full.startsWith(prefix)) throw new Error("artifact escapes worktree"); for (let cursor = full; cursor.startsWith(path.resolve(root)); cursor = path.dirname(cursor)) { const info = await lstat(cursor); if (info.isSymbolicLink()) throw new Error("artifact crosses a reparse point"); if (cursor === path.resolve(root)) break; } return full; }
async function hashPath(target: string): Promise<string> { const info = await lstat(target); if (info.isSymbolicLink()) throw new Error("artifact tree contains a reparse point"); if (info.isFile()) return createHash("sha256").update(await readFile(target)).digest("hex"); const entries = await readdir(target, { withFileTypes: true }); const lines = []; for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) { const child = path.join(target, entry.name); lines.push(`${entry.name}:${await hashPath(child)}`); } return digest(lines.join("\n")); }
async function optionalHash(root: string, relative: string) { try { return await hashPath(await safeArtifact(root, relative)); } catch (error: any) { if (error.code === "ENOENT") return null; throw error; } }
async function assertImage(target: string) { const bytes = await readFile(target); let valid = false; if (bytes.length >= 45 && bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) { const ihdr = bytes.toString("ascii",12,16) === "IHDR", width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20), iend = bytes.includes(Buffer.from("IEND")); valid = ihdr && width > 0 && height > 0 && iend; } if (!valid && bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) { for (let i=2;i+8<bytes.length;) { if (bytes[i++] !== 0xff) continue; const marker=bytes[i++], length=bytes.readUInt16BE(i); if (length<2 || i+length>bytes.length) break; if ([0xc0,0xc1,0xc2].includes(marker) && bytes.readUInt16BE(i+3)>0 && bytes.readUInt16BE(i+5)>0) { valid=true; break; } i+=length; } } if (!valid) throw new Error("visual artifact is not a structurally valid nonempty PNG or JPEG image"); }
