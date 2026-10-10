import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

export type SessionOwner = { pid: number; host: string; startedAt: string; closeTokenHash?: string };
export type SessionOwnerState = "live" | "stopped" | "foreign_host" | "unknown" | "legacy";
export type SessionOwnerProbe = { state: SessionOwnerState; reason?: string };
const exec = promisify(execFile);

export function validateSessionOwner(owner: SessionOwner): void {
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
      typeof owner.host !== "string" || !owner.host.trim() ||
      typeof owner.startedAt !== "string" || !owner.startedAt.trim() ||
      (owner.closeTokenHash !== undefined && !/^[0-9a-f]{64}$/.test(owner.closeTokenHash))) {
    throw new Error("client session owner identity is invalid");
  }
}

async function processStart(pid: number): Promise<string | undefined> {
  if (process.platform === "win32") {
    // A PID is validated before interpolation; no caller text becomes shell code.
    const script = `$ErrorActionPreference='Stop'; try { $p=Get-Process -Id ${pid}; $s=$p.StartTime.ToUniversalTime().Ticks.ToString(); if(-not $s){exit 4}; [Console]::Out.Write($s) } catch { if($_.FullyQualifiedErrorId -like 'NoProcessFoundForGivenId*'){exit 3}; exit 4 }`;
    try {
      const { stdout } = await exec("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
        { windowsHide: true, timeout: 10000, encoding: "utf8" });
      if (!/^\d+$/.test(stdout.trim())) throw new Error("client process start identity unavailable");
      return `windows:${stdout.trim()}`;
    } catch (error: any) {
      if (error.code === 3) return undefined;
      throw error;
    }
  }
  if (process.platform === "linux") {
    try {
      const [stat, boot] = await Promise.all([readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8")]);
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      if (!/^\d+$/.test(fields[19] ?? "") || !boot.trim()) throw new Error("client process start identity unavailable");
      return `linux:${boot.trim()}:${fields[19]}`;
    } catch (error: any) {
      if (error.code === "ENOENT") {
        // Only absence of this exact process is positive stopped proof; absence of
        // a boot identity or inaccessible process information remains unknown.
        try { await readFile(`/proc/${pid}/stat`, "utf8"); }
        catch (probe: any) { if (probe.code === "ENOENT") return undefined; throw probe; }
      }
      throw error;
    }
  }
  throw new Error("client process identity probe is unavailable on this platform");
}

/** Capture the actual client PID supplied by its trusted adapter, never the MCP host by default. */
export async function captureClientSessionOwner(clientPid: number, closeTokenHash?: string): Promise<SessionOwner> {
  if (!Number.isSafeInteger(clientPid) || clientPid <= 0 || clientPid === process.pid) {
    throw new Error("actual client owner PID is required; the MCP host cannot own the client session");
  }
  const startedAt = await processStart(clientPid);
  if (!startedAt) throw new Error("client process is stopped; cannot bind session owner");
  const owner = { pid: clientPid, host: os.hostname(), startedAt, ...(closeTokenHash ? { closeTokenHash: closeTokenHash.toLowerCase() } : {}) };
  validateSessionOwner(owner);
  return owner;
}

export async function probeSessionOwner(owner: SessionOwner): Promise<SessionOwnerProbe> {
  try { validateSessionOwner(owner); }
  catch { return { state: "unknown", reason: "client owner identity is invalid" }; }
  if (owner.host.toLowerCase() !== os.hostname().toLowerCase()) return { state: "foreign_host", reason: "client belongs to another host" };
  try {
    const current = await processStart(owner.pid);
    if (current === undefined) return { state: "stopped", reason: "captured client PID is missing" };
    if (current !== owner.startedAt) return { state: "stopped", reason: "captured client exited; PID belongs to a different process start" };
    return { state: "live" };
  } catch { return { state: "unknown", reason: "client process identity could not be inspected" }; }
}