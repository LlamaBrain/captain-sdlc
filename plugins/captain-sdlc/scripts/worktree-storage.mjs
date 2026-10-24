import { runStorageCommand } from "../dist/storage-cli.js";

try {
  const result = await runStorageCommand(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (Array.isArray(result.retained_worktrees) && result.retained_worktrees.length) process.exitCode = 2;
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
