"use strict";

// compare-engine.js — "which model is actually better for YOUR work" (P3).
// It deliberately does NOT recompute one-shot / retries / cost-per-edit: those
// already live in session-analytics.summarizeSessions, computed from the same
// local logs with the repo's locked-down model-attribution rules. Rebuilding
// them here would drift from the dashboard. compare only ADDS the per-model
// cache-hit roll-up (summarize drops cache tokens) and turns the numbers into a
// routing recommendation.

const os = require("node:os");

const { buildSessionAnalytics, summarizeSessions } = require("./session-analytics");

// cache_read vs cache_creation per model, straight from each session's
// model_usage rows (already normalized). Falls back to the session-level token
// bucket when a session has no model_usage sidecar.
function rollupCacheByModel(sessions, withinRange) {
  const map = new Map(); // model -> {cached, creation}
  const add = (model, cached, creation) => {
    const key = model || "unknown";
    const cur = map.get(key) || { cached: 0, creation: 0 };
    cur.cached += Number(cached) || 0;
    cur.creation += Number(creation) || 0;
    map.set(key, cur);
  };
  for (const row of sessions || []) {
    if (!withinRange(row)) continue;
    const usage = Array.isArray(row.model_usage) ? row.model_usage : null;
    if (usage && usage.length) {
      for (const mu of usage) add(mu.model, mu.cached_input_tokens, mu.cache_creation_input_tokens);
    } else {
      const tokens = row.tokens || row;
      add(row.model, tokens.cached_input_tokens, tokens.cache_creation_input_tokens);
    }
  }
  return map;
}

function withinDayRange(row, from, to) {
  const startDay = String(row?.started_at || row?.ended_at || "").slice(0, 10);
  const endDay = String(row?.ended_at || row?.started_at || "").slice(0, 10);
  if (from && (!endDay || endDay < from)) return false;
  if (to && (!startDay || startDay > to)) return false;
  return true;
}

const round4 = (n) => (Number.isFinite(n) ? Math.round(n * 10000) / 10000 : null);
const money4 = (n) => (Number.isFinite(n) ? Math.round(n * 100000) / 100000 : null);

// Pure: given session rows, produce ranked model comparison + recommendation.
function buildComparison(sessions, options = {}) {
  const from = String(options.from || "");
  const to = String(options.to || "");
  const minEdits = Number.isFinite(Number(options.minEdits)) ? Math.max(1, Number(options.minEdits)) : 3;

  const summary = summarizeSessions(sessions, { from, to, includeSessions: false });
  const inRange = (row) => withinDayRange(row, from, to);
  const cache = rollupCacheByModel(sessions, inRange);

  const rows = (summary.by_model || []).map((r) => {
    const c = cache.get(r.model) || { cached: 0, creation: 0 };
    const cacheDenom = c.cached + c.creation;
    const retryRate = r.edit_turns ? Math.min(1, (r.retries || 0) / r.edit_turns) : null;
    return {
      model: r.model,
      sessions: r.sessions || 0,
      edit_turns: r.edit_turns || 0,
      one_shot_rate: round4(r.one_shot_rate),
      first_pass_sessions: r.one_shot_sessions || 0,
      productive_sessions: r.productive_sessions || 0,
      retry_rate: round4(retryRate),
      retries: r.retries || 0,
      cost_per_edit: money4(r.cost_per_edit),
      tokens_per_edit: r.tokens_per_edit != null ? Math.round(r.tokens_per_edit) : null,
      cost_usd: money4(r.cost_usd),
      total_tokens: r.total_tokens || 0,
      cache_read_tokens: c.cached,
      cache_creation_tokens: c.creation,
      cache_hit_rate: cacheDenom ? round4(c.cached / cacheDenom) : null,
      enough_data: (r.edit_turns || 0) >= minEdits,
    };
  });

  const eligible = rows.filter((r) => r.enough_data);
  const insufficient = rows.filter((r) => !r.enough_data).map((r) => r.model);
  const recommendation = buildRecommendation(eligible);

  return {
    generated_at: new Date().toISOString(),
    window: { from, to },
    provenance: { source: "local-session-log", confidence: "mixed", note: "one-shot/retry/cost reuse session-analytics; cache-hit is added here; retry_rate is inferred (retries are attributed to each session's primary model only)." },
    summary: {
      models_total: rows.length,
      models_ranked: eligible.length,
      sessions: summary.session_count ?? summary.summary?.sessions ?? 0,
      insufficient_data: insufficient,
    },
    rows,
    recommendation,
  };
}

function clamp01(n) { return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null; }

function buildRecommendation(eligible) {
  if (!eligible.length) {
    return { headline: "样本还太少，先攒够几个有编辑产出的会话再比。", picks: {}, scores: [] };
  }
  const scored = eligible.map((r) => {
    const oneshot = clamp01(r.one_shot_rate) ?? 0;
    const reliability = r.retry_rate == null ? 0.5 : 1 - clamp01(r.retry_rate);
    const cache = clamp01(r.cache_hit_rate) ?? 0;
    return {
      model: r.model,
      one_shot: oneshot,
      reliability,
      cache,
      cost_per_edit: r.cost_per_edit,
      score: Math.round((0.4 * oneshot + 0.2 * reliability + 0.2 * cache + 0.2 * affordability(eligible, r)) * 1000) / 1000,
    };
  }).sort((a, b) => b.score - a.score);

  const bestBy = (fn) => eligible.slice().sort((a, b) => (fn(b) ?? -1) - (fn(a) ?? -1))[0]?.model;
  const cheapest = eligible.slice().filter((r) => Number.isFinite(r.cost_per_edit)).sort((a, b) => a.cost_per_edit - b.cost_per_edit)[0]?.model;

  const winner = scored[0]?.model;
  return {
    headline: `综合最适合你的是 ${winner}（一次到位+可靠+缓存命中+成本的加权分 ${scored[0]?.score ?? "-"}）。`,
    picks: {
      best_overall: winner,
      best_one_shot: bestBy((r) => r.one_shot_rate),
      lowest_retry: bestBy((r) => (r.retry_rate == null ? -1 : 1 - r.retry_rate)),
      best_cache_hit: bestBy((r) => r.cache_hit_rate),
      cheapest_per_edit: cheapest,
    },
    routing: buildRouting(scored, cheapest),
    scores: scored,
  };
}

function affordability(eligible, row) {
  const priced = eligible.map((r) => r.cost_per_edit).filter((n) => Number.isFinite(n) && n > 0);
  if (!priced.length) return 0.5;
  const min = Math.min(...priced);
  if (!Number.isFinite(row.cost_per_edit) || row.cost_per_edit <= 0) return 0;
  return clamp01(min / row.cost_per_edit) ?? 0;
}

function buildRouting(scored, cheapest) {
  const out = [];
  const byModel = (m) => scored.find((s) => s.model === m);
  if (scored[0]) out.push(`主力/要一次改对：用 ${scored[0].model}（综合分最高）。`);
  if (cheapest && cheapest !== scored[0]?.model) {
    const cpe = (byModel(cheapest) && byModel(cheapest).cost_per_edit != null) ? `$${byModel(cheapest).cost_per_edit}` : "";
    out.push(`探索/大量试错：用 ${cheapest}（每次改动成本最低 ${cpe}），省下的钱交给主力做收尾。`);
  }
  const cacheChamp = scored.slice().sort((a, b) => b.cache - a.cache)[0];
  if (cacheChamp && cacheChamp.cache > 0.6) out.push(`${cacheChamp.model} 缓存命中率 ${Math.round(cacheChamp.cache * 100)}%，适合长上下文反复迭代。`);
  return out;
}

// Queue-based cross-model compare (all providers). Ranks by cost per 1M tokens
// and shows each model's share of your spend. Quality metrics (one-shot/retry)
// need session transcripts, which API aggregators don't emit, so they're null.
function compareFromQueue(agg) {
  const total = agg.totals.cost_usd || 0;
  const rows = (agg.by_model || []).map((m) => {
    const per1m = m.total_tokens > 0 ? (m.cost_usd / m.total_tokens) * 1_000_000 : null;
    return {
      model: m.model,
      source: m.source,
      total_tokens: m.total_tokens,
      cost_usd: Math.round(m.cost_usd * 1e6) / 1e6,
      cost_per_1m: per1m == null ? null : Math.round(per1m * 100) / 100,
      share_pct: total > 0 ? Math.round((m.cost_usd / total) * 1000) / 10 : null,
      cache_hit_rate: m.cache_creation_input_tokens > 0 ? m.cache_hit_rate : null,
      one_shot_rate: null,
      retry_rate: null,
      priced: m.priced,
      enough_data: m.priced,
    };
  }).sort((a, b) => b.cost_usd - a.cost_usd || b.total_tokens - a.total_tokens);

  const priced = rows.filter((r) => r.priced && r.cost_per_1m != null);
  const cheapest = priced.length ? priced.reduce((a, b) => (a.cost_per_1m <= b.cost_per_1m ? a : b)) : null;
  const priciest = priced.length ? priced.reduce((a, b) => (a.cost_per_1m >= b.cost_per_1m ? a : b)) : null;
  const routing = [];
  if (cheapest) routing.push(`单位成本最低：${cheapest.model}（$${cheapest.cost_per_1m}/1M），适合大批量/低难度任务。`);
  if (priciest && priciest !== cheapest) routing.push(`最贵：${priciest.model}（$${priciest.cost_per_1m}/1M），只留给真正需要它的任务。`);
  return {
    generated_at: new Date().toISOString(),
    source: "usage-queue",
    provenance: { confidence: "measured", note: "成本/占比来自本地 queue；one-shot/重试需会话转录，API 聚合器无此数据。" },
    summary: { models: rows.length, priced: priced.length, unpriced: rows.filter((r) => !r.priced).length },
    rows,
    recommendation: {
      headline: cheapest ? `按量价，${cheapest.model} 最划算。` : "暂无可定价模型。",
      picks: { cheapest_per_1m: cheapest && cheapest.model, priciest_per_1m: priciest && priciest.model },
      routing,
      scores: [],
    },
  };
}

// Async entry: pull the same session rows the dashboard uses, then compare.
async function compareModels(options = {}) {
  const home = options.home || os.homedir();
  const sessions = options.sessions || (await buildSessionAnalytics({ home, force: Boolean(options.force) }));
  return buildComparison(sessions, options);
}

module.exports = {
  buildComparison,
  compareFromQueue,
  compareModels,
  rollupCacheByModel,
  summarizeSessions,
};
