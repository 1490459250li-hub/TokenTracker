"use strict";

// yield-engine.js — "did this AI session actually produce anything?" (P4).
// It joins the money each session spent (session-analytics rows) to the git
// attribution (git-outcomes, keyed by session_hash) and sorts every session into
// four honest buckets, then expresses them as one ROI number: what fraction of
// dollars landed in the trunk vs. what is at risk in reverted/abandoned work.
//
// Buckets:
//   productive : a commit overlapping only this session landed and was not
//                reverted  -> the money is realized.
//   reverted   : its attributed commit was later reverted -> spent, landed, undone.
//   abandoned  : it attempted a change (had edits, spent $) but NO commit is
//                attributable to it -> likely never made it to the trunk.
//   ambiguous  : can't judge — pure exploration (no edits), no repo/attribution
//                possible, or a commit overlapped multiple sessions.
//
// The abandoned vs ambiguous split is a heuristic by design: attribution only
// emits a commit when exactly one session overlaps it, so "no outcome" cannot
// distinguish "nothing was committed" from "a commit was shared". We mark each
// session's confidence rather than pretending to certainty.

const os = require("node:os");
const path = require("node:path");

const { buildSessionAnalytics } = require("./session-analytics");
const { buildGitOutcomes } = require("./git-outcomes");

const STATUS = ["productive", "reverted", "abandoned", "ambiguous"];

function withinDayRange(row, from, to) {
  const startDay = String(row?.started_at || row?.ended_at || "").slice(0, 10);
  const endDay = String(row?.ended_at || row?.started_at || "").slice(0, 10);
  if (from && (!endDay || endDay < from)) return false;
  if (to && (!startDay || startDay > to)) return false;
  return true;
}

function outcomesByHash(outcomes) {
  const map = new Map();
  for (const o of outcomes || []) {
    const key = o?.session_hash;
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(o);
  }
  return map;
}

function classifySession(session, attributed, opts) {
  const hadEdits = (Number(session.edit_turns) || 0) > 0 || Boolean(session.productive);
  const cost = Number(session.cost_usd) || 0;
  const minAbandonCost = Number.isFinite(Number(opts.minAbandonCost)) ? Number(opts.minAbandonCost) : 0;
  const anyAccepted = attributed.some((o) => o.accepted === true);
  const anyReverted = attributed.some((o) => o.status === "reverted" || o.accepted === false);

  if (anyAccepted) return { status: "productive", confidence: "attributed", commits: attributed.filter((o) => o.accepted).map((o) => o.commit_hash) };
  if (attributed.length && anyReverted) return { status: "reverted", confidence: "attributed", commits: attributed.map((o) => o.commit_hash) };
  if (hadEdits && cost >= minAbandonCost) return { status: "abandoned", confidence: "heuristic", commits: [] };
  return { status: "ambiguous", confidence: "unknown", commits: [] };
}

const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);
const pct = (n) => (Number.isFinite(n) ? Math.round(n * 1000) / 10 : null);

// Pure: sessions + git outcomes -> ROI rollup. Deterministic and unit-testable.
function buildYield(sessions, outcomes, options = {}) {
  const from = String(options.from || "");
  const to = String(options.to || "");
  const inRange = (row) => withinDayRange(row, from, to);

  const byHash = outcomesByHash(outcomes);
  const spend = Object.fromEntries(STATUS.map((s) => [s, 0]));
  const counts = Object.fromEntries(STATUS.map((s) => [s, 0]));
  const models = new Map();
  const sessionsOut = [];
  let totalCost = 0;
  let attributableCost = 0; // sessions we could join to git at all (productive/reverted)

  for (const session of sessions || []) {
    if (!inRange(session)) continue;
    const cost = Number(session.cost_usd) || 0;
    const attributed = byHash.get(session.session_hash) || [];
    const { status, confidence, commits } = classifySession(session, attributed, options);
    spend[status] += cost;
    counts[status] += 1;
    totalCost += cost;
    if (status === "productive" || status === "reverted") attributableCost += cost;

    const model = session.model || "unknown";
    const m = models.get(model) || { model, total_cost_usd: 0, productive_cost_usd: 0, at_risk_cost_usd: 0, sessions: 0, ...Object.fromEntries(STATUS.map((s) => [`${s}_sessions`, 0])) };
    m.sessions += 1;
    m.total_cost_usd += cost;
    m[`${status}_sessions`] += 1;
    if (status === "productive") m.productive_cost_usd += cost;
    if (status === "reverted" || status === "abandoned") m.at_risk_cost_usd += cost;
    models.set(model, m);

    if (status === "abandoned" || status === "reverted") {
      sessionsOut.push({ model, status, cost_usd: r2(cost), session_started_at: session.started_at || null, commits });
    }
  }

  const atRisk = spend.reverted + spend.abandoned;
  const realizedRoi = totalCost > 0 ? spend.productive / totalCost : null;

  const by_model = [...models.values()].map((m) => ({
    ...m,
    total_cost_usd: r2(m.total_cost_usd),
    productive_cost_usd: r2(m.productive_cost_usd),
    at_risk_cost_usd: r2(m.at_risk_cost_usd),
    roi: m.total_cost_usd > 0 ? pct(m.productive_cost_usd / m.total_cost_usd) : null,
  })).sort((a, b) => b.total_cost_usd - a.total_cost_usd);

  sessionsOut.sort((a, b) => b.cost_usd - a.cost_usd);

  return {
    generated_at: new Date().toISOString(),
    window: { from, to },
    provenance: {
      source: "git-attribution",
      confidence: "heuristic",
      methodology: "productive/reverted need a commit overlapping exactly one session; abandoned = edits+$ but no attributable commit (may under-count shared commits); ambiguous otherwise.",
      coverage: { sessions: counts.productive + counts.reverted + counts.abandoned + counts.ambiguous, attributable_cost_pct: totalCost > 0 ? pct(attributableCost / totalCost) : null },
    },
    totals: {
      sessions: Object.values(counts).reduce((a, b) => a + b, 0),
      total_cost_usd: r2(totalCost),
      by_status: STATUS.reduce((acc, s) => { acc[s] = { sessions: counts[s], cost_usd: r2(spend[s]) }; return acc; }, {}),
    },
    roi: {
      realized_pct: pct(realizedRoi),
      value_at_risk_usd: r2(atRisk),
      productive_usd: r2(spend.productive),
      reverted_usd: r2(spend.reverted),
      abandoned_usd: r2(spend.abandoned),
      ambiguous_usd: r2(spend.ambiguous),
    },
    by_model,
    worst_sessions: sessionsOut.slice(0, Number(options.top) || 15),
  };
}

async function computeYield(options = {}) {
  const home = options.home || os.homedir();
  const force = Boolean(options.force);
  const sessions = options.sessions || (await buildSessionAnalytics({ home, force }));
  const outcomes = options.outcomes || (await buildGitOutcomes(sessions, { home, force, maxAgeDays: options.maxAgeDays || 90 }));
  return buildYield(sessions, outcomes, options);
}

module.exports = { computeYield, buildYield, classifySession, STATUS };
