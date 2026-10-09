import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { acquireAuthorizedLease, putAuthorizedOnceExact, readAuthorized, readAuthorizedLease, readAuthorizedLeaseState, releaseAuthorizedLease } from "./authority.js";
import { LifecycleStore, type GateRunner, type ProjectPolicy, type Run } from "./lifecycle.js";
import { applyPreparedCommit, assertWorktreeBinding, commitAtomic, gateRunner, git, loadPolicy, prepareMerge, reconcilePreparedCommit, reconcilePreparedMerge, repositoryIdentity, sourceState, type PreparedCommitCore, type PreparedMerge } from "./workspace.js";

export type MergeCommitInput = { paths: string[]; subject: string; task_outcome?: "Implements" | "Completes" | "Needs-QA"; task_id?: string };
export type MergePrepArgs = { source_worktree: string; target_worktree: string; target_branch: string; session_id: string; merge_id?: string; commit?: MergeCommitInput };
export type MergeBackArgs = { merge_id: string; session_id: string; source_worktree?: string; target_worktree?: string; target_branch?: string };
export type MergeLeaseRecoveryArgs = MergeBackArgs & { source_worktree: string; target_worktree: string; target_branch: string; expected_revision: number; expected_lease_token: string; confirm_owner_stopped?: boolean };
export type MergeState = "preparing" | "needs_resolution" | "needs_commit" | "verifying" | "failed" | "ready" | "integrating" | "merged";
type Binding = Awaited<ReturnType<typeof assertWorktreeBinding>>;
type Inputs = { source: Awaited<ReturnType<typeof sourceState>>; metadata: string; dependencies: Array<Record<string, unknown>> };
type GateEvidence = { scope: string; commandSha256: string; exitCode: number; stdoutSha256: string; stderrSha256: string };
export type MergeRecord = {
  schema_version: 1; merge_id: string; revision: number; previous_sha256?: string; session_id: string; state: MergeState;
  source_worktree: string; target_worktree: string; target_branch: string; source_binding: Binding; target_binding: Binding;
  captured_policy: ProjectPolicy; policy_sha256: string; strictness: "low" | "standard" | "strict"; scopes: string[];
  prepared_merge?: PreparedMerge; prepared_commit?: PreparedCommitCore; prepared_commit_request?: MergeCommitInput; conflicts: string[]; gates: GateEvidence[];
  attempted_inputs?: Inputs; ready_inputs?: Inputs; failure?: string; integrated_head?: string;
};
export type MergeStatus = MergeRecord & { receipt_valid?: boolean; stale_reason?: string; captain_green: false };

const hash = (text: string | Buffer) => createHash("sha256").update(text).digest("hex");
const digest = (value: unknown) => hash(JSON.stringify(value));
const samePath = (left: string, right: string) => process.platform === "win32" ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
const safeId = (id: string) => { if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("unsafe merge id"); return id; };
const relativePath = (value: string) => { if (!value || value.includes("\0") || path.isAbsolute(value) || /(^|[\\/])\.\.([\\/]|$)/.test(value)) throw new Error("dependency input must use a safe repository-relative path"); return value.replaceAll("\\", "/"); };
const resourceId = (common: string, branch: string) => hash(`${path.resolve(common)}\0refs/heads/${branch}`.toLowerCase());

/** Independent integration ledger. Implementation run phases and proof are never rewritten. */
export class MergeWorkflowStore {
  private readonly activeOperations = new Set<string>();
  constructor(private readonly dataRoot: string, private readonly runner: GateRunner = gateRunner) {}

  async prep(args: MergePrepArgs): Promise<MergeStatus> {
    this.session(args.session_id); const mergeId = safeId(args.merge_id ?? `merge-${randomUUID()}`);
    return this.lock(mergeId, args.session_id, async assertOperation => {
      let record: MergeRecord;
      if (args.merge_id) { record = await this.read(mergeId); this.match(record, args); }
      else {
        const sourceRoot = path.resolve(args.source_worktree), targetRoot = path.resolve(args.target_worktree);
        if (samePath(sourceRoot, targetRoot)) throw new Error("Merge Prep needs distinct source and target worktrees");
        const source = await assertWorktreeBinding(sourceRoot, undefined, undefined, undefined, true), target = await assertWorktreeBinding(targetRoot, args.target_branch, source.commonGitDir, undefined, true);
        if (source.branch === target.branch) throw new Error("source and target branches must differ");
        await assertNoOperation(sourceRoot); await assertNoOperation(targetRoot); await repositoryIdentity(sourceRoot); await repositoryIdentity(targetRoot);
        const policy = await loadPolicy(sourceRoot, source.head), mergePolicyText = await committedFile(sourceRoot, source.head, ".captain-sdlc/merge-policy.json"), mergePolicy = JSON.parse(mergePolicyText ?? '{"schema_version":1,"strictness":"low"}');
        if (mergePolicy.schema_version !== 1 || !["low", "standard", "strict"].includes(mergePolicy.strictness)) throw new Error("trusted merge policy must configure schema_version 1 and low, standard, or strict");
        const scopes = mergePolicy.strictness === "low" ? ["build"] : ["build", "ticket", "feature-smoke", "affected-regression", ...(mergePolicy.strictness === "strict" ? ["super-smoke"] : [])];
        for (const scope of scopes) if (!policy.commands[scope]) throw new Error(`trusted merge policy is missing ${scope} command`);
        record = await this.initial({ schema_version: 1, merge_id: mergeId, revision: 0, session_id: args.session_id, state: "preparing", source_worktree: sourceRoot, target_worktree: targetRoot, target_branch: args.target_branch, source_binding: source, target_binding: target, captured_policy: policy, policy_sha256: digest({ policy, mergePolicyText }), strictness: mergePolicy.strictness, scopes, conflicts: [], gates: [] });
      }
      if (record.state === "merged") return this.output(record);
      return this.resources(record, async assertResources => {
        const assertAuthority = async () => { await assertOperation(); await assertResources(); };
        await this.bindings(record, false); await assertNoOperation(record.target_worktree);
        let recoveredCommit = false;
        if (record.prepared_commit) {
          if (args.commit && digest(args.commit) !== digest(record.prepared_commit_request)) throw new Error("prepared integration commit recovery must use the same signed commit request");
          const currentHead = await git(["rev-parse", "HEAD"], record.source_worktree);
          if (currentHead === record.prepared_commit.candidate) {
            await assertAuthority(); await reconcilePreparedCommit(record.source_worktree, record.prepared_commit, record.source_binding.branch, record.source_binding.commonGitDir, record.source_binding.gitDir);
          } else if (currentHead === record.prepared_commit.preCommitHead) {
            const prepared = record.prepared_commit;
            await applyPreparedCommit(record.source_worktree, prepared, record.source_binding.branch, record.source_binding.commonGitDir, record.source_binding.gitDir, async candidate => { await assertAuthority(); await this.bindings(record, false); if (digest((await this.read(record.merge_id)).prepared_commit) !== digest(candidate)) throw new Error("signed integration commit recovery authority changed"); });
          } else throw new Error("prepared commit recovery found diverged source HEAD");
          record = await this.update({ ...record, prepared_commit: undefined, prepared_commit_request: undefined, prepared_merge: undefined, state: "preparing", conflicts: [] });
          recoveredCommit = true;
        }
        if (record.prepared_merge && !await optionalGit(["rev-parse", "--verify", "MERGE_HEAD"], record.source_worktree)) {
          await assertAuthority(); await reconcilePreparedMerge(record.source_worktree, record.prepared_merge);
          record = await this.update({ ...record, prepared_merge: undefined, state: "preparing" });
        }
        if (record.prepared_merge) {
          const mergeHead = await optionalGit(["rev-parse", "--verify", "MERGE_HEAD"], record.source_worktree), head = await git(["rev-parse", "HEAD"], record.source_worktree);
          if (mergeHead !== record.prepared_merge.targetOid || head !== record.prepared_merge.preMergeHead) throw new Error("source no longer matches the signed pending merge; recover that operation before another prep");
          await assertNoOperation(record.source_worktree, true);
          if (args.commit) {
            const pending = record.prepared_merge;
            await assertAuthority();
            await commitAtomic(record.source_worktree, args.commit.paths, args.commit.subject, args.commit.task_outcome, args.commit.task_id, record.captured_policy.commit, [pending], record.source_binding.branch, record.source_binding.commonGitDir, pending.preMergeHead, record.source_binding.gitDir,
              async prepared => { record = await this.update({ ...record, prepared_commit: prepared, prepared_commit_request: args.commit }); },
              async () => { record = await this.update({ ...record, prepared_commit: undefined, prepared_commit_request: undefined }); }, undefined,
              async prepared => { await assertAuthority(); const latest = await this.read(record.merge_id); if (digest(latest.prepared_commit) !== digest(prepared)) throw new Error("signed integration commit authority changed"); await this.bindings(record, false); });
            record = await this.update({ ...record, prepared_commit: undefined, prepared_commit_request: undefined, prepared_merge: undefined, state: "preparing", conflicts: [] });
          } else {
            const conflicts = lines(await git(["diff", "--name-only", "--diff-filter=U"], record.source_worktree));
            record = await this.update({ ...record, state: conflicts.length ? "needs_resolution" : "needs_commit", conflicts });
            return this.output(record);
          }
        } else if (args.commit && !recoveredCommit) throw new Error("Merge Prep commit metadata is only valid for its signed pending target merge");
        await assertNoOperation(record.source_worktree); await assertWorktreeBinding(record.source_worktree, record.source_binding.branch, record.source_binding.commonGitDir, undefined, true, record.source_binding.gitDir);
        if (!await ancestor(record.target_binding.head, await git(["rev-parse", "HEAD"], record.source_worktree), record.source_worktree)) {
          const currentHead = await git(["rev-parse", "HEAD"], record.source_worktree);
          const result = await prepareMerge(record.source_worktree, record.target_binding.head, "ort",
            async prepared => { record = await this.update({ ...record, state: "preparing", prepared_merge: prepared, ready_inputs: undefined, gates: [] }); },
            async () => { record = await this.update({ ...record, prepared_merge: undefined, state: "failed", failure: "target merge preparation was rejected" }); },
            record.source_binding.branch, record.source_binding.commonGitDir, currentHead, record.source_binding.gitDir, undefined, mergeId,
            async prepared => { await assertAuthority(); await this.bindings(record, false); const latest = await this.read(mergeId); if (digest(latest.prepared_merge) !== digest(prepared)) throw new Error("signed target merge authority changed"); });
          record = await this.update({ ...record, state: result.status === "conflicts" ? "needs_resolution" : "needs_commit", conflicts: result.conflicts });
          return this.output(record);
        }
        const inputs = await captureInputs(record.source_worktree, record.captured_policy);
        if (record.state === "ready" && digest(inputs) === digest(record.ready_inputs)) { await this.assertReady(record); return this.output(record, true); }
        if (record.state === "failed" && digest(inputs) === digest(record.attempted_inputs)) throw new Error("failed prep inputs are unchanged; repair a relevant source or dependency input before retrying");
        record = await this.update({ ...record, state: "verifying", ready_inputs: undefined, attempted_inputs: inputs, gates: [], failure: undefined });
        try {
          await git(["diff", "--check", record.target_binding.head, inputs.source.head], record.source_worktree);
          for (const scope of record.scopes) {
            await assertAuthority(); await this.bindings(record, false); await this.assertInputs(record, inputs);
            const command = record.captured_policy.commands[scope], result = await this.runner(command, record.source_worktree);
            record = await this.update({ ...record, gates: [...record.gates, { scope, commandSha256: hash(command), exitCode: result.exitCode, stdoutSha256: hash(result.stdout), stderrSha256: hash(result.stderr) }] });
            if (result.exitCode !== 0) throw new Error(`${scope} merge prep gate failed (exit ${result.exitCode})`);
            await assertAuthority(); await this.bindings(record, false); await this.assertInputs(record, inputs);
          }
          record = await this.update({ ...record, state: "ready", ready_inputs: inputs });
          return this.output(record, true);
        } catch (error) {
          record = await this.update({ ...record, state: "failed", ready_inputs: undefined, failure: (error as Error).message });
          return this.output(record, false);
        }
      });
    });
  }

  async back(args: MergeBackArgs): Promise<MergeStatus> {
    this.session(args.session_id); safeId(args.merge_id);
    return this.lock(args.merge_id, args.session_id, async assertOperation => {
      let record = await this.read(args.merge_id); this.match(record, args);
      if (!["ready", "integrating", "merged"].includes(record.state) || !record.ready_inputs) throw new Error("Merge Back requires a successful current ready Merge Prep");
      return this.resources(record, async assertResources => {
        await assertOperation(); await assertResources();
        const targetHead = await git(["rev-parse", "HEAD"], record.target_worktree), sourceHead = record.ready_inputs!.source.head;
        await this.assertReady(record, targetHead === sourceHead);
        if (record.state === "merged") { if (targetHead !== sourceHead) throw new Error("completed Merge Back target HEAD changed"); return this.output(record, true); }
        if (targetHead === sourceHead) { record = await this.update({ ...record, state: "merged", integrated_head: sourceHead }); return this.output(record, true); }
        record = await this.update({ ...record, state: "integrating" });
        await assertOperation(); await assertResources(); await this.assertReady(record);
        // git() isolates hooks, external configuration, filters and ambient Git redirection.
        await git(["merge", "--ff-only", sourceHead], record.target_worktree);
        await this.assertReady(record, true);
        record = await this.update({ ...record, state: "merged", integrated_head: sourceHead });
        return this.output(record, true);
      });
    });
  }

  async status(args: MergeBackArgs): Promise<MergeStatus> {
    this.session(args.session_id); const record = await this.read(safeId(args.merge_id)); this.match(record, args);
    if (["ready", "integrating", "merged"].includes(record.state)) {
      try { await this.assertReady(record, await git(["rev-parse", "HEAD"], record.target_worktree) === record.ready_inputs?.source.head); return this.output(record, true); }
      catch (error) { return { ...this.output(record, false), stale_reason: (error as Error).message }; }
    }
    return this.output(record, false);
  }

  async recoverStaleLease(args: MergeLeaseRecoveryArgs) {
    this.session(args.session_id); safeId(args.merge_id);
    const leaseId = hash(`merge-operation\0${args.merge_id}`);
    if (this.activeOperations.has(leaseId)) throw new Error("merge operation is active in this process and cannot be recovered");
    const record = await this.read(args.merge_id); this.match(record, args);
    if (record.revision !== args.expected_revision) throw new Error("signed merge revision changed; refresh status before recovery");
    const operation = await readAuthorizedLeaseState<Record<string, any> & { intentId: string; leaseToken: string }>(this.dataRoot, leaseId);
    if (!operation) throw new Error("signed merge operation lease history was not found");
    const lease = operation.payload;
    this.assertMergeLease(lease, args.merge_id, args.session_id, "integration");
    if (lease.leaseToken !== args.expected_lease_token) throw new Error("merge lease generation owner or token mismatch");
    if (operation.state === "held") {
      if (this.activeOperations.has(leaseId)) throw new Error("merge operation is active in this process and cannot be recovered");
    }
    this.assertLeaseOwnerStopped(lease, args.confirm_owner_stopped);

    const resources: Array<{ id: string; payload: Record<string, any> & { intentId: string; leaseToken: string } }> = [];
    const lifecycle = new LifecycleStore(this.dataRoot, this.runner), active = (await lifecycle.doctor()).activeRuns;
    if (active.some(owner => samePath(owner.worktreePath, record.target_worktree))) throw new Error("target worktree has an unfinished Captain owner; stale merge resources cannot be recovered");
    const sourceOwners = active.filter(owner => samePath(owner.worktreePath, record.source_worktree));
    if (sourceOwners.length > 1 || sourceOwners.some(owner => owner.sessionId !== record.session_id || owner.branch !== record.source_binding.branch)) throw new Error("source Captain owner differs from the signed merge identity");
    for (const owner of sourceOwners) {
      const current = await lifecycle.status(owner.intentId);
      if (current.status !== "paused" || current.branch !== record.source_binding.branch || !samePath(current.commonGitDir, record.source_binding.commonGitDir) || !samePath(current.gitDir, record.source_binding.gitDir)) throw new Error("source Captain owner must be paused and match the signed merge binding before stale integration resources can be recovered");
      const id = hash(`worktree-mutation\0${current.runId}`), fence = await this.readHeldLease(id);
      if (fence) {
        this.assertMergeLease(fence, args.merge_id, args.session_id, "integration-worktree");
        this.assertLeaseOwnerStopped(fence, args.confirm_owner_stopped);
        resources.push({ id, payload: fence });
      }
    }
    for (const binding of [record.source_binding, record.target_binding]) {
      const id = resourceId(binding.commonGitDir, binding.branch), existing = await this.readHeldLease(id);
      if (!existing) continue;
      if (existing.intentId === args.merge_id) {
        this.assertMergeLease(existing, args.merge_id, args.session_id, "integration-branch");
        if (!samePath(existing.commonGitDir, binding.commonGitDir) || existing.targetBranch !== binding.branch || existing.targetOid !== binding.head) throw new Error("stale integration branch lease differs from the pinned merge binding");
        this.assertLeaseOwnerStopped(existing, args.confirm_owner_stopped);
        resources.push({ id, payload: existing });
      } else {
        const owner = sourceOwners.find(candidate => candidate.intentId === existing.intentId);
        if (binding !== record.source_binding || !owner) throw new Error("a branch lease is owned by another Captain operation; preserve it");
        const fullOwner = await lifecycle.status(owner.intentId);
        if (fullOwner.sessionId !== args.session_id || !samePath(fullOwner.worktreePath, record.source_worktree) || fullOwner.branch !== binding.branch || fullOwner.leaseId !== id || fullOwner.leaseToken !== existing.leaseToken) throw new Error("a branch lease is owned by another Captain operation; preserve it");
      }
    }
    const latest = await this.read(args.merge_id); this.match(latest, args);
    if (latest.revision !== args.expected_revision) throw new Error("signed merge revision changed during recovery; refresh status");
    for (const resource of resources) await releaseAuthorizedLease(this.dataRoot, resource.id, args.merge_id, resource.payload.leaseToken);
    if (operation.state === "held") await releaseAuthorizedLease(this.dataRoot, leaseId, args.merge_id, args.expected_lease_token);
    return { merge_id: args.merge_id, released: true, released_resource_leases: resources.length, merge_revision: args.expected_revision, resumed_operation: "reuse captain_merge_prep or captain_merge_back with the same merge_id" };
  }

  private assertMergeLease(lease: Record<string, any>, id: string, session: string, operation: string) {
    if (lease.intentId !== id || lease.sessionId !== session || lease.operation !== operation || typeof lease.leaseToken !== "string") throw new Error("merge lease generation owner or operation mismatch");
  }
  private assertLeaseOwnerStopped(lease: Record<string, any>, confirmed?: boolean) {
    if (lease.ownerPid !== undefined) {
      if (!Number.isSafeInteger(lease.ownerPid) || typeof lease.ownerHost !== "string") throw new Error("merge lease owner process metadata is invalid");
      if (lease.ownerHost.toLowerCase() !== os.hostname().toLowerCase()) throw new Error("merge lease owner is on another host and cannot be verified locally");
      let ownerActive = true;
      try { process.kill(lease.ownerPid as number, 0); }
      catch (error: any) { if (error.code === "ESRCH") ownerActive = false; else throw new Error("merge lease owner process state is unknown; recovery refused", { cause: error }); }
      if (ownerActive) throw new Error("merge lease owner process is still active");
    } else if (confirmed !== true) throw new Error("legacy merge lease has no process metadata; confirm that its owner is stopped");
  }
  private async readHeldLease(id: string): Promise<(Record<string, any> & { intentId: string; leaseToken: string }) | undefined> {
    try { return await readAuthorizedLease(this.dataRoot, id); }
    catch (error: any) { if (error.code === "ENOENT") return undefined; throw error; }
  }

  private session(value: string) { if (!value?.trim()) throw new Error("integration session_id is required"); }
  private match(record: MergeRecord, args: MergeBackArgs | MergePrepArgs) {
    if (record.session_id !== args.session_id) throw new Error("signed merge session ownership mismatch");
    if ((args.source_worktree && !samePath(record.source_worktree, args.source_worktree)) || (args.target_worktree && !samePath(record.target_worktree, args.target_worktree)) || (args.target_branch && record.target_branch !== args.target_branch)) throw new Error("signed merge source/target identity does not match this request");
  }
  private output(record: MergeRecord, receipt_valid?: boolean): MergeStatus { return { ...record, ...(receipt_valid === undefined ? {} : { receipt_valid }), captain_green: false }; }
  private async bindings(record: MergeRecord, targetIntegrated: boolean) {
    await assertWorktreeBinding(record.source_worktree, record.source_binding.branch, record.source_binding.commonGitDir, undefined, false, record.source_binding.gitDir);
    await assertWorktreeBinding(record.target_worktree, record.target_branch, record.target_binding.commonGitDir, targetIntegrated ? record.ready_inputs?.source.head : record.target_binding.head, true, record.target_binding.gitDir);
  }
  private async assertInputs(record: MergeRecord, expected: Inputs) { if (digest(await captureInputs(record.source_worktree, record.captured_policy)) !== digest(expected)) throw new Error("merge prep source or dependency inputs changed; readiness is stale"); }
  private async assertReady(record: MergeRecord, targetIntegrated = false) {
    if (!record.ready_inputs || record.gates.length !== record.scopes.length || record.gates.some((gate, index) => gate.exitCode !== 0 || gate.scope !== record.scopes[index] || gate.commandSha256 !== hash(record.captured_policy.commands[gate.scope]))) throw new Error("signed Merge Prep has no complete ready gate receipt");
    await this.bindings(record, targetIntegrated); await assertNoOperation(record.source_worktree); await assertNoOperation(record.target_worktree); await this.assertInputs(record, record.ready_inputs);
    if (!await ancestor(record.target_binding.head, record.ready_inputs.source.head, record.source_worktree)) throw new Error("prepared source no longer contains the pinned target");
  }
  private async lock<T>(id: string, session: string, action: (assert: () => Promise<void>) => Promise<T>): Promise<T> {
    const leaseId = hash(`merge-operation\0${id}`), leaseToken = randomUUID(), payload = { intentId: id, leaseToken, sessionId: session, operation: "integration", ownerPid: process.pid, ownerHost: os.hostname() };
    if (this.activeOperations.has(leaseId)) throw new Error("merge operation is already active in this process");
    this.activeOperations.add(leaseId);
    try {
      await acquireAuthorizedLease(this.dataRoot, leaseId, payload);
      try { return await action(async () => { if (digest(await readAuthorizedLease(this.dataRoot, leaseId)) !== digest(payload)) throw new Error("integration operation lease ownership changed"); }); }
      finally { await releaseAuthorizedLease(this.dataRoot, leaseId, id, leaseToken); }
    } finally { this.activeOperations.delete(leaseId); }
  }
  private async resources<T>(record: MergeRecord, action: (assert: () => Promise<void>) => Promise<T>): Promise<T> {
    const held: Array<{ id: string; payload: Record<string, unknown> & { intentId: string; leaseToken: string }; borrowed: boolean }> = [];
    try {
      const lifecycle = new LifecycleStore(this.dataRoot, this.runner), active = (await lifecycle.doctor()).activeRuns;
      if (active.some(owner => samePath(owner.worktreePath, record.target_worktree))) throw new Error("target worktree has an unfinished Captain owner; preserve that task before integrating");
      const sourceOwners = active.filter(owner => samePath(owner.worktreePath, record.source_worktree));
      if (sourceOwners.length > 1 || sourceOwners.some(owner => owner.sessionId !== record.session_id)) throw new Error("source worktree belongs to another active Captain session owner");
      const reserveFence = async (owner: Run) => {
        if (owner.sessionId !== record.session_id) throw new Error("source Captain session ownership changed before its mutation fence");
        if (owner.branch !== record.source_binding.branch || !samePath(owner.commonGitDir, record.source_binding.commonGitDir) || !samePath(owner.gitDir, record.source_binding.gitDir)) throw new Error("source Captain owner Git binding diverged");
        const fenceId = hash(`worktree-mutation\0${owner.runId}`); if (held.some(lease => lease.id === fenceId)) return;
        const fence = { intentId: record.merge_id, leaseToken: randomUUID(), sessionId: record.session_id, operation: "integration-worktree", ownerPid: process.pid, ownerHost: os.hostname() };
        await acquireAuthorizedLease(this.dataRoot, fenceId, fence); held.push({ id: fenceId, payload: fence, borrowed: false });
      };
      for (const owner of sourceOwners) await reserveFence(await lifecycle.status(owner.intentId));
      for (const binding of [record.source_binding, record.target_binding].sort((a, b) => resourceId(a.commonGitDir, a.branch).localeCompare(resourceId(b.commonGitDir, b.branch)))) {
        const id = resourceId(binding.commonGitDir, binding.branch), payload = { intentId: record.merge_id, leaseToken: randomUUID(), sessionId: record.session_id, operation: "integration-branch", commonGitDir: binding.commonGitDir, targetBranch: binding.branch, targetOid: binding.head, ownerPid: process.pid, ownerHost: os.hostname() };
        let existing: any; try { existing = await readAuthorizedLease(this.dataRoot, id); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
        if (existing) {
          if (binding.branch !== record.source_binding.branch) throw new Error("target branch is already leased by another Captain operation");
          const owner = await lifecycle.status(existing.intentId);
          if (owner.sessionId !== record.session_id || !samePath(owner.worktreePath, record.source_worktree) || owner.branch !== binding.branch || owner.leaseId !== id || owner.leaseToken !== existing.leaseToken) throw new Error("source branch lease belongs to another session or worktree owner");
          held.push({ id, payload: existing, borrowed: true });
          await reserveFence(owner);
        } else { await acquireAuthorizedLease(this.dataRoot, id, payload); held.push({ id, payload, borrowed: false }); }
      }
      return await action(async () => { for (const lease of held) if (digest(await readAuthorizedLease(this.dataRoot, lease.id)) !== digest(lease.payload)) throw new Error("source or target branch lease ownership changed before integration mutation"); });
    } finally { for (const lease of held.reverse()) if (!lease.borrowed) await releaseAuthorizedLease(this.dataRoot, lease.id, lease.payload.intentId, lease.payload.leaseToken); }
  }
  private async initial(record: MergeRecord) { const stored = await putAuthorizedOnceExact(this.dataRoot, "merge-revisions", `${record.merge_id}-0`, record); await this.watermark(stored); return stored; }
  private async update(record: MergeRecord) {
    const current = await this.read(record.merge_id); if (current.revision !== record.revision) throw new Error("signed merge workflow changed concurrently");
    const next = JSON.parse(JSON.stringify({ ...record, revision: current.revision + 1, previous_sha256: digest(current) })) as MergeRecord;
    const stored = await putAuthorizedOnceExact(this.dataRoot, "merge-revisions", `${record.merge_id}-${next.revision}`, next); await this.watermark(stored); return stored;
  }
  private async watermark(record: MergeRecord) { await putAuthorizedOnceExact(this.dataRoot, "merge-watermarks", `${record.merge_id}-${record.revision}`, { merge_id: record.merge_id, revision: record.revision, sha256: digest(record) }); }
  private async read(id: string): Promise<MergeRecord> {
    safeId(id); const expression = new RegExp(`^${id}-([0-9]+)\\.json$`), names = await readdir(path.join(this.dataRoot, "merge-revisions")), revisions = names.map(name => expression.exec(name)).filter(Boolean).map(match => Number(match![1])).sort((a, b) => a - b);
    if (!revisions.length) throw new Error("signed merge workflow was not found");
    let previous: MergeRecord | undefined;
    for (let index = 0; index < revisions.length; index++) {
      if (revisions[index] !== index) throw new Error("signed merge revision chain is not contiguous");
      const current = await readAuthorized<MergeRecord>(this.dataRoot, "merge-revisions", `${id}-${index}`);
      if (current.schema_version !== 1 || current.merge_id !== id || current.revision !== index || (previous ? current.previous_sha256 !== digest(previous) : current.previous_sha256 !== undefined)) throw new Error("signed merge revision binding is invalid");
      if (previous && digest([current.session_id, current.source_worktree, current.target_worktree, current.target_branch, current.source_binding, current.target_binding, current.policy_sha256, current.captured_policy, current.strictness, current.scopes]) !== digest([previous.session_id, previous.source_worktree, previous.target_worktree, previous.target_branch, previous.source_binding, previous.target_binding, previous.policy_sha256, previous.captured_policy, previous.strictness, previous.scopes])) throw new Error("signed merge identity or policy changed between revisions");
      await this.watermark(current); previous = current;
    }
    const watermarkNames = await readdir(path.join(this.dataRoot, "merge-watermarks")); if (watermarkNames.some(name => { const match = expression.exec(name); return match && Number(match[1]) > previous!.revision; })) throw new Error("signed merge revision tail regressed behind its monotonic watermark");
    return previous!;
  }
}

const lines = (value: string) => value.split(/\r?\n/).filter(Boolean);
async function optionalGit(args: string[], cwd: string): Promise<string | undefined> { try { return await git(args, cwd); } catch { return undefined; } }
async function ancestor(before: string, after: string, cwd: string) { try { await git(["merge-base", "--is-ancestor", before, after], cwd); return true; } catch (error: any) { if (error.code === 1) return false; throw error; } }
async function assertNoOperation(cwd: string, allowMerge = false) {
  for (const name of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "REBASE_HEAD", "BISECT_START", "rebase-merge", "rebase-apply", "sequencer"]) {
    if (name === "MERGE_HEAD" && allowMerge) continue;
    const file = await git(["rev-parse", "--path-format=absolute", "--git-path", name], cwd);
    try { await lstat(file); throw new Error(`preexisting Git operation ${name} must be resolved by its owner`); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  }
}
async function committedFile(cwd: string, head: string, relative: string): Promise<string | undefined> {
  const listing = await git(["ls-tree", head, "--", relative], cwd); if (!listing) return undefined;
  if (!/^100(?:644|755) blob /.test(listing)) throw new Error(`trusted merge input must be a regular tracked file: ${relative}`);
  const text = await git(["show", `${head}:${relative}`], cwd); if (Buffer.byteLength(text) > 1024 * 1024) throw new Error("trusted merge input exceeds bounded limit"); return text;
}
function excluded(relative: string, policy: ProjectPolicy) {
  const lower = relative.toLowerCase();
  return (policy.sourceManifestExcludes ?? []).some(item => lower === item.toLowerCase() || lower.startsWith(`${item.toLowerCase()}/`)) || (!relative.includes("/") && (policy.sourceManifestRootFileExcludes ?? []).some(item => item.startsWith("*.") ? lower.endsWith(item.slice(1).toLowerCase()) : lower === item.toLowerCase()));
}
async function metadataInputs(cwd: string, policy: ProjectPolicy, volatilePaths: Set<string>) {
  const files = (await git(["ls-files", "--others", "-z"], cwd)).split("\0").filter(relative => relative.toLowerCase().endsWith(".meta") && !excluded(relative, policy) && !volatilePaths.has(relative.toLowerCase())).sort(), values: string[] = [];
  for (const relative of files) { const info = await lstat(path.join(cwd, relative)); if (info.isSymbolicLink() || !info.isFile()) throw new Error(`dependency metadata must be a regular file: ${relative}`); values.push(`${relative}:${hash(await readFile(path.join(cwd, relative)))}`); }
  return digest(values);
}
async function contentDigest(root: string, volatile: string[] = [], sharedPackage = false): Promise<{ sha256: string; file_count: number }> {
  const values: string[] = []; const generated = new Set(["library", "temp", "logs", "artifacts", "obj", "bin", "node_modules"]);
  async function walk(full: string, relative: string) {
    const info = await lstat(full); if (info.isSymbolicLink()) throw new Error(`dependency input crosses a reparse point: ${full}`);
    if (volatile.includes(relative)) return;
    if (info.isDirectory()) { for (const entry of (await readdir(full, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { if (entry.name === ".git" || (sharedPackage && !relative && generated.has(entry.name.toLowerCase()))) continue; await walk(path.join(full, entry.name), relative ? `${relative}/${entry.name}` : entry.name); } }
    else if (info.isFile()) values.push(`${relative}:${hash(await readFile(full))}`); else throw new Error(`dependency input is not a regular file or directory: ${full}`);
  }
  await walk(root, ""); return { sha256: digest(values), file_count: values.length };
}
async function captureInputs(cwd: string, policy: ProjectPolicy): Promise<Inputs> {
  const source = await sourceState(cwd, policy); if (source.status) throw new Error("merge prep source must be clean before verifying inputs");
  const dependencies: Array<Record<string, unknown>> = [], volatilePaths = new Set<string>(), lockText = await committedFile(cwd, source.head, ".captain-sdlc/dependency-lock.json"), lock = lockText ? JSON.parse(lockText) : undefined;
  if (lock?.inputs !== undefined && !Array.isArray(lock.inputs)) throw new Error("dependency lock inputs must be an array");
  for (const input of lock?.inputs ?? []) {
    const relative = relativePath(input.path), full = path.resolve(cwd, relative), volatile = (input.volatile_paths ?? []).map((item: string) => relativePath(item));
    for (const item of volatile) volatilePaths.add(`${relative}/${item}`.toLowerCase());
    if (!samePath(full, path.join(cwd, relative)) || path.relative(cwd, full).startsWith("..")) throw new Error("locked dependency escapes source worktree");
    if (!samePath(full, await realpath(full))) throw new Error(`locked dependency crosses a reparse point: ${relative}`);
    dependencies.push({ kind: "locked-input", path: relative, ...await contentDigest(full, volatile) });
  }
  const manifestText = await committedFile(cwd, source.head, "Packages/manifest.json");
  if (manifestText) {
    const manifest = JSON.parse(manifestText);
    for (const [name, spec] of Object.entries(manifest.dependencies ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (typeof spec !== "string" || !spec.startsWith("file:")) continue;
      const supplied = spec.slice(5); if (!supplied || supplied.includes("\0")) throw new Error(`local dependency path is invalid: ${name}`);
      const full = path.resolve(path.join(cwd, "Packages"), supplied), canonical = await realpath(full); if (!samePath(full, canonical)) throw new Error(`local dependency path crosses a reparse point: ${name}`);
      const info = await lstat(full); let gitState: Record<string, unknown> | undefined;
      const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
      const expected = (lock?.local_packages ?? []).find((entry: any) => normalize(name).endsWith(normalize(entry.name)));
      let ownGit = false;
      if (info.isDirectory()) { try { await lstat(path.join(full, ".git")); ownGit = true; } catch (error: any) { if (error.code !== "ENOENT") throw error; } }
      if (ownGit) {
        if (!samePath(await git(["rev-parse", "--show-toplevel"], full), full)) throw new Error(`local package Git identity diverged: ${name}`);
        const head = await git(["rev-parse", "HEAD"], full);
        gitState = { head, tree: await git(["rev-parse", "HEAD^{tree}"], full), status: await git(["status", "--porcelain"], full), indexSha256: hash(await git(["ls-files", "--stage", "-z"], full)) };
        if (expected && expected.source_commit !== head) throw new Error(`Pinned shared local-package revision diverged: ${name}`);
      } else if (expected) throw new Error(`cannot verify pinned local-package revision without its Git identity: ${name}`);
      dependencies.push({ kind: info.isDirectory() ? "local-package" : "local-archive", name, path: full, ...(gitState ? { git: gitState } : {}), ...await contentDigest(full, [], info.isDirectory()) });
    }
  }
  const result = { source, metadata: await metadataInputs(cwd, policy, volatilePaths), dependencies };
  const after = await sourceState(cwd, policy); if (digest(after) !== digest(source)) throw new Error("source changed during merge input capture");
  return result;
}
