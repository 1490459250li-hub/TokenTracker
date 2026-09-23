"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { buildComparison } = require("../src/lib/compare-engine");

const TRACKER = path.join(__dirname, "..", "bin", "tracker.js");

function modelSession({ model, first_pass, edit_turns, retries, cost_usd, cached, creation, productive = true }) {
  return {
    source: "claude",
    model,
    started_at: "2026-09-02T10:00:00Z",
    ended_at: "2026-09-02T10:30:00Z",
    productive,
    first_pass,
    edit_turns,
    retry_turns: retries,
    total_tokens: 1000,
    cost_usd,
    tokens: {
      input_tokens: 1000,
      output_tokens: 500,
      cached_input_tokens: cached,
      cache_creation_input_tokens: creation,
      total_tokens: 1000,
    },
  };
}

test("buildComparison ranks models by one-shot / retries / cost-per-edit / cache-hit and recommends the best", () => {
  const good = modelSession({ model: "model-a", first_pass: true, edit_turns: 5, retries: 0, cost_usd: 0.5, cached: 9000, creation: 1000 });
  const bad = modelSession({ model: "model-b", first_pass: false, edit_turns: 10, retries: 6, cost_usd: 3.0, cached: 1000, creation: 9000 });
  const result = buildComparison([good, bad], { minEdits: 3 });

  const by = Object.fromEntries(result.rows.map((r) => [r.model, r]));
  assert.strictEqual(by["model-a"].one_shot_rate, 1);
  assert.strictEqual(by["model-a"].retry_rate, 0);
  assert.strictEqual(by["model-a"].cache_hit_rate, 0.9);
  assert.strictEqual(by["model-a"].cost_per_edit, 0.1);
  assert.strictEqual(by["model-a"].enough_data, true);

  assert.strictEqual(by["model-b"].one_shot_rate, 0);
  assert.strictEqual(by["model-b"].retry_rate, 0.6);
  assert.strictEqual(by["model-b"].cache_hit_rate, 0.1);
  assert.strictEqual(by["model-b"].cost_per_edit, 0.3);

  assert.strictEqual(result.summary.models_ranked, 2);
  assert.strictEqual(result.recommendation.picks.best_overall, "model-a");
  assert.strictEqual(result.recommendation.picks.cheapest_per_edit, "model-a");
  assert.strictEqual(result.recommendation.picks.best_cache_hit, "model-a");
  assert.strictEqual(result.recommendation.picks.lowest_retry, "model-a");
  assert.ok(result.recommendation.routing.length >= 1);
});

test("buildComparison marks thin models insufficient and withholds a recommendation", () => {
  const thin = modelSession({ model: "tinymodel", first_pass: true, edit_turns: 1, retries: 0, cost_usd: 0.1, cached: 10, creation: 10 });
  const result = buildComparison([thin], { minEdits: 3 });
  assert.strictEqual(result.summary.models_ranked, 0);
  assert.deepStrictEqual(result.summary.insufficient_data, ["tinymodel"]);
  assert.match(result.recommendation.headline, /样本/);
});

test("buildComparison respects a from/to window", () => {
  const old = { ...modelSession({ model: "m", first_pass: true, edit_turns: 5, retries: 0, cost_usd: 0.5, cached: 9000, creation: 1000 }), started_at: "2026-01-01T00:00:00Z", ended_at: "2026-01-01T01:00:00Z" };
  const recent = modelSession({ model: "m", first_pass: true, edit_turns: 5, retries: 0, cost_usd: 0.5, cached: 9000, creation: 1000 });
  const filtered = buildComparison([old, recent], { from: "2026-09-01", to: "2026-09-30", minEdits: 3 });
  const only = filtered.rows.find((r) => r.model === "m");
  assert.strictEqual(only.sessions, 1, "only the in-window session counts");
});

// Integration: run the real scanClaudeSession -> summarize -> cache roll-up path.
test("compare end-to-end via buildSessionAnalytics on a transcript fixture", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-compare-"));
  const proj = path.join(home, ".claude", "projects", "p1");
  fs.mkdirSync(proj, { recursive: true });
  const L = (o) => JSON.stringify(o) + "\n";
  let j = "";
  for (let s = 0; s < 3; s++) {
    // per-message usage: cache_read 8000, cache_creation 2000 -> session cache_hit = 24000/(24000+6000)=0.8
    j += L({ type: "assistant", timestamp: `2026-09-0${s + 1}T10:00:00Z`, message: { model: "claude-sonnet-4-5", usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000 }, content: [{ type: "tool_use", id: "e" + s, name: "Edit", input: { file_path: "/repo/f" + s + ".ts" } }] } });
    j += L({ type: "user", timestamp: `2026-09-0${s + 1}T10:00:05Z`, message: { content: [{ type: "tool_result", tool_use_id: "e" + s, content: "ok" }] } });
  }
  fs.writeFileSync(path.join(proj, "s.jsonl"), j);

  const res = spawnSync(process.execPath, [TRACKER, "compare", "--json", "--home", home], { encoding: "utf8" });
  assert.strictEqual(res.status, 0, `compare exited ${res.status}: ${res.stderr}`);
  const parsed = JSON.parse(res.stdout);
  assert.ok(Array.isArray(parsed.rows) && parsed.rows.length >= 1, "should produce at least one model row");
  // one row should carry the ~0.8 cache hit derived from the transcript tokens
  assert.ok(parsed.rows.some((r) => r.cache_hit_rate != null && Math.abs(r.cache_hit_rate - 0.8) < 1e-3),
    `expected a model with cache_hit_rate ~0.8, got ${JSON.stringify(parsed.rows.map((r) => [r.model, r.cache_hit_rate]))}`);

  fs.rmSync(home, { recursive: true, force: true });
});
