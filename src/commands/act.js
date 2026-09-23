"use strict";

const { scanWaste } = require("../lib/optimize-scan");
const { applyChanges, undoLast, reportChanges } = require("../lib/optimize-act");

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}

async function cmdAct(args = []) {
  const [sub = "apply", ...rest] = args;
  const home = option(rest, "--home") || undefined;
  const asJson = rest.includes("--json");

  if (sub === "undo") {
    const result = await undoLast({ home });
    print(result, asJson, (r) => {
      if (!r.undone) return `Nothing to undo: ${r.reason}`;
      const lines = [`Undid batch ${r.batch_id}.`];
      for (const item of r.reversed) lines.push(`  - ${item.id}: ${item.action}${item.to ? ` -> ${item.to}` : ""}${item.note ? ` (${item.note})` : ""}`);
      return lines.join("\n");
    });
    return;
  }

  if (sub === "report") {
    const sinceDays = Number(option(rest, "--since") || 90);
    const result = await reportChanges({ home, sinceDays });
    print(result, asJson, renderReport);
    return;
  }

  // default: apply
  const scan = await scanWaste({ home });
  const idPrefix = option(rest, "--id");
  let findings = scan.findings;
  if (idPrefix) findings = findings.filter((f) => f.id.startsWith(idPrefix));
  const result = await applyChanges({ findings, home, yes: rest.includes("--yes") });
  print(result, asJson, (r) => {
    const lines = [`Applied ${r.applied.length} safe fix(es). Log: ${r.log_path}`];
    for (const e of r.applied) lines.push(`  + ${e.id}  (est. ${e.type})`);
    for (const e of r.errors) lines.push(`  ! ${e.id}: ${e.result}`);
    if (r.skipped_unsafe.length) {
      lines.push("");
      lines.push(`${r.skipped_unsafe.length} config-editing fix(es) skipped (re-run with --yes to apply, they are backed up + undoable):`);
      for (const s of r.skipped_unsafe) lines.push(`  ~ ${s.id}: ${s.pasteable.split("\n")[0]}`);
    }
    lines.push("");
    lines.push("Revert any time with: tokentracker act undo");
    return lines.join("\n");
  });
}

function renderReport(r) {
  if (!r.report) return r.message || "No report available.";
  const lines = ["act report — did the fixes actually save anything?", ""];
  const s = r.report.summary;
  lines.push(`Estimated when applied: $${s.estimated_total_usd.toFixed(2)}  |  Measurably realized: $${s.realized_measurable_usd.toFixed(2)}  |  Pending (need ${r.report.threshold_days}+ days): ${s.pending_items}`);
  lines.push("");
  if (!r.report.rows.length) {
    lines.push("No applied fix is old enough to judge yet. Come back after 3 days of real sessions.");
  }
  for (const row of r.report.rows) {
    lines.push(`  [${row.status}] ${row.id}  est=$${row.estimated_cost_usd} realized=$${row.realized_cost_usd}  (${row.age_days}d) ${row.note ? `— ${row.note}` : ""}`);
  }
  lines.push("");
  lines.push(r.report.summary.honest_note);
  return lines.join("\n");
}

function print(result, asJson, human) {
  if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${human(result)}\n`);
}

module.exports = { cmdAct };
