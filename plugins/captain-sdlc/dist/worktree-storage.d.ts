export type ParentWorktree = {
    registration_id: string;
    worktree_path: string;
    branch: string;
    git_dir: string;
    head: string;
};
export type WorktreeCreation = {
    schema_version: 1;
    intent_id: string;
    project_root: string;
    common_git_dir: string;
    worktree_path: string;
    branch: string;
    base_head: string;
    parent_worktree?: ParentWorktree;
};
export type WorktreeRegistration = WorktreeCreation & {
    git_dir: string;
};
export declare function storageRegistrationId(commonGitDir: string, worktreePath: string): string;
export declare function readWorktreeCreation(dataRoot: string, commonGitDir: string, worktreePath: string): Promise<WorktreeCreation | undefined>;
/** Publish before Git creates the checkout; adopting an existing directory never opts it in. */
export declare function reserveWorktreeCreation(dataRoot: string, input: WorktreeCreation): Promise<WorktreeCreation>;
/** Complete only a prior creation journal after Git has verified that exact checkout binding. */
export declare function completeWorktreeCreation(dataRoot: string, input: WorktreeCreation, gitDir: string): Promise<WorktreeRegistration>;
export declare function readWorktreeRegistration(dataRoot: string, commonGitDir: string, worktreePath: string): Promise<WorktreeRegistration | undefined>;
