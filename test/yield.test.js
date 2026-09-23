"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { buildYield } = require("../src/lib/yield-engine");

const TRACKER = path.join(__dirname, "..", "bin", "tracker.js");

function session({ hash, model = "claude-sonnet-4-5", cost, edit_turns = 0, productive = false, started_at = "2026-09-02T10:00:00Z", ended_at = "2026-09-02T10:30:00Z" }) {
  return { session_hash: hash, model, cost_usd: cost, edit_turns, productive, started_at, ended_at, source: "claude", tokens: { total_tokens: 1000 } };
}
function outcome({ hash, accepted, status, commit = "deadbeef" }) {
  return { session_hash: hash, accepted, status, commit_hash: commit, timestamp: "2026-09-02T10:31:00Z", model: "claude-sonnet-4-5", tool: "claude" };
}

const SESSIONS = [
  session({ hash: "h1", model: "claude-sonnet-4-5", cost: 2, edit_turns: 3, productive: true }),
  session({ hash: "h2", model: "claude-sonnet-4-5", cost: 4, edit_turns: 2, productive: true }),
  session({ hash: "h3", model: "claude-opus-4-1", cost: 6, edit_turns: 5, productive: true }),
  session({ hash: "h4", model: "claude-sonnet-4-5", cost: 1, edit_turns: 0 }), // pure exploration -> ambiguous
];
const OUTCOMES = [
  outcome({ hash: "h1", accepted: true, status: "committed" }),
  outcome({ hash: "h2", accepted: false, status: "reverted" }),
  // h3 has edits + $ but no commit -> abandoned; h4 no edits, no commit -> ambiguous
];

test("buildYield buckets sessions and computes ROI = landed / total", () => {
  const y = buildYield(SESSIONS, OUTCOMES);
  assert.strictEqual(y.totals.by_status.productive.sessions, 1);
  assert.strictEqual(y.totals.by_status.reverted.sessions, 1);
  assert.strictEqual(y.totals.by_status.abandoned.sessions, 1);
  assert.strictEqual(y.totals.by_status.ambiguous.sessions, 1);
  assert.strictEqual(y.totals.total_cost_usd, 13);
  assert.strictEqual(y.roi.realized_pct, Math.round((2 / 13) * 1000) / 10); // ~15.4%
  assert.strictEqual(y.roi.value_at_risk_usd, 10); // reverted 4 + abandoned 6
  assert.strictEqual(y.roi.abandoned_usd, 6);
  assert.strictEqual(y.provenance.coverage.attributable_cost_pct, Math.round(((2 + 4) / 13) * 1000) / 10);
});

test("buildYield worst_sessions lists reverted+abandoned by cost, and by_model ROI rolls up", () => {
  const y = buildYield(SESSIONS, OUTCOMES);
  assert.deepStrictEqual(y.worst_sessions.map((w) => w.status), ["abandoned", "reverted"]);
  const opus = y.by_model.find((m) => m.model === "claude-opus-4-1");
  assert.strictEqual(opus.abandoned_sessions, 1);
  assert.strictEqual(opus.roi, 0); // opus spent $6, none landed
  const sonnet = y.by_model.find((m) => m.model === "claude-sonnet-4-5");
  assert.strictEqual(sonnet.productive_sessions, 1);
});

test("min-cost keeps cheap no-trace edits out of the abandoned bucket", () => {
  const sessions = [...SESSIONS, session({ hash: "h5", cost: 0.5, edit_turns: 1, productive: true })];
  const loose = buildYield(sessions, OUTCOMES);
  const strict = buildYield(sessions, OUTCOMES, { minAbandonCost: 5 });
  assert.strictEqual(loose.totals.by_status.abandoned.sessions, 2); // h3 + h5
  assert.strictEqual(strict.totals.by_status.abandoned.sessions, 1); // h5 ($0.5 < $5) -> ambiguous
  assert.strictEqual(strict.totals.by_status.ambiguous.sessions, 2);
});

test("window filter keeps only in-range sessions", () => {
  const old = session({ hash: "h0", cost: 100, edit_turns: 4, productive: true, started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T01:00:00Z" });
  const y = buildYield([old, ...SESSIONS], OUTCOMES, { from: "2026-09-01", to: "2026-09-30" });
  assert.strictEqual(y.totals.sessions, 4);
});

// Integration: real session scan + real (empty) git attribution on a non-repo home.
test("yield runs end-to-end through buildSessionAnalytics + git-outcomes", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-yield-"));
  const proj = path.join(home, ".claude", "projects", "p1");
  fs.mkdirSync(proj, { recursive: true });
  const L = (o) => JSON.stringify(o) + "\n";
  let j = "";
  for (let s = 0; s < 3; s++) {
    j += L({ type: "user", timestamp: `2026-09-0${s + 1}T10:00:00Z`, message: { content: `task ${s}` } });
    j += L({ type: "assistant", timestamp: `2026-09-0${s + 1}T10:00:05Z`, message: { model: "claude-sonnet-4-5", usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000 }, content: [{ type: "tool_use", id: "e" + s, name: "Edit", input: { file_path: `/repo/f${s}.ts` } }] } });
  }
  fs.writeFileSync(path.join(proj, "s.jsonl"), j);

  const res = spawnSync(process.execPath, [TRACKER, "yield", "--json", "--home", home], { encoding: "utf8" });
  assert.strictEqual(res.status, 0, `yield exited ${res.status}: ${res.stderr}`);
  const y = JSON.parse(res.stdout);
  assert.ok(y.totals && y.roi && Array.isArray(y.by_model), "shape present");
  assert.ok(y.totals.sessions >= 1, "the fixture session is counted");
  // No git repo here -> nothing attributable; the edited session lands in abandoned, not productive.
  assert.strictEqual(y.totals.by_status.productive.sessions, 0);
  assert.ok(y.totals.by_status.abandoned.sessions >= 1, "edited-but-uncommitted -> abandoned");
  assert.strictEqual(y.roi.realized_pct, 0);

  fs.rmSync(home, { recursive: true, force: true });
});
