#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const dataRoot = process.env.PLUGIN_DATA || process.env.CAPTAIN_PLUGIN_DATA;
const statePath = dataRoot ? path.join(dataRoot, "hook-control.json") : undefined;

export async function hooksEnabled(data) {
  try { return JSON.parse(await readFile(path.join(data, "hook-control.json"), "utf8")).enabled !== false; }
  catch { return true; }
}

const action = process.argv[2];
if (action) {
  if (!statePath) throw new Error("PLUGIN_DATA is required");
  if (!["on", "off", "status"].includes(action)) throw new Error("usage: hook-control.mjs <on|off|status>");
  const enabled = action === "status" ? await hooksEnabled(dataRoot) : action === "on";
  if (action !== "status") { await mkdir(dataRoot, { recursive: true }); await writeFile(statePath, JSON.stringify({ schemaVersion: 1, enabled, updatedAt: new Date().toISOString() })); }
  process.stdout.write(JSON.stringify({ enabled }) + "\n");
}
