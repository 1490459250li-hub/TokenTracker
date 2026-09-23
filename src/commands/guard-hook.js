"use strict";

// guard-hook.js — the handler Claude Code invokes on PreToolUse / Stop /
// SessionStart. It reads the hook JSON on stdin, asks guard-core for a verdict,
// and prints the hook's JSON decision. This runs on the hot path of every tool
// call, so it must be fast, offline, and NEVER crash the editor: any failure
// falls through to a non-blocking allow.
//
// evaluateHook() is the pure decision (given a payload + home); cmdGuardHook()
// is only the stdin/stdout wrapper, kept separate so the logic is testable
// without spawning the CLI.

const os = require("node:os");

const { analyzeTranscriptSync, decideGuard, checkpointVerdict } = require("../lib/guard-core");
const {
  readConfig,
  readSessionState,
  writeSessionState,
  grantIsValid,
  consumeAllowOnce,
} = require("../lib/guard-manager");

const NUDGE_TTL_MS = 12 * 3_600_000;

// Returns the exact object Claude Code should receive on stdout.
async function evaluateHook(payload, home = process.env.TOKENTRACKER_HOME || os.homedir()) {
  const config = await readConfig(home);
  if (!config || !config.enabled) return { continue: true };

  const event = String((payload && payload.hook_event_name) || "");
  const sessionId = (payload && payload.session_id) || "anon";
  const transcriptPath = (payload && payload.transcript_path) || "";
  const state = await readSessionState(home, sessionId);

  // SessionStart: replay a checkpoint nudge from the last expensive no-output run.
  if (event === "SessionStart") {
    if (state.checkpointMsg && Date.now() - (state.checkpointAt || 0) < NUDGE_TTL_MS) {
      await writeSessionState(home, sessionId, { checkpointMsg: "", checkpointAt: 0 });
      return {
        continue: true,
        hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: state.checkpointMsg },
      };
    }
    return { continue: true };
  }

  const { total_cost_usd: cost, signals } = analyzeTranscriptSync(transcriptPath);

  if (event === "PreToolUse") {
    let allowOnce = grantIsValid(state);
    let grantSession = sessionId;
    if (!allowOnce) {
      const global = await readSessionState(home, "_any");
      if (grantIsValid(global)) { allowOnce = true; grantSession = "_any"; }
    }
    const decision = decideGuard(cost, config, { warned: Boolean(state.warned), allowOnce });
    if (decision.action === "block") {
      return {
        continue: false,
        stopReason: decision.message,
        systemMessage: decision.message,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.message,
        },
      };
    }
    if (decision.action === "allow_once") {
      await consumeAllowOnce(home, grantSession);
      return { continue: true, systemMessage: decision.message };
    }
    if (decision.action === "warn") {
      await writeSessionState(home, sessionId, { warned: true, warnedAt: Date.now() });
      return { continue: true, systemMessage: decision.message };
    }
    return { continue: true };
  }

  if (event === "Stop") {
    const verdict = checkpointVerdict(cost, config, signals);
    if (verdict.triggered) {
      await writeSessionState(home, sessionId, { checkpointMsg: verdict.message, checkpointAt: Date.now() });
      return { continue: true, systemMessage: verdict.message };
    }
    return { continue: true };
  }

  return { continue: true };
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { data += chunk; });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
  });
}

async function cmdGuardHook() {
  let out = { continue: true };
  try {
    const raw = await readStdin();
    const payload = raw ? JSON.parse(raw) : {};
    out = await evaluateHook(payload);
  } catch {
    out = { continue: true }; // a broken guard must never break the editor
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

module.exports = { cmdGuardHook, evaluateHook };
