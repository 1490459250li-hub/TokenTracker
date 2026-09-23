"use strict";

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
function daysAgo(n) {
  const d = new Date(Date.now() - n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function usd(n) { return `$${(Number(n) || 0).toFixed(2)}`; }
function barPct(n) { return n == null ? "  -  " : `${String(Math.round(n)).padStart(3)}%`; }

async function cmdYield(args = []) {
  const asJson = args.includes("--json");
  const sinceDays = numOpt(args, "--since");
  let from = option(args, "--from") || "";
  const to = option(args, "--to") || "";
  if (!from && sinceDays) from = daysAgo(sinceDays);

  const result = await computeYield({
    home: option(args, "--home") || undefined,
    from, to,
    top: numOpt(args, "--top"),
    minAbandonCost: numOpt(args, "--min-cost"),
    force: args.includes("--refresh"),
  });

  if (asJson) { process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); return; }

  const lines = [];
  lines.push("TokenTracker yield — 这次 AI 会话到底有没有产出（ROI）");
  lines.push("");
  lines.push(`窗口: ${from || "全部"}${to ? ` → ${to}` : ""}  |  会话: ${result.totals.sessions}  |  总花费: ${usd(result.totals.total_cost_usd)}`);
  lines.push("");
  const roiPct = result.roi.realized_pct;
  lines.push(`ROI（合进主干的钱 / 总花费）: ${roiPct == null ? "无可归因数据" : `${roiPct}%`}`);
  lines.push(`  在险金额（reverted + abandoned）: ${usd(result.roi.value_at_risk_usd)}`);
  lines.push("");
  lines.push("  分类              会话数      花费");
  const labels = { productive: "productive 产出", reverted: "reverted   被回滚", abandoned: "abandoned  没落地", ambiguous: "ambiguous  难判断" };
  for (const s of ["productive", "reverted", "abandoned", "ambiguous"]) {
    const b = result.totals.by_status[s];
    lines.push(`  ${labels[s].padEnd(16)} ${String(b.sessions).padStart(6)}   ${usd(b.cost_usd).padStart(9)}`);
  }
  lines.push("");
  lines.push("  按模型 ROI:");
  if (!result.by_model.length) lines.push("    （暂无）");
  for (const m of result.by_model.slice(0, 12)) {
    lines.push(`    ${m.model.padEnd(28).slice(0, 28)} ${barPct(m.roi)}  花费 ${usd(m.total_cost_usd).padStart(9)}  在险 ${usd(m.at_risk_cost_usd)}`);
  }
  if (result.worst_sessions.length) {
    lines.push("");
    lines.push("  最烧钱但没产出（reverted/abandoned）top:");
    for (const w of result.worst_sessions.slice(0, 10)) {
      lines.push(`    ${usd(w.cost_usd).padStart(8)}  ${w.status.padEnd(10)}  ${w.model.padEnd(26).slice(0, 26)}  ${w.session_started_at || ""}`);
    }
  }
  lines.push("");
  lines.push(`口径: ${result.provenance.methodology}`);
  const cov = result.provenance.coverage.attributable_cost_pct;
  if (cov != null) lines.push(`git 归因覆盖率: ${cov}% 的花费能明确判定（其余为 heuristic/unknown）。`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

module.exports = { cmdYield };
