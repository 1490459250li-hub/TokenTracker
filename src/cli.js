const { cmdInit } = require("./commands/init");
const { cmdSync } = require("./commands/sync");
const { cmdStatus } = require("./commands/status");
const { cmdDiagnostics } = require("./commands/diagnostics");
const { cmdDoctor } = require("./commands/doctor");
const { cmdUninstall } = require("./commands/uninstall");
const { cmdServe } = require("./commands/serve");
const { cmdDeviceLogin } = require("./commands/device-login");
const { cmdWrapped } = require("./commands/wrapped");
const { cmdSessions } = require("./commands/sessions");
const { cmdOptimize } = require("./commands/optimize");
const { cmdAct } = require("./commands/act");
const { cmdGuard } = require("./commands/guard");
const { cmdGuardHook } = require("./commands/guard-hook");
const { cmdCompare } = require("./commands/compare");

async function run(argv) {
  const [command, ...rest] = argv;

  // No args → launch dashboard
  if (!command) {
    await cmdServe(argv);
    return;
  }

  if (command === "-h" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "-v" || command === "--version") {
    const pkg = require("../package.json");
    console.log(`v${pkg.version}`);
    return;
  }

  switch (command) {
    case "serve":
      await cmdServe(rest);
      return;
    case "init":
      await cmdInit(rest);
      return;
    case "sync":
      await cmdSync(rest);
      return;
    case "status":
      await cmdStatus(rest);
      return;
    case "diagnostics":
      await cmdDiagnostics(rest);
      return;
    case "doctor":
      await cmdDoctor(rest);
      return;
    case "uninstall":
      await cmdUninstall(rest);
      return;
    case "device-login":
      await cmdDeviceLogin(rest);
      return;
    case "wrapped":
      await cmdWrapped(rest);
      return;
    case "sessions":
      await cmdSessions(rest);
      return;
    case "optimize":
      await cmdOptimize(rest);
      return;
    case "act":
      await cmdAct(rest);
      return;
    case "guard":
      await cmdGuard(rest);
      return;
    case "guard-hook":
      await cmdGuardHook();
      return;
    case "compare":
      await cmdCompare(rest);
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

function printHelp() {
  // Keep this short; npx users want quick guidance.
  process.stdout.write(
    [
      "tokentracker",
      "",
      "Usage:",
      "  npx tokentracker                                         Open local dashboard",
      "  npx tokentracker -v, --version                           Show version info",
      "  npx tokentracker [--debug] serve [--port 7680] [--no-open] [--no-sync]",
      "  npx tokentracker [--debug] init [--yes] [--dry-run] [--no-open] [--link-code <code>]",
      "  npx tokentracker [--debug] sync [--auto] [--drain] [--from-openclaw]",
      "  npx tokentracker [--debug] status [--probe-keychain] [--probe-keychain-details]",
      "  npx tokentracker [--debug] diagnostics [--out diagnostics.json]",
      "  npx tokentracker [--debug] doctor [--json] [--out doctor.json] [--base-url <url>]",
      "  npx tokentracker [--debug] uninstall [--purge]",
      "  npx tokentracker [--debug] device-login [--json] [--base-url <url>]",
      "  npx tokentracker [--debug] wrapped [--year 2026] [--json]",
      "  npx tokentracker sessions [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--format json|csv] [--out file] [--refresh] [--no-git]",
      "  npx tokentracker optimize [--json] [--since N] [--top N] [--home DIR]",
      "  npx tokentracker act [apply [--yes] [--id PREFIX]] | [undo] | [report] [--json]",
      "  npx tokentracker guard [on [--soft N] [--hard N] [--checkpoint N] | off | status | limit [...] | allow] [--json]",
      "  npx tokentracker compare [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--since N] [--min-edits N] [--top N] [--json] [--home DIR]",
      "",
      "Notes:",
      "  - init: consent first, local setup next, browser sign-in last.",
      "  - --yes skips the consent menu (non-interactive safe).",
      "  - --dry-run previews changes without writing files.",
      "  - optional: --link-code <code> skips browser login when provided by Dashboard.",
      "  - Every Code notify installs when ~/.code/config.toml exists.",
      "  - OpenClaw session plugin auto-links when OpenClaw is installed (requires hooks.allowConversationAccess enabled + gateway restart).",
      "  - auto sync waits for a device token.",
      "  - optional: --dashboard-url for hosted landing.",
      "  - sync parses ~/.codex/sessions/**/rollout-*.jsonl and ~/.code/sessions/**/rollout-*.jsonl, then uploads token deltas.",
      "  - --from-openclaw marks sync runs triggered by the OpenClaw session plugin.",
      "  - --debug shows original backend errors.",
      "  - device-login pairs a headless CLI / SSH session with a browser sign-in (15-min code).",
      "  - sessions exports metadata-only Claude/Codex efficiency analytics; no prompt or response text is retained.",
      "  - optimize scans the local usage queue for cross-model waste and prices each finding; act apply/undo/report make the fixes reversible and re-measured after 3 days.",
      "  - guard is opt-in: installs PreToolUse/Stop/SessionStart hooks into ~/.claude/settings.json (backed up) that warn/stop on budget and nudge on a no-output session.",
      "  - compare ranks models by one-shot/retry/cost-per-edit/cache-hit and suggests which to use; yield reports per-session ROI from git attribution; overview emits a pasteable period report.",
      "",
    ].join("\n"),
  );
}

module.exports = { run };
