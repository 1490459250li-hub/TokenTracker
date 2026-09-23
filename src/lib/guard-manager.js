"use strict";

// guard-manager.js — installs/removes the opt-in budget-guard hooks and owns the
// guard config + per-session one-shot state. It deliberately reuses
// claude-config.js for the settings.json edit so we inherit that module's
// timestamped backup + idempotent upsert/remove behavior (no re-invention, and
// the real init flow already trusts it).

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  upsertClaudeHooks,
  removeClaudeHooks,
  areClaudeHooksConfigured,
} = require("./claude-config");
const { ensureDir, writeFileAtomic } = require("./fs");
const { DEFAULTS, normalizeConfig } = require("./guard-core");

const GUARD_EVENTS = ["PreToolUse", "Stop", "SessionStart"];
const GRANT_TTL_MS = 90_000; // a `guard allow` unlocks the next tool call for 90s

function claudeDirFor(home, env = process.env) {
  const override = env.CLAUDE_CONFIG_DIR;
  return override ? path.resolve(override) : path.join(home, ".claude");
}

function guardPaths(home) {
  const root = path.join(home, ".tokentracker");
  const stateDir = path.join(root, "guard-state");
  return {
    root,
    config: path.join(root, "guard.json"),
    stateDir,
    settings: path.join(claudeDirFor(home), "settings.json"),
  };
}

function defaultTrackerPath() {
  // …/EmbeddedServer/tokentracker/src/lib -> ../../bin/tracker.js
  return path.join(__dirname, "..", "..", "bin", "tracker.js");
}

// Windows-safe quoting so Claude Code's shell runner keeps the path intact.
function quote(value) {
  const v = String(value || "");
  if (/^[A-Za-z0-9_\-./:@]+$/.test(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildGuardHookCommand({ trackerPath = defaultTrackerPath(), execPath = process.execPath } = {}) {
  return `${quote(execPath)} ${quote(trackerPath)} guard-hook`;
}

async function readConfig(home) {
  try {
    const raw = await fsp.readFile(guardPaths(home).config, "utf8");
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return normalizeConfig({ enabled: false, ...DEFAULTS });
  }
}

async function writeConfig(home, patch) {
  const paths = guardPaths(home);
  const clean = {};
  for (const [key, value] of Object.entries(patch || {})) if (value !== undefined) clean[key] = value;
  const merged = normalizeConfig({ ...(await readRawConfig(home)), ...clean });
  await ensureDir(paths.root);
  await writeFileAtomic(paths.config, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return merged;
}

async function readRawConfig(home) {
  try { return JSON.parse(await fsp.readFile(guardPaths(home).config, "utf8")); } catch { return {}; }
}

async function installGuard(options = {}) {
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const paths = guardPaths(home);
  const settingsPath = options.settingsPath || path.join(claudeDirFor(home, env), "settings.json");
  const hookCommand = options.hookCommand || buildGuardHookCommand(options);
  const config = await writeConfig(home, { enabled: true, ...pickLimits(options) });
  const result = await upsertClaudeHooks({ settingsPath, hookCommand, events: GUARD_EVENTS });
  return { installed: true, changed: result.changed, backupPath: result.backupPath, settingsPath, hookCommand, events: GUARD_EVENTS, config };
}

async function removeGuard(options = {}) {
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const settingsPath = options.settingsPath || path.join(claudeDirFor(home, env), "settings.json");
  const hookCommand = options.hookCommand || buildGuardHookCommand(options);
  const result = await removeClaudeHooks({ settingsPath, hookCommand, events: GUARD_EVENTS });
  await writeConfig(home, { enabled: false });
  return { removed: result.removed, skippedReason: result.skippedReason || null, backupPath: result.backupPath || null, settingsPath };
}

async function guardStatus(options = {}) {
  const home = options.home || os.homedir();
  const env = options.env || process.env;
  const settingsPath = options.settingsPath || path.join(claudeDirFor(home, env), "settings.json");
  const hookCommand = options.hookCommand || buildGuardHookCommand(options);
  const config = await readConfig(home);
  let hooksPresent = false;
  for (const event of GUARD_EVENTS) {
    hooksPresent = await areClaudeHooksConfigured({ settingsPath, hookCommand, events: [event] });
    if (!hooksPresent) break;
  }
  return { enabled: config.enabled && hooksPresent, config, hooksPresent, settingsPath, hookCommand, events: GUARD_EVENTS };
}

// ---- per-session one-shot state (warned / allow-once) ----
function stateFile(home, sessionId) {
  const safe = String(sessionId || "anon").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80);
  return path.join(guardPaths(home).stateDir, `${safe}.json`);
}

async function readSessionState(home, sessionId) {
  try { return JSON.parse(await fsp.readFile(stateFile(home, sessionId), "utf8")); } catch { return {}; }
}

async function writeSessionState(home, sessionId, patch) {
  const paths = guardPaths(home);
  await ensureDir(paths.stateDir);
  const current = await readSessionState(home, sessionId);
  const next = { ...current, ...patch };
  await writeFileAtomic(stateFile(home, sessionId), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  return next;
}

function grantIsValid(state, nowMs = Date.now()) {
  return Boolean(state.allowOnce && Number(state.grantUntil) > nowMs);
}

async function grantAllowOnce(home, sessionId) {
  return writeSessionState(home, sessionId, { allowOnce: true, grantUntil: Date.now() + GRANT_TTL_MS });
}

async function consumeAllowOnce(home, sessionId) {
  const next = await writeSessionState(home, sessionId, { allowOnce: false, grantUntil: 0 });
  return next;
}

function pickLimits(options) {
  const out = {};
  if (options.soft != null) out.soft = options.soft;
  if (options.hard != null) out.hard = options.hard;
  if (options.checkpoint != null) out.checkpoint = options.checkpoint;
  return out;
}

module.exports = {
  GUARD_EVENTS,
  GRANT_TTL_MS,
  guardPaths,
  buildGuardHookCommand,
  defaultTrackerPath,
  readConfig,
  writeConfig,
  installGuard,
  removeGuard,
  guardStatus,
  readSessionState,
  writeSessionState,
  grantIsValid,
  grantAllowOnce,
  consumeAllowOnce,
};
