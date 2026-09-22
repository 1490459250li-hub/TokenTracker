"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// API plan accounting — feeds the Limits page cards and the pet health bars.
//
// Three "API direct" sources are accounted from the api-shim usage log
// (~/.tokentracker/api-shim/usage.jsonl, written by src/api-shim/server.js):
//
//   deepseek-api  — pay-as-you-go. Budget line (USD) is user-set; spend is
//                   computed with the shared pricing engine (which already
//                   knows DeepSeek's peak/off-peak schedule). Balance comes
//                   from the official GET /user/balance endpoint.
//   mimo-api      — monthly Credits pool (Token Plan). Token→Credit
//                   multipliers per model are user-configurable (official:
//                   Omni 1x, Pro 2x@256k/4x@1M). Plan presets ship with the
//                   card; totals are user-editable.
//   sensenova-api — request-count quota per rolling 5-hour window per model
//                   (Token Plan public beta: 1,500 calls / 5h for flash-lite,
//                   150 for deepseek-v4-flash). Counts come straight from the
//                   shim log.
//
// All settings live in ~/.tokentracker/api-shim/budgets.json (user-editable in
// the Limits page via /functions/tokentracker-api-plans). Zero new deps: cost
// reuses src/lib/pricing, everything else is stdlib.
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("node:fs/promises");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { computeRowCost, ensurePricingLoaded } = require("./pricing");

const SHIM_DIR = () => path.join(os.homedir(), ".tokentracker", "api-shim");
const USAGE_LOG = () => path.join(SHIM_DIR(), "usage.jsonl");
const BUDGETS_FILE = () => path.join(SHIM_DIR(), "budgets.json");
const SHIM_CONFIG_FILE = () => path.join(SHIM_DIR(), "config.json");

const MIMO_PLAN_PRESETS = [
  { label: "Lite", credits: 60_000_000 },
  { label: "Standard", credits: 200_000_000 },
  { label: "Pro", credits: 700_000_000 },
  { label: "Max", credits: 1_600_000_000 },
];
const MIMO_DEFAULT_MULTIPLIER = 1;
const SENSENOVA_DEFAULT_WINDOW_HOURS = 5;
const SENSENOVA_DEFAULT_CALLS = 1500;
// pet 血条：超过该时长的模型视为闲置并隐藏
const IDLE_HIDE_MS = 10 * 60 * 1000;

async function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) || fallback;
  } catch {
    return fallback;
  }
}

async function readBudgets() {
  const budgets = await readJsonSafe(BUDGETS_FILE(), {});
  return {
    deepseek: {
      budgetUsd: Number(budgets.deepseek?.budgetUsd) || 0,
      resetDay: Number(budgets.deepseek?.resetDay) || 1,
    },
    mimo: {
      planCredits: Number(budgets.mimo?.planCredits) || 0,
      planLabel: String(budgets.mimo?.planLabel || ""),
      // token→Credit 倍率：默认 1x；可按模型覆盖（如 "mimo-v2.5-pro": 2）
      multipliers: budgets.mimo?.multipliers && typeof budgets.mimo.multipliers === "object"
        ? budgets.mimo.multipliers
        : { default: MIMO_DEFAULT_MULTIPLIER },
    },
    sensenova: {
      windowHours: Number(budgets.sensenova?.windowHours) || SENSENOVA_DEFAULT_WINDOW_HOURS,
      // 通用积分池（非 Flash-Lite 模型的调用次数上限）
      callsPerWindow: Number(budgets.sensenova?.callsPerWindow) || SENSENOVA_DEFAULT_CALLS,
      // Flash-Lite 专属积分池（模型名含 flash-lite 的调用次数上限）
      flashliteCallsPerWindow: Number(budgets.sensenova?.flashliteCallsPerWindow) || SENSENOVA_DEFAULT_CALLS,
      perModel: budgets.sensenova?.perModel && typeof budgets.sensenova.perModel === "object"
        ? budgets.sensenova.perModel
        : {},
    },
    presets: { mimo: MIMO_PLAN_PRESETS },
  };
}

async function writeBudgets(next) {
  const file = BUDGETS_FILE();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function shimApiKeyFor(config, upstreamKey) {
  const upstream = config?.upstreams?.[upstreamKey];
  return String(upstream?.api_key || "").trim();
}

// Aggregate the shim usage log once; consumers pick their slices.
async function aggregateShimUsage(logPath) {
  let text;
  try {
    text = await fs.readFile(logPath, "utf8");
  } catch {
    return { events: [], lastActivityBySource: {}, lastActivityByModel: {} };
  }
  const events = [];
  const lastActivityBySource = {};
  const lastActivityByModel = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = Date.parse(raw.ts);
    if (!Number.isFinite(ts)) continue;
    const source = String(raw.source || "").toLowerCase();
    const model = String(raw.model || "unknown");
    events.push({ ...raw, ts, source, model });
    if (!lastActivityBySource[source] || ts > lastActivityBySource[source]) {
      lastActivityBySource[source] = ts;
    }
    const modelKey = `${source}/${model}`;
    if (!lastActivityByModel[modelKey] || ts > lastActivityByModel[modelKey]) {
      lastActivityByModel[modelKey] = ts;
    }
  }
  return { events, lastActivityBySource, lastActivityByModel };
}

function shimConfigured(config, upstreamKey) {
  const upstream = config?.upstreams?.[upstreamKey];
  return Boolean(upstream && String(upstream.api_key || "").trim());
}

function buildMimoCard(events, budgets, nowMs) {
  const multipliers = budgets.mimo.multipliers || {};
  const defaultMultiplier = Number(multipliers.default) || MIMO_DEFAULT_MULTIPLIER;
  const monthStart = new Date(nowMs);
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthStartMs = monthStart.getTime();

  let creditsUsed = 0;
  let tokensThisMonth = 0;
  const byModel = {};
  // 迷你趋势线：本月按日的 Credits 消耗（本地时区，到今天为止）
  const today = new Date(nowMs);
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const dailyCredits = new Array(daysInMonth).fill(0);
  for (const ev of events) {
    if (ev.source !== "mimo-api" || ev.ts < monthStartMs) continue;
    const multiplier = Number(multipliers[ev.model] ?? defaultMultiplier) || defaultMultiplier;
    const credits = (Number(ev.total_tokens) || 0) * multiplier;
    creditsUsed += credits;
    dailyCredits[new Date(ev.ts).getDate() - 1] += credits;
    tokensThisMonth += Number(ev.total_tokens) || 0;
    const entry = byModel[ev.model] || { credits: 0, tokens: 0 };
    entry.credits += credits;
    entry.tokens += Number(ev.total_tokens) || 0;
    byModel[ev.model] = entry;
  }
  const planCredits = Number(budgets.mimo.planCredits) || 0;
  return {
    plan_label: budgets.mimo.planLabel || null,
    plan_presets: budgets.presets.mimo,
    plan_credits: planCredits,
    credits_used: Math.round(creditsUsed),
    daily_credits: dailyCredits.map((v) => Math.round(v)),
    credits_remaining: planCredits > 0 ? Math.max(0, planCredits - Math.round(creditsUsed)) : null,
    tokens_this_month: tokensThisMonth,
    by_model: byModel,
    unit: "credits",
    reset: "monthly",
  };
}

function buildSenseNovaCard(events, budgets, nowMs) {
  const windowHours = Number(budgets.sensenova.windowHours) || SENSENOVA_DEFAULT_WINDOW_HOURS;
  const windowMs = windowHours * 60 * 60 * 1000;
  const byModel = {};
  // 迷你趋势线：当前窗口内按 30 分钟分桶的调用次数
  const bucketMs = 30 * 60 * 1000;
  const bucketCount = Math.max(1, Math.ceil(windowMs / bucketMs));
  const callsBuckets = new Array(bucketCount).fill(0);
  for (const ev of events) {
    if (ev.source !== "sensenova-api") continue;
    const model = ev.model;
    const entry = byModel[model] || { calls: 0, tokens: 0, last_ts: 0, pool: null };
    if (ev.ts >= nowMs - windowMs) {
      entry.calls += 1;
      const bucket = Math.min(bucketCount - 1, Math.floor((nowMs - ev.ts) / bucketMs));
      callsBuckets[bucketCount - 1 - bucket] += 1;
    }
    entry.tokens += Number(ev.total_tokens) || 0;
    if (ev.ts > entry.last_ts) entry.last_ts = ev.ts;
    // 归属积分池：模型名含 flash-lite 走专属池，其余走通用池
    entry.pool = /flash-lite/i.test(model) ? "flashlite" : "general";
    byModel[model] = entry;
  }
  const models = Object.entries(byModel).map(([model, entry]) => {
    // 限额优先级：perModel 手动覆盖 > 所属池默认值
    const manual = Number(budgets.sensenova.perModel?.[model]);
    const poolLimit = entry.pool === "flashlite"
      ? (Number(budgets.sensenova.flashliteCallsPerWindow) || SENSENOVA_DEFAULT_CALLS)
      : (Number(budgets.sensenova.callsPerWindow) || SENSENOVA_DEFAULT_CALLS);
    return {
      model,
      pool: entry.pool,
      calls_in_window: entry.calls,
      limit: Number.isFinite(manual) && manual > 0 ? manual : poolLimit,
      tokens: entry.tokens,
      last_activity_ts: entry.last_ts || null,
      // 宠物血条：窗口内仍有调用 = 活跃
      active_in_window: entry.last_ts >= nowMs - windowMs,
    };
  });
  return {
    configured: models.length > 0,
    window_hours: windowHours,
    unit: "calls",
    calls_trend_30m: callsBuckets,
    pools: {
      general: Number(budgets.sensenova.callsPerWindow) || SENSENOVA_DEFAULT_CALLS,
      flashlite: Number(budgets.sensenova.flashliteCallsPerWindow) || SENSENOVA_DEFAULT_CALLS,
    },
    models,
  };
}

async function buildDeepSeekCard(events, budgets, nowMs) {
  const dayStart = new Date(nowMs);
  dayStart.setUTCHours(0, 0, 0, 0);
  let spendToday = 0;
  let tokensToday = 0;
  let requestsToday = 0;
  let lastActivityTs = 0;
  for (const ev of events) {
    if (ev.source !== "deepseek-api") continue;
    if (ev.ts > lastActivityTs) lastActivityTs = ev.ts;
    if (ev.ts < dayStart.getTime()) continue;
    const row = {
      source: "deepseek-api",
      model: ev.model,
      hour_start: new Date(ev.ts).toISOString(),
      input_tokens: Number(ev.input_tokens) || 0,
      output_tokens: Number(ev.output_tokens) || 0,
      cached_input_tokens: Number(ev.cached_input_tokens) || 0,
      cache_creation_input_tokens: Number(ev.cache_creation_input_tokens) || 0,
      reasoning_output_tokens: Number(ev.reasoning_output_tokens) || 0,
    };
    try {
      spendToday += computeRowCost(row);
    } catch {
      /* pricing unavailable — spend stays understated rather than failing */
    }
    tokensToday += Number(ev.total_tokens) || 0;
    requestsToday += 1;
  }
  const budgetUsd = Number(budgets.deepseek.budgetUsd) || 0;
  // 迷你趋势线：今天按小时的花费（本地时区 24 桶，当前小时为最后非空桶）
  const hourlySpend = new Array(24).fill(0);
  for (const ev of events) {
    if (ev.source !== "deepseek-api") continue;
    if (ev.ts < dayStart.getTime()) continue;
    const row = {
      source: "deepseek-api",
      model: ev.model,
      hour_start: new Date(ev.ts).toISOString(),
      input_tokens: Number(ev.input_tokens) || 0,
      output_tokens: Number(ev.output_tokens) || 0,
      cached_input_tokens: Number(ev.cached_input_tokens) || 0,
      cache_creation_input_tokens: Number(ev.cache_creation_input_tokens) || 0,
      reasoning_output_tokens: Number(ev.reasoning_output_tokens) || 0,
    };
    try {
      hourlySpend[new Date(ev.ts).getHours()] += computeRowCost(row);
    } catch {
      /* pricing unavailable */
    }
  }
  // 官方余额（best-effort：key 缺失/网络失败时保持 null，卡片显示占位）
  let balance = null;
  let balanceCurrency = null;
  const apiKey = shimApiKeyFor(this_config, "deepseek");
  if (apiKey) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const res = await fetch("https://api.deepseek.com/user/balance", {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json();
        balance = Number(data?.balance_infos?.[0]?.total_balance);
        balanceCurrency = String(data?.balance_infos?.[0]?.currency || "") || null;
        if (!Number.isFinite(balance)) balance = null;
      }
    } catch {
      /* keep null */
    }
  }
  return {
    configured: Boolean(apiKey) || tokensToday > 0,
    balance,
    balance_currency: balanceCurrency,
    budget_usd: budgetUsd || null,
    spend_today_usd: Math.round(spendToday * 1e6) / 1e6,
    hourly_spend_usd: hourlySpend.map((v) => Math.round(v * 1e6) / 1e6),
    tokens_today: tokensToday,
    requests_today: requestsToday,
    last_activity_ts: lastActivityTs || null,
  };
}

// The shim config is read lazily so card builders can check key presence
// without re-reading the file per card.
let this_config = null;

/**
 * Build the apiPlans payload embedded into the usage-limits response.
 * Never throws: any failure degrades to `configured: false` cards.
 */
async function buildApiPlansPayload() {
  const nowMs = Date.now();
  this_config = await readJsonSafe(SHIM_CONFIG_FILE(), {});
  const budgets = await readBudgets();
  try {
    await ensurePricingLoaded().catch(() => {});
  } catch {
    /* pricing is optional for the token counters */
  }
  const { events, lastActivityBySource } = await aggregateShimUsage(USAGE_LOG());

  const deepseek = await buildDeepSeekCard(events, budgets, nowMs);
  const mimo = buildMimoCard(events, budgets, nowMs);
  const sensenova = buildSenseNovaCard(events, budgets, nowMs);

  const idleHideMs = IDLE_HIDE_MS;
  return {
    fetched_at: new Date(nowMs).toISOString(),
    idle_hide_ms: idleHideMs,
    plans: {
      deepseek: deepseek,
      mimo: {
        ...mimo,
        configured: Boolean(
          shimConfigured(this_config, "mimo") || budgets.mimo.planCredits > 0,
        ),
        last_activity_ts: lastActivityBySource["mimo-api"] || null,
      },
      sensenova: sensenova,
    },
    last_activity_by_source: lastActivityBySource,
  };
}

module.exports = {
  buildApiPlansPayload,
  readBudgets,
  writeBudgets,
  BUDGETS_FILE,
  USAGE_LOG,
};
