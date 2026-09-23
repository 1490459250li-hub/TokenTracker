"use strict";

// usage-queue.js — the provider-agnostic usage source. The dashboard's cost
// tables are driven by the local append-only queue (~/.tokentracker/tracker/
// queue.jsonl), which every supported tool writes into (claude, codex, cursor,
// gemini, workbuddy, and the domestic models). The session-analytics path only
// parses claude/codex/grok transcripts, so it is blind to most real usage.
//
// This module reads + dedups the queue (latest row per source|model|hour_start,
// the documented reader contract) and aggregates tokens + cost + cache-hit by
// model / day / source. Cost uses the same pricing the app bills with; models
// with no known price are flagged rather than silently shown as $0.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { computeRowCost, getModelPricing, resetPricingForTests } = require("./pricing");

function queuePath(home) {
  return path.join(home, ".tokentracker", "tracker", "queue.jsonl");
}

function num(n) {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? v : 0;
}

// Latest-wins dedup keyed by source|model|hour_start.
function readQueueRows(home) {
  let raw;
  try {
    raw = fs.readFileSync(queuePath(home), "utf8");
  } catch {
    return [];
  }
  const latest = new Map();
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    const hour = String(o.hour_start || o.hour || "");
    if (!hour) continue;
    const key = `${o.source || "?"}|${o.model || "?"}|${hour}`;
    latest.set(key, o); // later line overwrites earlier (append-only log)
  }
  return [...latest.values()];
}

function inDayRange(hourStart, from, to) {
  const day = String(hourStart || "").slice(0, 10);
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

function priceRow(row) {
  const cost = Number(computeRowCost(row)) || 0;
  const p = getModelPricing(row.model, { source: row.source }) || {};
  const priced = (p.input || 0) + (p.output || 0) > 0 || cost > 0;
  return { cost_usd: cost, priced };
}

// Aggregate the queue. options: { home, from, to }
function aggregateUsage(options = {}) {
  const home = options.home || os.homedir();
  const from = String(options.from || "");
  const to = String(options.to || "");
  resetPricingForTests(); // offline, deterministic seed (no network on hot path)

  const rows = readQueueRows(home).filter((r) => inDayRange(r.hour_start || r.hour, from, to));

  const models = new Map(); // source|model -> bucket
  const days = new Map();   // YYYY-MM-DD -> {cost_usd,total_tokens}
  const sources = new Map();
  let totalCost = 0;
  let totalTokens = 0;
  let cacheRead = 0;
  let cacheCreation = 0;

  for (const r of rows) {
    const source = String(r.source || "?");
    const model = String(r.model || "?");
    const bucket = models.get(`${source}|${model}`) || {
      source, model,
      input_tokens: 0, output_tokens: 0, cached_input_tokens: 0,
      cache_creation_input_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0,
      conversation_count: 0, hours: 0, cost_usd: 0, priced: false,
    };
    bucket.input_tokens += num(r.input_tokens);
    bucket.output_tokens += num(r.output_tokens);
    bucket.cached_input_tokens += num(r.cached_input_tokens);
    bucket.cache_creation_input_tokens += num(r.cache_creation_input_tokens);
    bucket.reasoning_output_tokens += num(r.reasoning_output_tokens);
    bucket.total_tokens += num(r.total_tokens);
    bucket.conversation_count += num(r.conversation_count) || 1;
    bucket.hours += 1;
    const priced = priceRow({ source, model, input_tokens: num(r.input_tokens), output_tokens: num(r.output_tokens), cached_input_tokens: num(r.cached_input_tokens), cache_creation_input_tokens: num(r.cache_creation_input_tokens), reasoning_output_tokens: num(r.reasoning_output_tokens) });
    bucket.cost_usd += priced.cost_usd;
    bucket.priced = bucket.priced || priced.priced;
    models.set(`${source}|${model}`, bucket);

    const day = String(r.hour_start || r.hour).slice(0, 10);
    const d = days.get(day) || { date: day, cost_usd: 0, total_tokens: 0 };
    d.cost_usd += priced.cost_usd;
    d.total_tokens += num(r.total_tokens);
    days.set(day, d);

    const src = sources.get(source) || { source, cost_usd: 0, total_tokens: 0, models: 0 };
    src.cost_usd += priced.cost_usd;
    src.total_tokens += num(r.total_tokens);
    src.models += 1;
    sources.set(source, src);

    totalCost += priced.cost_usd;
    totalTokens += num(r.total_tokens);
    cacheRead += num(r.cached_input_tokens);
    cacheCreation += num(r.cache_creation_input_tokens);
  }

  const by_model = [...models.values()].map((b) => ({
    ...b,
    cost_usd: Math.round(b.cost_usd * 1e6) / 1e6,
    cache_hit_rate: (b.cached_input_tokens + b.cache_creation_input_tokens) > 0
      ? Math.round((b.cached_input_tokens / (b.cached_input_tokens + b.cache_creation_input_tokens)) * 1000) / 10
      : null,
  })).sort((a, b) => b.cost_usd - a.cost_usd || b.total_tokens - a.total_tokens);

  const cacheDenom = cacheRead + cacheCreation;
  return {
    generated_at: new Date().toISOString(),
    window: { from, to },
    totals: {
      rows: rows.length,
      cost_usd: Math.round(totalCost * 1e6) / 1e6,
      total_tokens: totalTokens,
      models: by_model.length,
      sources: sources.size,
      cache_read_tokens: cacheRead,
      cache_creation_tokens: cacheCreation,
      cache_hit_rate: cacheDenom ? Math.round((cacheRead / cacheDenom) * 1000) / 10 : null,
      unpriced_models: by_model.filter((m) => !m.priced).map((m) => m.model),
    },
    by_model,
    by_day: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)).map((d) => ({ ...d, cost_usd: Math.round(d.cost_usd * 1e6) / 1e6 })),
    by_source: [...sources.values()].sort((a, b) => b.cost_usd - a.cost_usd).map((s) => ({ ...s, cost_usd: Math.round(s.cost_usd * 1e6) / 1e6 })),
  };
}

module.exports = { aggregateUsage, readQueueRows, queuePath };
