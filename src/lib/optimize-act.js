"use strict";

// optimize-act.js — the "one-click, reversible, honestly measured" half of the
// optimize loop. `act apply` turns a scanner finding's `fix.apply` into a real
// change, backing everything up first and writing an auditable change log;
// `act undo` rolls the last batch back; `act report` (once a change is >3 days
// old) re-scans and compares what actually got saved against what we promised.
//
// File-safety contract (mirrors the product's own rules):
//   - Never permanently delete. "Remove" = move into the optimize archive dir;
//     "edit config/CLAUDE.md" = timestamped backup first, restore on undo.
//   - Every mutation is recorded in changes.json so undo and the 3-day report
//     can reconstruct exactly what happened.

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { writeFileAtomic, ensureDir } = require("./fs");

const STATE_SUBPATH = path.join(".tokentracker", "optimize");
const APPLY_BATCH_DAYS = 3; // wait this long before we judge a fix real vs. not

function statePaths(home) {
  const root = path.join(home, STATE_SUBPATH);
  return {
    root,
    log: path.join(root, "changes.json"),
    archive: path.join(root, "archive"),
    backups: path.join(root, "backups"),
  };
}

function resolveHome(options = {}) {
  return options.home || os.homedir();
}

async function loadLog(logPath) {
  try {
    const raw = await fsp.readFile(logPath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.batches)) return parsed;
  } catch { /* first run or corrupt */ }
  return { version: 1, batches: [] };
}

async function saveLog(logPath, log) {
  await writeFileAtomic(logPath, `${JSON.stringify(log, null, 2)}\n`, { mode: 0o600 });
}

function copyFileSync(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

// Back up a user file into backups/<batch>/ before we touch it, returning the
// backup path (or null when the file does not exist yet, e.g. no CLAUDE.md).
function backupFile(backupsDir, batchId, filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(backupsDir, batchId, `${stamp}-${path.basename(filePath)}`);
  copyFileSync(filePath, dest);
  return dest;
}

async function applyChanges(options = {}) {
  const home = resolveHome(options);
  const paths = statePaths(home);
  const findings = Array.isArray(options.findings) ? options.findings : [];
  const allowUnsafe = options.yes === true;

  const candidates = findings.filter((f) => f && f.fix && f.fix.apply);
  const safe = candidates.filter((f) => f.fix.apply.safe);
  const risky = candidates.filter((f) => !f.fix.apply.safe);
  const selected = allowUnsafe ? candidates : safe;

  const batchId = `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  await ensureDir(paths.archive);
  await ensureDir(paths.backups);
  await ensureDir(paths.root);

  const entries = [];
  for (const finding of selected) {
    const entry = {
      id: finding.id,
      type: finding.type,
      title: finding.title,
      est_tokens: finding.wasted_tokens || 0,
      est_cost_usd: finding.wasted_cost_usd || 0,
      applied_at: new Date().toISOString(),
      result: "applied",
    };
    try {
      entry.apply = applyOne(finding.fix.apply, { home, paths, batchId });
    } catch (error) {
      entry.result = `error: ${error.message}`;
    }
    entries.push(entry);
  }

  const log = await loadLog(paths.log);
  log.batches.push({ batch_id: batchId, applied_at: new Date().toISOString(), home, entries, deferred_unsafe: risky.map((f) => f.id) });
  await saveLog(paths.log, log);

  return {
    batch_id: batchId,
    applied: entries.filter((e) => e.result === "applied"),
    errors: entries.filter((e) => e.result.startsWith("error")),
    skipped_unsafe: allowUnsafe ? [] : risky.map((f) => ({ id: f.id, title: f.title, pasteable: f.fix.pasteable })),
    log_path: paths.log,
    archive_dir: paths.archive,
  };
}

// Perform a single mutation. Returns a plain "undo descriptor" that undoLast
// uses to reverse it. Backups are created here so every edit is reversible.
function applyOne(apply, { home, paths, batchId }) {
  switch (apply.kind) {
    case "archive_path": {
      if (!fs.existsSync(apply.src)) return { kind: "archive_path", src: apply.src, dest: null, note: "source missing, nothing moved" };
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const dest = path.join(paths.archive, batchId, `${stamp}-${path.basename(apply.src)}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(apply.src, dest);
      return { kind: "archive_path", src: apply.src, dest };
    }
    case "append_claude_md": {
      const backup = backupFile(paths.backups, batchId, apply.target);
      const rule = `\n${apply.rule}\n`;
      fs.mkdirSync(path.dirname(apply.target), { recursive: true });
      const existing = fs.existsSync(apply.target) ? fs.readFileSync(apply.target, "utf8") : "";
      if (existing.includes(apply.rule.trim())) return { kind: "append_claude_md", target: apply.target, backup, changed: false };
      fs.writeFileSync(apply.target, `${existing}${existing.endsWith("\n") || existing === "" ? "" : "\n"}${rule}`, { mode: 0o600 });
      return { kind: "append_claude_md", target: apply.target, backup, changed: true };
    }
    case "remove_mcp_server": {
      const targetFile = apply.sourceFile;
      if (!targetFile || !targetFile.endsWith(".json")) {
        // TOML / unknown source: don't hand-edit, tell the user to run the pasteable.
        return { kind: "remove_mcp_server", target: targetFile, changed: false, note: "non-JSON config; use the pasteable command" };
      }
      const backup = backupFile(paths.backups, batchId, targetFile);
      let data;
      try { data = JSON.parse(fs.readFileSync(targetFile, "utf8")); } catch (e) { return { kind: "remove_mcp_server", target: targetFile, backup, changed: false, note: `parse failed: ${e.message}` }; }
      const bag = data.mcpServers || data.mcp_servers;
      if (bag && Object.prototype.hasOwnProperty.call(bag, apply.name)) {
        delete bag[apply.name];
        fs.writeFileSync(targetFile, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
        return { kind: "remove_mcp_server", target: targetFile, backup, name: apply.name, changed: true };
      }
      return { kind: "remove_mcp_server", target: targetFile, backup, changed: false, note: "server key not found" };
    }
    default:
      return { kind: apply.kind, changed: false, note: "no automatic apply handler; manual pasteable only" };
  }
}

async function undoLast(options = {}) {
  const home = resolveHome(options);
  const paths = statePaths(home);
  const log = await loadLog(paths.log);
  const batch = log.batches[log.batches.length - 1];
  if (!batch) return { undone: false, reason: "no recorded changes to undo" };

  const reversed = [];
  for (const entry of [...batch.entries].reverse()) {
    const desc = entry.apply;
    if (!desc) continue;
    try {
      if (desc.kind === "archive_path" && desc.dest && fs.existsSync(desc.dest)) {
        fs.mkdirSync(path.dirname(desc.src), { recursive: true });
        fs.renameSync(desc.dest, desc.src);
        reversed.push({ id: entry.id, action: "restored", from: desc.dest, to: desc.src });
      } else if (desc.backup && fs.existsSync(desc.backup)) {
        fs.copyFileSync(desc.backup, desc.target);
        reversed.push({ id: entry.id, action: "restored", from: desc.backup, to: desc.target });
      } else if (desc.kind === "append_claude_md" && desc.changed && !desc.backup) {
        // File didn't exist before the append → remove the file we created.
        fs.rmSync(desc.target, { force: true });
        reversed.push({ id: entry.id, action: "removed_created_file", to: desc.target });
      } else {
        reversed.push({ id: entry.id, action: "no-op", note: desc.note || "nothing to reverse" });
      }
    } catch (error) {
      reversed.push({ id: entry.id, action: "error", note: error.message });
    }
  }

  // Consume the batch so a second `undo` targets the batch before it.
  log.batches.pop();
  await saveLog(paths.log, log);
  return { undone: true, batch_id: batch.batch_id, reversed };
}

async function reportChanges(options = {}) {
  const home = resolveHome(options);
  const paths = statePaths(home);
  const nowMs = options.nowMs || Date.now();
  const scanWaste = options.scanWaste || require("./optimize-scan").scanWaste;
  const log = await loadLog(paths.log);

  if (!log.batches.length) return { report: null, message: "No fixes have been applied yet, so there is nothing to compare. Run `act apply` first." };

  // Re-scan once and index by finding id so we can see if each fix "stuck".
  const fresh = await scanWaste({ home, env: options.env || process.env, sinceDays: options.sinceDays || 90 });
  const freshById = new Map(fresh.findings.map((f) => [f.id, f]));

  const rows = [];
  let promised = 0;
  let realized = 0;
  let pending = 0;
  for (const batch of log.batches) {
    const ageDays = (nowMs - Date.parse(batch.applied_at)) / 86_400_000;
    for (const entry of batch.entries) {
      promised += entry.est_cost_usd || 0;
      const verdict = judgeFix(entry, ageDays, freshById);
      if (verdict.status === "pending") { pending += 1; continue; }
      realized += verdict.realized_cost_usd;
      rows.push({
        id: entry.id,
        title: entry.title,
        applied_at: batch.applied_at,
        age_days: Math.round(ageDays * 10) / 10,
        status: verdict.status,
        estimated_cost_usd: round2(entry.est_cost_usd),
        realized_cost_usd: round2(verdict.realized_cost_usd),
        note: verdict.note,
      });
    }
  }

  rows.sort((a, b) => b.realized_cost_usd - a.realized_cost_usd);
  return {
    report: {
      generated_at: new Date(nowMs).toISOString(),
      threshold_days: APPLY_BATCH_DAYS,
      rows,
      summary: {
        estimated_total_usd: round2(promised),
        realized_measurable_usd: round2(realized),
        pending_items: pending,
        honest_note: "Realized = what a re-scan no longer flags as waste. Items marked 'still_waste' did not help as estimated; 'pending' need at least 3 days of new sessions to judge.",
      },
    },
  };
}

function judgeFix(entry, ageDays, freshById) {
  if (ageDays < APPLY_BATCH_DAYS) return { status: "pending", realized_cost_usd: 0, note: `too new (${Math.round(ageDays * 10) / 10}d < ${APPLY_BATCH_DAYS}d)` };
  const now = freshById.get(entry.id);
  if (!now) return { status: "resolved", realized_cost_usd: entry.est_cost_usd || 0, note: "finding no longer appears — fix appears to have worked" };
  const remaining = now.wasted_cost_usd || 0;
  const saved = Math.max(0, (entry.est_cost_usd || 0) - remaining);
  if (saved <= 0.0001 && remaining >= (entry.est_cost_usd || 0) * 0.9) {
    return { status: "still_waste", realized_cost_usd: 0, note: "still flagged at ~the same cost — this change did not help" };
  }
  return { status: "partial", realized_cost_usd: saved, note: `reduced from $${round2(entry.est_cost_usd)} to $${round2(remaining)}` };
}

function round2(n) { return Math.round((Number(n) || 0) * 10000) / 10000; }

module.exports = {
  applyChanges,
  undoLast,
  reportChanges,
  statePaths,
};
