// OpenCode adapter for Captain SDLC.  It is deliberately global and package-owned:
// projects do not need an AGENTS.md rule to get a signed begin/resume handoff.
import { randomUUID } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { LifecycleStore } from "../dist/lifecycle.js"
import { extractCaptainResumeIntent } from "../dist/intent.js"

const dataRoot = process.env.CAPTAIN_PLUGIN_DATA || process.env.CODEX_PLUGIN_DATA || process.env.PLUGIN_DATA || path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "plugins", "data", "captain-sdlc-personal")
const mutatingTools = new Set(["apply_patch", "edit", "write", "bash", "shell"])
const actionRequest = /\b(implement|build|add|change|fix|refactor|migrate|remove|ship|integrate|upgrade|create)\b/i

const textOf = parts => parts.filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n")
const turnIdOf = (input, current) => input.messageID || current || `turn-${randomUUID()}`

export const CaptainSdlc = async ({ directory }) => {
  const store = new LifecycleStore(dataRoot, async () => ({ exitCode: 0, stdout: "", stderr: "" }))
  const turns = new Map()
  const instructions = new Map()
  return {
    "chat.message": async (input, output) => {
      const prompt = textOf(output.parts)
      const resumeOf = extractCaptainResumeIntent(prompt)
      if (!resumeOf && !actionRequest.test(prompt)) return
      const existing = (await store.doctor()).activeRuns.find(run => run.sessionId === input.sessionID)
      if (existing && !resumeOf) return
      const turnId = turnIdOf(input, turns.get(input.sessionID))
      turns.set(input.sessionID, turnId)
      const intentId = `intent-${randomUUID()}`
      await store.markIntent({ intentId, sessionId: input.sessionID, turnId, projectRoot: path.resolve(directory), prompt, ...(resumeOf ? { resumeOf } : {}) })
      instructions.set(input.sessionID, resumeOf
        ? `Captain issued resume intent ${intentId}. Call captain_resume_implementation with resume_intent_id=${intentId} before any implementation tool.`
        : `Captain issued implementation intent ${intentId}. Call captain_begin_implementation with intent_id=${intentId}, objective matching the user request, and project_root=${path.resolve(directory)} before any implementation tool.`)
    },
    "experimental.chat.system.transform": async (input, output) => {
      const instruction = input.sessionID ? instructions.get(input.sessionID) : undefined
      if (instruction) output.system.push(instruction)
    },
    "tool.execute.before": async (input) => {
      if (!mutatingTools.has(input.tool.toLowerCase())) return
      const turnId = turns.get(input.sessionID)
      if (!turnId || !(await store.permitFor(input.sessionID, turnId))) throw new Error("Captain SDLC: implementation mutation denied until this OpenCode session begins or resumes its signed Captain intent.")
    },
  }
}
