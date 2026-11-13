import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

export type ReleaseIntentChecker = { path: string; sha256: string; args?: string[] };
const key = (value: string) => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
export async function assertReleaseIntentChecker(checker: ReleaseIntentChecker, forbiddenRoots: string[]): Promise<void> {
  if (!checker || !path.isAbsolute(checker.path) || !/^[A-Za-z0-9:/\\._ -]+$/.test(checker.path) ||
      !/^[0-9a-f]{64}$/.test(checker.sha256)) throw new Error("release-intent requires an absolute installed checker path and SHA-256");
  const absolute = path.resolve(checker.path), info = await lstat(absolute);
  if (!info.isFile() || info.isSymbolicLink() || key(await realpath(absolute)) !== key(absolute))
    throw new Error("release-intent checker must be a canonical regular file");
  for (const root of forbiddenRoots) {
    const relative = path.relative(path.resolve(root), absolute);
    if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative)))
      throw new Error("release-intent checker must be installed outside the repository");
  }
  if (createHash("sha256").update(await readFile(absolute)).digest("hex") !== checker.sha256)
    throw new Error("release-intent checker digest changed from trusted base");
  if (checker.args && (!Array.isArray(checker.args) || checker.args.some(arg => typeof arg !== "string" || !/^[A-Za-z0-9:/\\._ =#-]+$/.test(arg))))
    throw new Error("release-intent checker arguments must be literal bounded tokens");
}
export function releaseIntentCommand(checker: ReleaseIntentChecker): string {
  return [process.execPath, checker.path, ...(checker.args ?? [])].map(value => '"' + value + '"').join(" ");
}

export async function runReleaseIntentChecker(checker: ReleaseIntentChecker, cwd: string, forbiddenRoots: string[]) {
  await assertReleaseIntentChecker(checker, forbiddenRoots);
  const environment: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(environment)) if (/^GIT_/i.test(name) || ["CAPTAIN_SEQUENCE_AUTH_KEY", "PLUGIN_DATA", "CAPTAIN_PLUGIN_DATA", "NODE_OPTIONS", "NODE_PATH"].includes(name)) delete environment[name];
  Object.assign(environment, { GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" });
  let result: { exitCode: number; stdout: string; stderr: string };
  try {
    const output = await promisify(execFile)(process.execPath, [checker.path, ...(checker.args ?? [])], { cwd, windowsHide: true, env: environment, maxBuffer: 10 * 1024 * 1024 });
    result = { exitCode: 0, stdout: output.stdout, stderr: output.stderr };
  } catch (error: any) { result = { exitCode: Number(error.code) || 1, stdout: error.stdout ?? "", stderr: error.stderr ?? error.message }; }
  await assertReleaseIntentChecker(checker, forbiddenRoots);
  return result;
}
