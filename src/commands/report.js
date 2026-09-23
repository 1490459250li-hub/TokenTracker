"use strict";

// report.js — the P5 morning report (晨报通知). Model-agnostic: it summarizes a
// day's usage straight from the local queue (queue.jsonl), so it works for
// workbuddy / Gemini / domestic / ChatGPT alike — not just Claude.
//   tokentracker report                      # print yesterday's summary
//   tokentracker report --date 2026-09-21    # a specific day
//   tokentracker report --notify             # also fire a Windows toast
//   tokentracker report --install-schedule --at 08:30 [--dry-run]
//   tokentracker report --uninstall-schedule
// The toast is best-effort (needs a desktop session); the summary text always works.

const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { aggregateUsage } = require("../lib/usage-queue");

const TASK_NAME = "TokenTracker-DailyReport";

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] || "" : "";
}

function yesterdayDate() {
  const d = new Date(Date.now() - 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function money(n) { return `$${(Number(n) || 0).toFixed(2)}`; }
function tok(n) { const v = Number(n) || 0; return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v); }

function buildSummary(date, agg) {
  const top = (agg.by_model || [])[0];
  const lines = [];
  lines.push(`TokenTracker 日报 · ${date}`);
  lines.push(`花费 ${money(agg.totals.cost_usd)} · ${tok(agg.totals.total_tokens)} tokens · ${agg.totals.models} 个模型`);
  if (top) lines.push(`最常用：${top.model}（${tok(top.total_tokens)} tokens${top.priced ? ` · ${money(top.cost_usd)}` : " · 无价"}）`);
  const unpriced = (agg.totals.unpriced_models || []).length;
  if (unpriced) lines.push(`提示：${unpriced} 个模型没有价格，花费被低估。`);
  return lines.join("\n");
}

function toastScript(title, body) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const xml = `<toast><visual><binding template="ToastGeneric"><title>${esc(title)}</title><text>${esc(body)}</text></binding></visual></toast>`;
  return [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType=WindowsRuntime] | Out-Null",
    `$x = New-Object Windows.Data.Xml.Dom.XmlDocument; $x.LoadXml('${xml}')`,
    `$n = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('TokenTracker')`,
    `$n.Show([Windows.UI.Notifications.ToastNotification]::new($x))`,
  ].join("; ");
}

function notifyWindows(title, body) {
  try {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", toastScript(title, body)], { encoding: "utf8", timeout: 15_000 });
    return { ok: r.status === 0, error: r.status === 0 ? "" : String(r.stderr || "").trim().slice(0, 200) };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

function defaultTrackerPath() {
  return path.join(__dirname, "..", "..", "bin", "tracker.js");
}

function scheduleCommand(at, { trackerPath = defaultTrackerPath(), execPath = process.execPath } = {}) {
  // schtasks wants the task action as a single string with literal quotes around
  // each path; spawnSync passes argv without a shell, so real double-quotes here.
  const tr = `"${execPath}" "${trackerPath}" report --notify`;
  return {
    file: "schtasks.exe",
    args: ["/create", "/f", "/tn", TASK_NAME, "/tr", tr, "/sc", "daily", "/st", at || "08:30"],
  };
}

async function cmdReport(args = []) {
  const home = option(args, "--home") || os.homedir();
  const asJson = args.includes("--json");

  if (args.includes("--uninstall-schedule")) {
    const r = spawnSync("schtasks.exe", ["/delete", "/f", "/tn", TASK_NAME], { encoding: "utf8" });
    return out(asJson, { removed: r.status === 0, task: TASK_NAME }, (x) => (x.removed ? `已删除计划任务 ${TASK_NAME}` : `未找到计划任务 ${TASK_NAME}`));
  }
  if (args.includes("--install-schedule")) {
    const at = option(args, "--at") || "08:30";
    const cmd = scheduleCommand(at);
    if (args.includes("--dry-run")) {
      return out(asJson, { dryRun: true, at, command: `${cmd.file} ${cmd.args.join(" ")}` }, (x) => `将执行（dry-run，未创建）：\n${x.command}`);
    }
    const r = spawnSync(cmd.file, cmd.args, { encoding: "utf8" });
    return out(asJson, { installed: r.status === 0, at, error: r.status ? String(r.stderr || "").slice(0, 200) : "" }, (x) => (x.installed ? `已注册每日 ${x.at} 的晨报计划任务（${TASK_NAME}）。` : `注册失败：${x.error || "见 schtasks 输出"}`));
  }

  const date = option(args, "--date") || yesterdayDate();
  const agg = aggregateUsage({ home, from: date, to: date });
  const summary = buildSummary(date, agg);
  let notify = null;
  if (args.includes("--notify")) notify = notifyWindows("TokenTracker 日报", summary);

  if (asJson) { process.stdout.write(`${JSON.stringify({ date, summary, totals: agg.totals, notify }, null, 2)}\n`); return; }
  process.stdout.write(`${summary}\n`);
  if (args.includes("--notify")) process.stdout.write(`\n${notify && notify.ok ? "已发送 Windows 通知。" : `通知发送失败：${(notify && notify.error) || "unknown"}（日报文本如上）`}\n`);
}

function out(asJson, obj, human) {
  if (asJson) process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  else process.stdout.write(`${human(obj)}\n`);
}

module.exports = { cmdReport, buildSummary, scheduleCommand, yesterdayDate };
