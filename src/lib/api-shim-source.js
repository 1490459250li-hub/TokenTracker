"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// API-shim usage source — sync-side incremental reader.
//
// The api-shim (src/api-shim/server.js) is a local reverse proxy for direct
// OpenAI-compatible API calls (DeepSeek, Xiaomi MiMo, ...). Every proxied
// request appends one JSON line to ~/.tokentracker/api-shim/usage.jsonl:
//
//   {"ts":"...","source":"deepseek-api","model":"deepseek-chat",
//    "input_tokens":123,"cached_input_tokens":0,"cache_creation_input_tokens":0,
//    "output_tokens":45,"reasoning_output_tokens":0,"total_tokens":168,
//    "status":200,"duration_ms":2380,"stream":true}
//
// This module converts new lines into the same half-hour bucket rows every
// other source writes, honouring the queue's last-row-wins contract: for each
// touched (source, model, hour_start) key we append ONE row carrying the full
// running totals. Zero third-party dependencies.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const HALF_HOUR_MS = 30 * 60 * 1000;
const CURSOR_KEY = "apiShimUsage";
// shim 记账来源 → 主页统计管线。sensenova-api / mimo-payg-api 于 2026-09-22
// 补入（此前白名单只有 deepseek-api/mimo-api，导致日日新与 MiMo 按量调用
// 经 shim 记账后不进主页 Token 总数）。
const SUPPORTED_SOURCES = new Set([
  "deepseek-api",
  "mimo-api",
  "mimo-payg-api",
  "sensenova-api",
]);
// Buckets older than this are dropped from the in-memory running state after
// being queued at least once. New events cannot legally arrive for hours that
// far in the past (the shim stamps ts at response time), so pruning keeps the
// cursor small without ever losing a token.
const BUCKET_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function defaultLogPath(env = process.env) {
  const override = String(env?.TOKENTRACKER_API_SHIM_USAGE_LOG || "").trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".tokentracker", "api-shim", "usage.jsonl");
}

function halfHourFloor(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(Math.floor(ms / HALF_HOUR_MS) * HALF_HOUR_MS).toISOString();
}

const NUMERIC_FIELDS = [
  "input_tokens",
  "cached_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
  "reasoning_output_tokens",
  "total_tokens",
];

// Validate one JSONL line. Returns a normalized event or null (with reason).
function normalizeEvent(raw) {
  if (!raw || typeof raw !== "object") return { event: null, reason: "not an object" };
  const source = String(raw.source || "").toLowerCase();
  if (!SUPPORTED_SOURCES.has(source)) return { event: null, reason: `unknown source '${source}'` };
  const model = String(raw.model || "").trim() || "unknown";
  const hourStart = halfHourFloor(raw.ts);
  if (!hourStart) return { event: null, reason: "bad ts" };
  const totals = {};
  for (const field of NUMERIC_FIELDS) {
    const value = Number(raw[field]);
    totals[field] = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }
  // billable defaults to total when the shim could not split it
  const billable = Number(raw.billable_total_tokens);
  totals.billable_total_tokens =
    Number.isFinite(billable) && billable > 0 ? Math.floor(billable) : totals.total_tokens;
  return {
    event: {
      source,
      model,
      hour_start: hourStart,
      totals,
      conversation_count: 1,
    },
    reason: null,
  };
}

function emptyBucketTotals() {
  const totals = {};
  for (const field of NUMERIC_FIELDS) totals[field] = 0;
  totals.billable_total_tokens = 0;
  return totals;
}

function addToBucket(bucket, event) {
  bucket.conversation_count = (bucket.conversation_count || 0) + 1;
  for (const field of NUMERIC_FIELDS) {
    bucket.totals[field] += event.totals[field];
  }
  bucket.totals.billable_total_tokens += event.totals.billable_total_tokens;
}

function bucketRow(source, model, hourStart, totals, conversationCount) {
  return {
    source,
    model,
    hour_start: hourStart,
    input_tokens: totals.input_tokens,
    cached_input_tokens: totals.cached_input_tokens,
    cache_creation_input_tokens: totals.cache_creation_input_tokens,
    output_tokens: totals.output_tokens,
    reasoning_output_tokens: totals.reasoning_output_tokens,
    total_tokens: totals.total_tokens,
    billable_total_tokens: totals.billable_total_tokens,
    total_cost_usd: 0,
    conversation_count: conversationCount,
  };
}

// Read new complete lines starting at `offset`; returns { text, nextOffset }.
async function readNewLines(logPath, offset) {
  let handle;
  try {
    handle = await fs.open(logPath, "r");
  } catch (err) {
    if (err.code === "ENOENT") return { lines: [], nextOffset: 0, truncated: false };
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (offset > stat.size) offset = 0; // log was rotated/truncated — replay from the start
    if (offset >= stat.size) return { lines: [], nextOffset: offset, truncated: false };
    const length = Math.min(stat.size - offset, 64 * 1024 * 1024);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const text = buffer.toString("utf8", 0, bytesRead);
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) return { lines: [], nextOffset: offset, truncated: false };
    return {
      lines: text.slice(0, lastNewline).split("\n").filter((line) => line.trim() !== ""),
      nextOffset: offset + Buffer.byteLength(text.slice(0, lastNewline + 1), "utf8"),
      truncated: false,
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Incrementally convert new shim log lines into queue rows.
 *
 * @param {object} options
 * @param {object} options.cursors   Shared sync cursor store (mutated).
 * @param {string} options.queuePath Target queue.jsonl.
 * @param {string} [options.logPath] Override the shim usage log location.
 * @param {function} [options.onProgress]
 * @returns {{recordsProcessed: number, eventsAggregated: number, bucketsQueued: number}}
 */
async function parseApiShimUsageIncremental({ cursors, queuePath, logPath, onProgress } = {}) {
  const target = logPath || defaultLogPath();
  if (!cursors || typeof cursors !== "object") cursors = {};
  if (!cursors[CURSOR_KEY] || typeof cursors[CURSOR_KEY] !== "object") {
    cursors[CURSOR_KEY] = {};
  }
  const state = cursors[CURSOR_KEY];
  if (state.logPath !== target) {
    // Log location changed — restart from the new file's beginning.
    state.logPath = target;
    state.offset = 0;
  }
  if (!Number.isFinite(state.offset) || state.offset < 0) state.offset = 0;
  if (!state.buckets || typeof state.buckets !== "object") state.buckets = {};
  const buckets = state.buckets;

  const { lines, nextOffset } = await readNewLines(target, state.offset);
  let recordsProcessed = 0;
  let eventsAggregated = 0;
  const touched = new Set();
  const now = Date.now();

  for (const line of lines) {
    recordsProcessed += 1;
    let raw = null;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const { event } = normalizeEvent(raw);
    if (!event) continue;
    eventsAggregated += 1;
    const key = `${event.source}|${event.model}|${event.hour_start}`;
    let bucket = buckets[key];
    if (!bucket) {
      bucket = {
        source: event.source,
        model: event.model,
        hour_start: event.hour_start,
        totals: emptyBucketTotals(),
        conversation_count: 0,
      };
      buckets[key] = bucket;
    }
    addToBucket(bucket, event);
    touched.add(key);
  }
  state.offset = nextOffset;

  // Prune stale buckets (already queued long ago) so the cursor stays small.
  for (const [key, bucket] of Object.entries(buckets)) {
    const bucketMs = Date.parse(bucket.hour_start || "");
    if (Number.isFinite(bucketMs) && now - bucketMs > BUCKET_RETENTION_MS && !touched.has(key)) {
      delete buckets[key];
    }
  }

  if (touched.size === 0) {
    return { recordsProcessed, eventsAggregated, bucketsQueued: 0 };
  }

  // Append one full-total row per touched bucket (last-row-wins contract).
  const rows = [];
  for (const key of touched) {
    const bucket = buckets[key];
    rows.push(
      JSON.stringify(
        bucketRow(
          bucket.source,
          bucket.model,
          bucket.hour_start,
          bucket.totals,
          bucket.conversation_count,
        ),
      ),
    );
  }
  await fs.appendFile(queuePath, `${rows.join("\n")}\n`, "utf8");

  if (typeof onProgress === "function") {
    onProgress({ recordsProcessed, eventsAggregated, bucketsQueued: touched.size });
  }
  return { recordsProcessed, eventsAggregated, bucketsQueued: touched.size };
}

module.exports = {
  parseApiShimUsageIncremental,
  resolveApiShimUsageLogPath: defaultLogPath,
  halfHourFloor,
  normalizeEvent,
};
