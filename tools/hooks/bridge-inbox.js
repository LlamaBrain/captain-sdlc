#!/usr/bin/env node
// bridge-inbox.js — Stop hook: deliver Captain Bridge steer notes to a live session.
//
// Captain Bridge (or any tool the human drives) writes guidance to
// .captain-sdlc/bridge-inbox.md in the project. When the session next ends a
// turn, this hook consumes the note, archives it to bridge-inbox-delivered.md
// (auditable, single-shot), and blocks the stop with the note as the
// continuation instruction — steering lands at the next phase boundary.
//
// Never breaks the session: any error exits 0 silently.

const fs = require("fs");
const path = require("path");

let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input || "{}");
    const cwd = data.cwd || process.cwd();
    const inbox = path.join(cwd, ".captain-sdlc", "bridge-inbox.md");
    if (!fs.existsSync(inbox)) return process.exit(0);
    const text = fs.readFileSync(inbox, "utf8").trim();
    if (!text) return process.exit(0);

    const delivered = path.join(cwd, ".captain-sdlc", "bridge-inbox-delivered.md");
    fs.appendFileSync(delivered, `\n--- delivered ${new Date().toISOString()} ---\n${text}\n`);
    fs.unlinkSync(inbox);

    console.log(
      JSON.stringify({
        decision: "block",
        reason:
          `STEER FROM CAPTAIN BRIDGE (human guidance, treat as user input): ${text}\n` +
          `Incorporate this guidance now and continue the task; if it asks you to stop or change course, do that instead.`,
      }),
    );
  } catch {
    // never break the session
  }
  process.exit(0);
});
