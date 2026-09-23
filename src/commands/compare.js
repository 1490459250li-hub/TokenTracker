"use strict";

const { compareModels } = require("../lib/compare-engine");

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

function pct(n) { return n == null ? "  -  " : `${String(Math.round(n * 100)).padStart(3)}%`; }
function usd(n) { return n == null ? "  -  " : `$${n.toFixed(3)}`; }

async function cmdCompare(args = []) {
  const asJson = args.includes("--json");
  const sinceDays = numOpt(args, "--since");
  let from = option(args, "--from") || "";
  let to = option(args, "--to") || "";
  if (!from && sinceDays) from = daysAgo(sinceDays);
  const minEdits = numOpt(args, "--min-edits");
  const top = numOpt(args, "--top");

  const result = await compareModels({ home: option(args, "--home") || undefined, from, to, minEdits });

  if (asJson) {
    if (top && Number(top) > 0) result.rows = result.rows.slice(0, Number(top));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push("TokenTracker compare — 哪个模型更适合你的活");
  lines.push("");
  lines.push(`窗口: ${from || "全部"}${to ? ` → ${to}` : ""}  |  会话: ${result.summary.sessions}  |  纳入排名模型: ${result.summary.models_ranked}/${result.summary.models_total}`);
  if (result.summary.insufficient_data.length) lines.push(`数据不足未排名: ${result.summary.insufficient_data.join(", ")}`);
  lines.push("");

  if (!result.rows.length) {
    lines.push("还没有可比的会话数据（需要先跑过 Claude/Codex 等并被 tokentracker 记录）。");
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }

  lines.push(headerRow());
  const shown = top && Number(top) > 0 ? result.rows.slice(0, Number(top)) : result.rows;
  for (const r of shown) {
    lines.push(`${r.model.padEnd(28).slice(0, 28)} ${String(r.sessions).padStart(4)} ${String(r.edit_turns).padStart(5)} ${pct(r.one_shot_rate)} ${pct(r.retry_rate)} ${usd(r.cost_per_edit).padStart(8)} ${pct(r.cache_hit_rate)} ${r.enough_data ? " ok" : "低量"}`);
  }
  lines.push("");
  lines.push("说明: one-shot=一次改对不重试率(高好) · 重试率(低好) · 每次 edit 成本(低好) · 缓存命中率(高好)");
  lines.push("");
  lines.push(`建议: ${result.recommendation.headline}`);
  for (const r of result.recommendation.routing) lines.push(`  · ${r}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

function headerRow() {
  return `${"model".padEnd(28)} ${"sess".padStart(4)} ${"edits".padStart(5)} ${"1shot".padStart(5)} ${"retry".padStart(5)} ${"cost/edit".padStart(8)} ${"cache".padStart(5)}  数据`;
}

module.exports = { cmdCompare };
