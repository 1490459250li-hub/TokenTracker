"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { tokensToEquivalents, CONSTANTS } = require("../src/lib/fun-equivalents");
const { buildOverview, renderOverview, readOptimizeSavings } = require("../src/lib/overview");
const { windowFor } = require("../src/commands/overview");

const TRACKER = path.join(__dirname, "..", "bin", "tracker.js");
const ESC = String.fromCharCode(27);

test("windowFor defaults to this month with no args (regression: isoDay() must not throw)", () => {
  const w = windowFor([]);
  assert.match(w.from, /^\d{4}-\d{2}-01$/, "from defaults to first of month");
  assert.match(w.to, /^\d{4}-\d{2}-\d{2}$/, "to defaults to a valid ISO day");
  assert.ok(w.from <= w.to);
});

test("tokensToEquivalents uses the documented constants", () => {
  const e = tokensToEquivalents(CONSTANTS.TOKENS_PER_BOOK, CONSTANTS.TOKENS_PER_CODE_LINE * 5);
  assert.strictEqual(e.books, 1);
  assert.strictEqual(e.code_lines, 5);
  assert.ok(e.words_written > 0 && e.pages > 0 && e.earth_laps >= 0);
  assert.strictEqual(e._constants, CONSTANTS);
});

function session() {
  return {
    source: "claude",
    model: "claude-sonnet-4-5",
    started_at: "2026-09-05T10:00:00Z",
    ended_at: "2026-09-05T10:30:00Z",
    productive: true,
    first_pass: true,
    edit_turns: 2,
    retry_turns: 0,
    total_tokens: 100000,
    cost_usd: 5,
    tokens: { input_tokens: 1000, output_tokens: 1000, cached_input_tokens: 80000, cache_creation_input_tokens: 20000, total_tokens: 100000 },
    model_usage: [{ model: "claude-sonnet-4-5", total_tokens: 100000, cost_usd: 5, edit_turns: 2, cached_input_tokens: 80000, cache_creation_input_tokens: 20000 }],
  };
}

test("buildOverview assembles spend, cache-hit, top models and equivalents", () => {
  const d = buildOverview([session()], { from: "2026-09-01", to: "2026-09-30" });
  assert.strictEqual(d.sessions, 1);
  assert.ok(d.cost_usd > 0, "cost is derived from token pricing");
  assert.strictEqual(d.total_tokens, 100000);
  assert.strictEqual(d.cache_hit_rate, 80);
  assert.strictEqual(d.top_models[0].model, "claude-sonnet-4-5");
  assert.ok(d.top_models[0].cost_usd > 0);
  assert.strictEqual(d.equivalents.code_lines, 100);
  assert.match(d.share_headline, /行代码/);
});

test("renderOverview is plain text with no ANSI, and markdown adds markup", () => {
  const d = buildOverview([session()], { from: "2026-09-01", to: "2026-09-30" });
  const txt = renderOverview(d);
  assert.ok(txt.indexOf(ESC) === -1, "plain text must not contain ANSI escapes");
  assert.match(txt, /缓存命中: 80%/);
  assert.match(txt, /行代码/);
  assert.match(txt, /TokenTracker 概览/);
  const md = renderOverview(d, { markdown: true });
  assert.match(md, /^# /);
  assert.match(md, /\*\*/);
});

test("buildOverview emits an empty-state line when the window has no sessions", () => {
  const d = buildOverview([], { from: "2020-01-01", to: "2020-01-31" });
  assert.strictEqual(d.sessions, 0);
  assert.match(renderOverview(d), /没有会话数据/);
});

test("readOptimizeSavings sums est_cost from the act change log", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-ov-sav-"));
  const dir = path.join(home, ".tokentracker", "optimize");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "changes.json"), JSON.stringify({
    version: 1,
    batches: [{ batch_id: "b", entries: [
      { est_cost_usd: 1.5, result: "applied" },
      { est_cost_usd: 2.5, result: "applied" },
      { est_cost_usd: 9, result: "error: x" },
    ] }],
  }));
  const s = readOptimizeSavings(home);
  assert.strictEqual(s.fixes_applied, 2);
  assert.strictEqual(s.estimated_usd, 4);
  assert.strictEqual(readOptimizeSavings(path.join(home, "nope")), null);
  fs.rmSync(home, { recursive: true, force: true });
});

// Integration: real session scan through the CLI, plain JSON round-trip.
test("overview runs end-to-end via buildSessionAnalytics and renders JSON", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-ov-"));
  const proj = path.join(home, ".claude", "projects", "p1");
  fs.mkdirSync(proj, { recursive: true });
  const L = (o) => JSON.stringify(o) + "\n";
  let j = "";
  for (let s = 0; s < 3; s++) {
    j += L({ type: "user", timestamp: `2026-09-0${s + 1}T10:00:00Z`, message: { content: `t${s}` } });
    j += L({ type: "assistant", timestamp: `2026-09-0${s + 1}T10:00:05Z`, message: { model: "claude-sonnet-4-5", usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000 }, content: [{ type: "tool_use", id: "e" + s, name: "Edit", input: { file_path: `/repo/f${s}.ts` } }] } });
  }
  fs.writeFileSync(path.join(proj, "s.jsonl"), j);

  const res = spawnSync(process.execPath, [TRACKER, "overview", "--json", "--home", home, "--from", "2026-09-01", "--to", "2026-09-30"], { encoding: "utf8" });
  assert.strictEqual(res.status, 0, `overview exited ${res.status}: ${res.stderr}`);
  const d = JSON.parse(res.stdout);
  assert.ok(d.sessions >= 1, "fixture session counted");
  assert.ok(Number.isFinite(d.cost_usd) && Number.isFinite(d.total_tokens));
  assert.ok(d.equivalents && Number.isFinite(d.equivalents.code_lines));
  assert.ok(Array.isArray(d.top_models));

  const txt = spawnSync(process.execPath, [TRACKER, "overview", "--home", home, "--from", "2026-09-01", "--to", "2026-09-30"], { encoding: "utf8" });
  assert.strictEqual(txt.status, 0);
  assert.ok(txt.stdout.indexOf(ESC) === -1, "CLI overview output is no-color");

  fs.rmSync(home, { recursive: true, force: true });
});
