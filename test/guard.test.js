"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { decideGuard, checkpointVerdict, analyzeTranscriptSync, normalizeConfig } = require("../src/lib/guard-core");
const { installGuard, removeGuard, guardStatus, writeConfig, grantAllowOnce, readSessionState } = require("../src/lib/guard-manager");
const { evaluateHook } = require("../src/commands/guard-hook");

const TRACKER = path.join(__dirname, "..", "bin", "tracker.js");

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tt-guard-"));
}

// Flatten the command strings out of a settings.hooks[event] array (handles both
// the {command} and the {hooks:[{command}]} entry shapes Claude accepts).
function commandsFor(entries) {
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.command) out.push(entry.command);
    for (const h of Array.isArray(entry.hooks) ? entry.hooks : []) if (h && h.command) out.push(h.command);
  }
  return out;
}

function transcriptPath(home, body, name = "transcript.jsonl") {
  const p = path.join(home, name);
  fs.writeFileSync(p, body.map((o) => JSON.stringify(o) + "\n").join(""));
  return p;
}

function assistantLine(inputTokens, extraContent = []) {
  return { type: "assistant", message: { model: "claude-sonnet-4-5", usage: { input_tokens: inputTokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: extraContent } };
}

// ---- guard-core: pure decision table ----
test("decideGuard: allow / warn / block / allow_once", () => {
  const cfg = { soft: 5, hard: 15, checkpoint: 3 };
  assert.strictEqual(decideGuard(1, cfg, {}).action, "allow");
  const warn = decideGuard(6, cfg, {});
  assert.strictEqual(warn.action, "warn");
  assert.match(warn.message, /软上限/);
  assert.strictEqual(decideGuard(6, cfg, { warned: true }).action, "allow"); // warn only once
  assert.strictEqual(decideGuard(20, cfg, {}).action, "block");
  assert.match(decideGuard(20, cfg, {}).message, /guard allow/);
  assert.strictEqual(decideGuard(20, cfg, { allowOnce: true }).action, "allow_once");
});

test("checkpointVerdict triggers on spend with no edit and no commit", () => {
  const cfg = { soft: 5, hard: 15, checkpoint: 3 };
  assert.strictEqual(checkpointVerdict(4, cfg, { hadEdit: false, hadCommit: false }).triggered, true);
  assert.strictEqual(checkpointVerdict(4, cfg, { hadEdit: true, hadCommit: false }).triggered, false);
  assert.strictEqual(checkpointVerdict(4, cfg, { hadEdit: false, hadCommit: true }).triggered, false);
  assert.strictEqual(checkpointVerdict(1, cfg, { hadEdit: false, hadCommit: false }).triggered, false); // under checkpoint
});

test("analyzeTranscriptSync prices cost from usage and detects edit/commit", () => {
  const home = tmpHome();
  const p = transcriptPath(home, [
    assistantLine(2_000_000, [{ type: "tool_use", name: "Edit", input: { file_path: "a.ts" } }]),
    { type: "assistant", message: { model: "claude-sonnet-4-5", usage: { input_tokens: 0 }, content: [{ type: "tool_use", name: "Bash", input: { command: "git commit -m x" } }] } },
  ]);
  const r = analyzeTranscriptSync(p);
  assert.ok(r.total_cost_usd > 5, `expected >$5, got ${r.total_cost_usd}`);
  assert.strictEqual(r.signals.hadEdit, true);
  assert.strictEqual(r.signals.hadCommit, true);
});

// ---- guard-manager: reversible opt-in install into ~/.claude/settings.json ----
test("guard on/off installs and removes hooks, preserving unrelated settings and backing up", async () => {
  const home = tmpHome();
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(claudeDir, { recursive: true });
  const settingsPath = path.join(claudeDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({ model: "keep-me", theme: "dark" }));

  const inst = await installGuard({ home, soft: 5, hard: 15, checkpoint: 3 });
  const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  assert.strictEqual(settings.model, "keep-me", "unrelated keys preserved");
  for (const event of ["PreToolUse", "Stop", "SessionStart"]) {
    assert.ok(commandsFor(settings.hooks[event]).includes(inst.hookCommand), `${event} hook present`);
  }
  assert.ok(inst.backupPath && fs.existsSync(inst.backupPath), "a timestamped backup of settings.json was written");

  const status = await guardStatus({ home });
  assert.strictEqual(status.enabled, true);
  assert.strictEqual(status.hooksPresent, true);

  const off = await removeGuard({ home });
  assert.strictEqual(off.removed, true);
  const after = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const remaining = ["PreToolUse", "Stop", "SessionStart"].flatMap((e) => commandsFor(after.hooks && after.hooks[e]));
  assert.ok(!remaining.includes(inst.hookCommand), "hooks removed on guard off");
  assert.strictEqual(after.model, "keep-me", "unrelated keys still preserved after removal");
});

test("guard limit does not clobber unspecified thresholds", async () => {
  const home = tmpHome();
  await writeConfig(home, { soft: 4, hard: 12, checkpoint: 2 });
  await writeConfig(home, { hard: 20 });
  const cfg = normalizeConfig(JSON.parse(fs.readFileSync(path.join(home, ".tokentracker", "guard.json"), "utf8")));
  assert.strictEqual(cfg.soft, 4);
  assert.strictEqual(cfg.hard, 20);
  assert.strictEqual(cfg.checkpoint, 2);
});

// ---- hook decision logic (in-process via evaluateHook) + CLI wiring smoke ----

test("guard-hook decides block / one-time warn / allow-once / checkpoint", async () => {
  const home = tmpHome();
  await installGuard({ home, soft: 1, hard: 5, checkpoint: 1 });
  const big = transcriptPath(home, [assistantLine(2_000_000)], "big.jsonl"); // ~$6
  const mid = transcriptPath(home, [assistantLine(500_000)], "mid.jsonl"); // ~$1.5
  const edited = transcriptPath(home, [assistantLine(500_000, [{ type: "tool_use", name: "Edit", input: { file_path: "a" } }])], "edited.jsonl");

  // hard limit -> block (stop the session)
  const blocked = await evaluateHook({ hook_event_name: "PreToolUse", session_id: "s1", transcript_path: big }, home);
  assert.strictEqual(blocked.continue, false);
  assert.strictEqual(blocked.hookSpecificOutput.permissionDecision, "deny");
  assert.match(blocked.stopReason, /硬上限/);

  // soft limit -> warn once, non-blocking
  const warn = await evaluateHook({ hook_event_name: "PreToolUse", session_id: "s2", transcript_path: mid }, home);
  assert.strictEqual(warn.continue, true);
  assert.match(warn.systemMessage, /软上限/);
  const warnAgain = await evaluateHook({ hook_event_name: "PreToolUse", session_id: "s2", transcript_path: mid }, home);
  assert.ok(!warnAgain.systemMessage, "soft nudge is one-time per session");

  // after a one-time allow grant, a blocked call passes exactly once
  await grantAllowOnce(home, "_any");
  const once = await evaluateHook({ hook_event_name: "PreToolUse", session_id: "s3", transcript_path: big }, home);
  assert.strictEqual(once.continue, true);
  assert.match(once.systemMessage, /放行/);
  assert.strictEqual((await readSessionState(home, "_any")).allowOnce, false, "grant is consumed");
  assert.strictEqual((await evaluateHook({ hook_event_name: "PreToolUse", session_id: "s3", transcript_path: big }, home)).continue, false);

  // checkpoint nudge fires on an expensive no-output Stop, not on one with an edit
  const stop = await evaluateHook({ hook_event_name: "Stop", session_id: "s4", transcript_path: mid }, home);
  assert.match(stop.systemMessage, /没有/);
  const stopOk = await evaluateHook({ hook_event_name: "Stop", session_id: "s5", transcript_path: edited }, home);
  assert.ok(!stopOk.systemMessage, "no nudge when there was an edit");
  // SessionStart replays the stored checkpoint nudge as additionalContext, then clears it
  const restart = await evaluateHook({ hook_event_name: "SessionStart", session_id: "s4" }, home);
  assert.match(restart.hookSpecificOutput.additionalContext, /没有/);
  await fsp.rm(home, { recursive: true, force: true });
});

test("guard-hook allows everything when guard is disabled", async () => {
  const home = tmpHome();
  const big = transcriptPath(home, [assistantLine(2_000_000)], "big.jsonl");
  const res = await evaluateHook({ hook_event_name: "PreToolUse", session_id: "s1", transcript_path: big }, home);
  assert.strictEqual(res.continue, true);
  await fsp.rm(home, { recursive: true, force: true });
});

// Real child process: proves the `guard` subcommand is wired into the CLI and
// round-trips JSON, without asserting dollar math (the child's pricing differs
// under `node --test`, so the decision itself is covered in-process above).
test("cli wiring: `guard status --json` runs through bin/tracker.js", async () => {
  const home = tmpHome();
  await installGuard({ home, soft: 5, hard: 15, checkpoint: 3 });
  const res = spawnSync(process.execPath, [TRACKER, "guard", "status", "--json", "--home", home], { encoding: "utf8" });
  assert.strictEqual(res.status, 0, `status exited ${res.status}: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.strictEqual(parsed.enabled, true);
  assert.strictEqual(parsed.hooksPresent, true);
  await fsp.rm(home, { recursive: true, force: true });
});
