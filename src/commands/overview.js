"use strict";

const { buildSessionAnalytics } = require("../lib/session-analytics");
const { buildOverview, renderOverview, readOptimizeSavings, firstOfMonth, isoDay } = require("../lib/overview");
const { computeYield } = require("../lib/yield-engine");

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}
function numOpt(args, name) {
  const raw = option(args, name);
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function windowFor(args) {
  let from = option(args, "--from");
  const to = option(args, "--to") || isoDay();
  const period = (option(args, "--period") || "").toLowerCase();
  const since = numOpt(args, "--since");
  if (!from && since) {
    const d = new Date(Date.now() - since * 86_400_000);
    from = isoDay(d);
  }
  if (!from) {
    const now = new Date();
    if (period === "day") from = isoDay(now);
    else if (period === "week") from = isoDay(new Date(Date.now() - 6 * 86_400_000));
    else from = firstOfMonth(now); // default: this month
  }
  return { from, to };
}

async function cmdOverview(args = []) {
  const home = option(args, "--home") || undefined;
  const asJson = args.includes("--json");
  const markdown = args.includes("--markdown");
  const { from, to } = windowFor(args);

  const sessions = await buildSessionAnalytics({ home, force: args.includes("--refresh") });
  let roi = null;
  if (args.includes("--with-roi")) {
    const y = await computeYield({ home, from, to, force: args.includes("--refresh") });
    roi = { realized_pct: y.roi.realized_pct, value_at_risk_usd: y.roi.value_at_risk_usd, by_status: y.totals.by_status };
  }
  const savings = args.includes("--no-savings") ? null : readOptimizeSavings(home || require("node:os").homedir());
  const data = buildOverview(sessions, { from, to, roi, savings });

  if (asJson) { process.stdout.write(`${JSON.stringify(data, null, 2)}\n`); return; }
  process.stdout.write(renderOverview(data, { markdown }));
}

module.exports = { cmdOverview, windowFor };
