"use strict";

// overview.js — a copy-paste plain-text period report (P5, CodeBurn-style
// `overview --no-color`). Reuses session-analytics for the numbers; never emits
// ANSI color, so the output drops cleanly into a PR, Slack, or 周报. ROI and the
// optimize "savings so far" line are optional add-ons (off by default to keep
// the hot path free of git directory walking / TCC prompts).

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildSessionAnalytics, summarizeSessions } = require("./session-analytics");
const { aggregateUsage } = require("./usage-queue");
const { tokensToEquivalents, headlineEquivalent, fmt } = require("./fun-equivalents");

function withinDayRange(row, from, to) {
  const startDay = String(row?.started_at || row?.ended_at || "").slice(0, 10);
  const endDay = String(row?.ended_at || row?.started_at || "").slice(0, 10);
  if (from && (!endDay || endDay < from)) return false;
  if (to && (!startDay || startDay > to)) return false;
  return true;
}

function firstOfMonth(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function isoDay(d = new Date()) { return d.toISOString().slice(0, 10); }

// Estimated savings the optimize/act loop recorded (sum of each applied fix's
// est_cost_usd), read straight from the change log written by act.
function readOptimizeSavings(home) {
  try {
    const log = JSON.parse(fs.readFileSync(path.join(home, ".tokentracker", "optimize", "changes.json"), "utf8"));
    let est = 0;
    let fixes = 0;
    for (const batch of log.batches || []) {
      for (const e of batch.entries || []) {
        if (e.result === "applied") { est += Number(e.est_cost_usd) || 0; fixes += 1; }
      }
    }
    return { estimated_usd: Math.round(est * 100) / 100, fixes_applied: fixes };
  } catch {
    return null;
  }
}

function buildOverview(sessions, options = {}) {
  const from = String(options.from || "");
  const to = String(options.to || "");
  const summary = summarizeSessions(sessions, { from, to, includeSessions: false });
  const t = summary.summary || {};

  let outputTokens = 0;
  let cacheRead = 0;
  let cacheCreation = 0;
  for (const row of sessions || []) {
    if (!withinDayRange(row, from, to)) continue;
    const tk = row.tokens || {};
    outputTokens += Number(tk.output_tokens) || 0;
    cacheRead += Number(tk.cached_input_tokens) || 0;
    cacheCreation += Number(tk.cache_creation_input_tokens) || 0;
  }
  const cacheDenom = cacheRead + cacheCreation;
  const top = (summary.by_model || []).slice(0, 5).map((m) => ({
    model: m.model,
    cost_usd: Math.round((m.cost_usd || 0) * 100) / 100,
    total_tokens: m.total_tokens || 0,
    one_shot_rate: m.one_shot_rate != null ? Math.round(m.one_shot_rate * 1000) / 10 : null,
  }));

  return {
    window: { from, to },
    sessions: summary.session_count || 0,
    total_tokens: t.total_tokens || 0,
    output_tokens: outputTokens,
    cost_usd: Math.round((t.cost_usd || 0) * 100) / 100,
    productive_sessions: t.productive_sessions || 0,
    one_shot_sessions: t.one_shot_sessions || 0,
    retries: t.retries || 0,
    cache_hit_rate: cacheDenom ? Math.round((cacheRead / cacheDenom) * 1000) / 10 : null,
    top_models: top,
    equivalents: tokensToEquivalents(t.total_tokens || 0, outputTokens),
    share_headline: headlineEquivalent(tokensToEquivalents(t.total_tokens || 0, outputTokens)),
    roi: options.roi || null,
    savings: options.savings || null,
  };
}

const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const pct = (n) => (n == null ? "n/a" : `${n}%`);

// Plain text by default; markdown=true adds # / ** / | formatting for docs.
function renderOverview(d, { markdown = false } = {}) {
  const out = [];
  const title = `TokenTracker 概览 · ${d.window.from || "全部"}${d.window.to ? ` → ${d.window.to}` : ""}`;
  out.push(markdown ? `# ${title}` : title);
  if (!d.sessions) { out.push(markdown ? "\n_该窗口内没有会话数据。_" : "\n该窗口内没有会话数据。"); return `${out.join("\n")}\n`; }
  out.push("");
  out.push(`${markdown ? "**" : ""}会话 ${fmt(d.sessions)}${markdown ? "**" : ""}  |  ${usd(d.cost_usd)}  |  ${fmt(d.total_tokens)} tokens`);
  out.push(`一次改对(产出会话): ${pct(d.sessions ? Math.round((d.one_shot_sessions / d.sessions) * 1000) / 10 : null)}  ·  重试: ${d.retries}  ·  缓存命中: ${pct(d.cache_hit_rate)}`);
  out.push("");
  out.push(markdown ? "**用量前 5 模型**" : "用量前 5 模型:");
  for (const m of d.top_models) {
    out.push(markdown
      ? `- \`${m.model}\` — ${usd(m.cost_usd)} · ${fmt(m.total_tokens)} tokens · 一次到位 ${pct(m.one_shot_rate)}`
      : `  ${m.model.padEnd(28).slice(0, 28)} ${usd(m.cost_usd).padStart(9)}  ${fmt(m.total_tokens).padStart(9)} tok  ${String(pct(m.one_shot_rate)).padStart(6)}`);
  }
  out.push("");
  const e = d.equivalents;
  out.push(markdown ? `**趣味当量**：${d.share_headline}（≈ ${fmt(e.code_lines)} 行代码 / ${fmt(e.words_written)} 词 / ${fmt(e.pages)} 页 / ${fmt(e.books)} 本书 / ${fmt(e.earth_laps)} 圈地球）`
    : `趣味当量: ${d.share_headline}（≈ ${fmt(e.code_lines)} 行代码 / ${fmt(e.words_written)} 词 / ${fmt(e.pages)} 页 / ${fmt(e.books)} 本书 / ${fmt(e.earth_laps)} 圈地球）`);
  if (d.roi) {
    out.push("");
    out.push(markdown ? `**ROI**：${pct(d.roi.realized_pct)} 的花费合进了主干；在险 ${usd(d.roi.value_at_risk_usd)}（reverted+abandoned）。`
      : `ROI: ${pct(d.roi.realized_pct)} 的花费合进了主干；在险 ${usd(d.roi.value_at_risk_usd)}（reverted+abandoned）。`);
  }
  if (d.savings && (d.savings.fixes_applied || d.savings.estimated_usd)) {
    out.push("");
    out.push(markdown ? `**optimize 已应用 ${d.savings.fixes_applied} 项修复，预估省 ${usd(d.savings.estimated_usd)}**`
      : `optimize: 已应用 ${d.savings.fixes_applied} 项修复，预估省 ${usd(d.savings.estimated_usd)}（满 3 天后可 act report 看实际）`);
  }
  out.push("");
  out.push(markdown ? "_由 TokenTracker 生成_" : "— by TokenTracker");
  return `${out.join("\n")}\n`;
}

// Queue-based overview (all providers, incl. API aggregators like workbuddy).
// Produces the same shape the dashboard views consume, so the frontend needs no
// change; cache-hit is blanked when the source never reports cache writes.
function buildOverviewFromQueue(agg, options = {}) {
  const outputTokens = (agg.by_model || []).reduce((s, m) => s + (m.output_tokens || 0), 0);
  const cacheHit = agg.totals.cache_creation_tokens > 0 ? agg.totals.cache_hit_rate : null;
  const eq = tokensToEquivalents(agg.totals.total_tokens, outputTokens);
  return {
    window: agg.window,
    sessions: agg.totals.rows,
    total_tokens: agg.totals.total_tokens,
    output_tokens: outputTokens,
    cost_usd: Math.round(agg.totals.cost_usd * 100) / 100,
    productive_sessions: null,
    one_shot_sessions: null,
    retries: null,
    cache_hit_rate: cacheHit,
    top_models: (agg.by_model || []).slice(0, 5).map((m) => ({
      model: m.model,
      cost_usd: Math.round(m.cost_usd * 100) / 100,
      total_tokens: m.total_tokens,
      one_shot_rate: null,
      priced: m.priced,
    })),
    equivalents: eq,
    share_headline: headlineEquivalent(eq),
    roi: options.roi || null,
    savings: options.savings || null,
  };
}

async function buildOverviewData(options = {}) {
  const home = options.home || os.homedir();
  const sessions = options.sessions || (await buildSessionAnalytics({ home, force: Boolean(options.force) }));
  const savings = options.includeSavings === false ? null : readOptimizeSavings(home);
  return { buildOverview, renderOverview, firstOfMonth, isoDay, data: buildOverview(sessions, { ...options, savings }), sessions, savings };
}

module.exports = {
  buildOverview,
  buildOverviewFromQueue,
  renderOverview,
  readOptimizeSavings,
  firstOfMonth,
  isoDay,
  buildOverviewData,
};
