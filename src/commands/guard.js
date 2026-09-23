"use strict";

const os = require("node:os");

const {
  installGuard,
  removeGuard,
  guardStatus,
  writeConfig,
  grantAllowOnce,
  buildGuardHookCommand,
} = require("../lib/guard-manager");
const { DEFAULTS } = require("../lib/guard-core");

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

async function cmdGuard(args = []) {
  const [sub = "status", ...rest] = args;
  const home = option(rest, "--home") || os.homedir();
  const asJson = rest.includes("--json");
  const hookCommand = buildGuardHookCommand();

  if (sub === "on") {
    const result = await installGuard({ home, soft: numOpt(rest, "--soft"), hard: numOpt(rest, "--hard"), checkpoint: numOpt(rest, "--checkpoint"), hookCommand });
    return print(asJson, result, () => [
      "预算护栏已启用（opt-in）。已把 guard 钩子写入:",
      `  ${result.settingsPath}`,
      result.backupPath ? `  备份: ${result.backupPath}` : "  (settings.json 之前不存在，未生成备份)",
      "",
      `  软上限 $${result.config.soft}  ·  硬上限 $${result.config.hard}  ·  检查点 $${result.config.checkpoint}`,
      "钩子事件: " + result.events.join(", "),
      "",
      "注意: 需要重启 Claude Code 才会加载新钩子。停用: tokentracker guard off",
    ].join("\n"));
  }

  if (sub === "off") {
    const result = await removeGuard({ home, hookCommand });
    return print(asJson, result, () => result.removed
      ? `已卸载 guard 钩子${result.backupPath ? `，原 settings.json 备份在 ${result.backupPath}` : ""}。`
      : `没有需要卸载的 guard 钩子${result.skippedReason ? `（${result.skippedReason}）` : ""}。`);
  }

  if (sub === "limit") {
    const merged = await writeConfig(home, { soft: numOpt(rest, "--soft"), hard: numOpt(rest, "--hard"), checkpoint: numOpt(rest, "--checkpoint") });
    return print(asJson, merged, () => `阈值已更新: 软 $${merged.soft} · 硬 $${merged.hard} · 检查点 $${merged.checkpoint}`);
  }

  if (sub === "allow") {
    const result = await grantAllowOnce(home, "_any");
    return print(asJson, result, () => `已放行一次（90 秒内有效）。下一个触到硬上限的工具调用会被允许通过。`);
  }

  // default: status
  const status = await guardStatus({ home, hookCommand });
  return print(asJson, status, () => {
    const c = status.config;
    const lines = [
      `预算护栏: ${status.enabled ? "已启用" : "未启用"}  (config enabled=${c.enabled}, hooks ${status.hooksPresent ? "已装" : "未装"})`,
      `  软 $${c.soft}  ·  硬 $${c.hard}  ·  检查点 $${c.checkpoint}  (默认 软$${DEFAULTS.soft}/硬$${DEFAULTS.hard}/检查点$${DEFAULTS.checkpoint})`,
      `  settings: ${status.settingsPath}`,
    ];
    if (c.enabled && !status.hooksPresent) lines.push("  提示: 配置存在但钩子未安装，运行 tokentracker guard on 补装。");
    return lines.join("\n");
  });
}

function print(asJson, obj, human) {
  if (asJson) process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  else process.stdout.write(`${human()}\n`);
}

module.exports = { cmdGuard };
