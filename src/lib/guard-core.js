"use strict";

// guard-core.js — the pure, testable brain of the real-time budget guard (P2).
// No file writes here: it just turns a transcript + a config into a decision.
// The hook/manager layer handles persistence, backups and settings.json edits.
//
// Mirrors CodeBurn `guard`:
//   - soft limit  : a one-time nudge inside the session (default $5)
//   - hard limit  : stop the session until the user explicitly allows once ($15)
//   - checkpoint  : at session end, if we spent > $3 with no edit/commit,
//                   tell the user to reopen next time with a clear deliverable.
//
// Cost comes from the SAME pricing the dashboard uses (bundled seed snapshot so
// the hook stays fast + offline; no network on the hot path).

const fs = require("node:fs");

const { physicalJsonlRecords } = require("./jsonl-lines");
const { computeRowCost, resetPricingForTests } = require("./pricing");

const EDIT_TOOLS = new Set([
  "edit", "write", "multiedit", "apply_patch", "notebookedit",
  "search_replace", "str_replace", "create_file", "write_file", "replace",
]);
const DEFAULTS = Object.freeze({ soft: 5, hard: 15, checkpoint: 3 });

function normalizeConfig(raw) {
  const src = raw && typeof raw === "object" ? raw : {};
  const num = (v, fb) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : fb;
  };
  return {
    enabled: src.enabled !== false,
    soft: num(src.soft, DEFAULTS.soft),
    hard: num(src.hard, DEFAULTS.hard),
    checkpoint: num(src.checkpoint, DEFAULTS.checkpoint),
  };
}

// Read a session transcript and roll it into per-model token buckets + signals.
// This intentionally runs over local files only and keeps counts, never text.
function analyzeTranscriptSync(transcriptPath) {
  const byModel = new Map(); // model -> token bucket
  const signals = { hadEdit: false, hadCommit: false, toolCalls: 0, turns: 0 };
  let text = "";
  try {
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return { byModel, signals, total_cost_usd: 0, tokens: 0 };
  }

  // Synchronous split is fine here: transcripts are LF-delimited JSON lines.
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch { continue; }
    const message = obj.message;
    if (!message || typeof message !== "object") continue;
    const usage = message.usage;
    if (usage && typeof usage === "object") {
      signals.turns += 1;
      const model = String(message.model || "unknown");
      const bucket = byModel.get(model) || {
        model, source: "claude",
        input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0,
        cached_input_tokens: 0, cache_creation_input_tokens: 0,
      };
      bucket.input_tokens += Number(usage.input_tokens || 0);
      bucket.output_tokens += Number(usage.output_tokens || 0);
      bucket.reasoning_output_tokens += Number(usage.reasoning_output_tokens || 0);
      bucket.cached_input_tokens += Number(usage.cache_read_input_tokens || 0);
      bucket.cache_creation_input_tokens += Number(usage.cache_creation_input_tokens || 0);
      byModel.set(model, bucket);
    }
    const content = Array.isArray(message.content) ? message.content : [];
    for (const block of content) {
      if (!block || typeof block !== "object" || block.type !== "tool_use") continue;
      signals.toolCalls += 1;
      const name = String(block.name || "").toLowerCase();
      if (EDIT_TOOLS.has(name)) signals.hadEdit = true;
      if ((name === "bash" || name === "exec_command") && block.input) {
        const cmd = String(block.input.command || block.input.cmd || "");
        if (/\bgit\s+commit\b/.test(cmd)) signals.hadCommit = true;
      }
    }
  }

  // Seed pricing synchronously so computeRowCost resolves offline & deterministically.
  resetPricingForTests();
  let totalCost = 0;
  let totalTokens = 0;
  for (const bucket of byModel.values()) {
    totalCost += Number(computeRowCost(bucket)) || 0;
    totalTokens +=
      bucket.input_tokens + bucket.output_tokens + bucket.reasoning_output_tokens +
      bucket.cached_input_tokens + bucket.cache_creation_input_tokens;
  }
  return { byModel, signals, total_cost_usd: totalCost, tokens: totalTokens };
}

// Turn a cost number into the guard's verdict. `ctx` carries the per-session
// one-shot flags so "warn once" and "allow once" behave across hook calls.
function decideGuard(costUsd, config, ctx = {}) {
  const cfg = normalizeConfig(config);
  const cost = Number(costUsd) || 0;
  const { soft, hard, checkpoint } = cfg;
  const warned = Boolean(ctx.warned);
  const allowOnce = Boolean(ctx.allowOnce);

  if (hard > 0 && cost >= hard) {
    if (allowOnce) {
      return { action: "allow_once", reason: "hard_limit_bypassed_once", message: hardBlockMessage(cost, hard, true) };
    }
    return { action: "block", reason: "hard_limit", message: hardBlockMessage(cost, hard, false) };
  }
  if (soft > 0 && cost >= soft && !warned) {
    return { action: "warn", reason: "soft_limit", message: `TokenTracker guard: 本会话已花费 $${cost.toFixed(2)}，达到软上限 $${soft}（硬上限 $${hard}）。请确认是否继续。` };
  }
  return { action: "allow", reason: cost > 0 ? "under_soft_limit" : "no_cost", message: "" };
}

function hardBlockMessage(cost, hard, bypassed) {
  if (bypassed) {
    return `TokenTracker guard: 已花费 $${cost.toFixed(2)}（超硬上限 $${hard}），本次已按你的单次放行允许继续。`;
  }
  return `TokenTracker guard: 会话花费 $${cost.toFixed(2)} 已达硬上限 $${hard}，已停止。若确需继续，运行 tokentracker guard allow 放行一次后重试。`;
}

// The "was this session worth it" checkpoint evaluated at Stop time.
function checkpointVerdict(costUsd, config, signals) {
  const cfg = normalizeConfig(config);
  const cost = Number(costUsd) || 0;
  const s = signals || {};
  if (cfg.checkpoint > 0 && cost >= cfg.checkpoint && !s.hadEdit && !s.hadCommit) {
    return {
      triggered: true,
      message: `TokenTracker guard: 这次会话花了 $${cost.toFixed(2)}，却没有任何 edit 或 commit。下次带一个明确交付目标再开，能少烧钱。`,
    };
  }
  return { triggered: false, message: "" };
}

module.exports = {
  DEFAULTS,
  normalizeConfig,
  analyzeTranscriptSync,
  decideGuard,
  checkpointVerdict,
  // re-exported for the async streaming path if callers prefer it:
  physicalJsonlRecords,
};
