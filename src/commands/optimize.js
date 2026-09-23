"use strict";

const { aggregateUsage } = require("../lib/usage-queue");
const { scanWasteFromQueue } = require("../lib/optimize-scan");

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}

function money(n) {
  const value = Number(n) || 0;
  if (value >= 1) return `$${value.toFixed(2)}`;
  if (value > 0) return `$${value.toFixed(4)}`;
  return "$0";
}

function tokens(n) {
  const value = Math.round(Number(n) || 0);
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

async function cmdOptimize(args = []) {
  const asJson = args.includes("--json");
  const sinceDays = Number(option(args, "--since") || 0);
  const home = option(args, "--home") || undefined;
  const top = Number(option(args, "--top") || 0);

  const agg = aggregateUsage({ home, sinceDays: undefined });
  const result = scanWasteFromQueue(agg);

  if (asJson) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const lines = [];
  lines.push("TokenTracker optimize — where tokens are being wasted");
  lines.push("");
  const p = result.provenance;
  if (!p.sessions_scanned) {
    if (p.projects_dir) {
      lines.push(`No Claude sessions found under ${p.projects_dir} — nothing to analyze yet.`);
      lines.push("Use the --since flag or run some AI coding sessions first.");
    } else {
      lines.push("No usage found in the local queue yet — run the app/sync so usage gets recorded.");
    }
    if (result.findings.length) {
      lines.push("");
      lines.push("Config-only findings (no session history required):");
    }
  }
  lines.push(`Sessions scanned: ${p.sessions_scanned}  |  dominant model: ${p.model}  |  confidence: ${p.confidence}`);
  lines.push(`Estimated waste: ${tokens(result.totals.wasted_tokens)} tokens  ~ ${money(result.totals.wasted_cost_usd)}`);
  lines.push("");

  const shown = top > 0 ? result.findings.slice(0, top) : result.findings;
  if (!shown.length) {
    lines.push("No waste patterns detected. Nothing to trim.");
  }
  let i = 0;
  for (const f of shown) {
    i += 1;
    const save = `${tokens(f.wasted_tokens)} tok / ${money(f.wasted_cost_usd)}`;
    lines.push(`${String(i).padStart(2)}. [${f.severity.toUpperCase()}] ${f.title}`);
    lines.push(`    id=${f.id}  est. saving=${save}  confidence=${f.confidence}`);
    if (f.fix && f.fix.description) lines.push(`    fix: ${f.fix.description}`);
    if (f.fix && f.fix.pasteable) lines.push(`    pasteable:\n${indent(f.fix.pasteable, "      ")}`);
    lines.push("");
  }
  if (result.findings.length > shown.length) {
    lines.push(`(${result.findings.length - shown.length} more finding(s) — raise --top or use --json)`);
  }
  lines.push("Apply safe fixes with:  tokentracker act apply   (add --yes to also apply config edits)");
  lines.push("Roll back the last apply: tokentracker act undo");
  lines.push("Measure real savings after 3 days: tokentracker act report");

  process.stdout.write(`${lines.join("\n")}\n`);
}

function indent(text, prefix) {
  return String(text).split("\n").map((line) => `${prefix}${line}`).join("\n");
}

module.exports = { cmdOptimize };
