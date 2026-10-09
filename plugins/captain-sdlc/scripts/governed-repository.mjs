import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export async function repositoryUsesLowStrictness(cwd) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
  try {
    const result = await exec("git", ["show", "HEAD:.captain-sdlc/merge-policy.json"], { cwd, env, windowsHide: true });
    return JSON.parse(result.stdout).strictness === "low";
  } catch {
    return false;
  }
}

export async function verifyLowStrictCompletion(cwd) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
  try {
    // This is a turn-hygiene check, not task proof. A clean committed worktree
    // is valid; requiring a dirty file encourages scratch junk and blocks closure.
    await exec("git", ["diff", "--check", "HEAD"], { cwd, env, windowsHide: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error?.stderr?.trim() || "low-strict completion verification failed" };
  }
}

export async function repositoryIsGoverned(cwd) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" };
  try {
    await exec("git", ["cat-file", "-e", "HEAD:.captain-sdlc/codex-policy.json"], { cwd, env, windowsHide: true });
    return true;
  } catch (error) {
    try {
      await exec("git", ["rev-parse", "--show-toplevel"], { cwd, env, windowsHide: true });
      return false;
    } catch {
      return true;
    }
  }
}
