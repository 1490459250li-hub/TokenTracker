"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { scanWaste } = require("../src/lib/optimize-scan");
const { applyChanges, undoLast, reportChanges } = require("../src/lib/optimize-act");

// Build a throwaway ~/.claude layout exercising every scan rule, so the test is
// hermetic and never touches the real home directory.
function buildFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-opt-"));
  const cl = path.join(home, ".claude");
  fs.mkdirSync(path.join(cl, "projects", "p1"), { recursive: true });
  fs.mkdirSync(path.join(cl, "agents"), { recursive: true });
  fs.mkdirSync(path.join(cl, "skills", "k8s"), { recursive: true });
  fs.mkdirSync(path.join(home, ".tokentracker"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { github: {}, slack: {} } }));
  fs.writeFileSync(path.join(cl, "agents", "ghost.md"), "unused agent. ".repeat(50));
  fs.writeFileSync(path.join(cl, "skills", "k8s", "SKILL.md"), "unused skill. ".repeat(50));
  fs.writeFileSync(path.join(cl, "CLAUDE.md"), "# rules\n" + "standing rule. ".repeat(600) + "\n@rules/x.md\n");
  const file = "/repo/widget.ts";
  const big = "y".repeat(4000);
  const L = (o) => JSON.stringify(o) + "\n";
  let j = "";
  for (let s = 0; s < 12; s++) {
    const day = String(s + 1).padStart(2, "0");
    j += L({ type: "assistant", timestamp: `2026-09-${day}T10:00:00Z`, message: { model: "claude-sonnet-4-5", usage: { input_tokens: 1000, cache_read_input_tokens: 500, cache_creation_input_tokens: 9000, output_tokens: 500 }, content: [{ type: "tool_use", id: "r" + s, name: "Read", input: { file_path: file } }] } });
    j += L({ type: "user", timestamp: `2026-09-${day}T10:00:01Z`, message: { content: [{ type: "tool_result", tool_use_id: "r" + s, content: big }] } });
    j += L({ type: "assistant", timestamp: `2026-09-${day}T10:00:02Z`, message: { model: "claude-sonnet-4-5", usage: { input_tokens: 800, cache_read_input_tokens: 400, cache_creation_input_tokens: 7000, output_tokens: 400 }, content: [{ type: "tool_use", id: "g" + s, name: "mcp__github__ping", input: {} }, { type: "tool_use", id: "e" + s, name: "Edit", input: { file_path: "/repo/unread.ts" } }] } });
  }
  fs.writeFileSync(path.join(cl, "projects", "p1", "session.jsonl"), j);
  return { home, cl };
}

const TYPES = ["unused_mcp", "ghost_agent", "ghost_skill", "claude_md_bloat", "repeated_reads", "read_before_edit", "cache_overhead"];

test("scanWaste detects every configured-resource and session-derived waste rule", async () => {
  const { home } = buildFixture();
  const result = await scanWaste({ home });
  const types = new Set(result.findings.map((f) => f.type));
  for (const t of TYPES) assert.ok(types.has(t), `expected finding type: ${t} (got ${[...types]})`);
  // slack is the only unused server; github is exercised by the transcript.
  const unused = result.findings.filter((f) => f.type === "unused_mcp").map((f) => f.evidence.name);
  assert.deepStrictEqual(unused.sort(), ["slack"]);
  // Every finding has a pasteable fix and non-negative pricing.
  for (const f of result.findings) {
    assert.ok(f.fix && typeof f.fix.pasteable === "string", `${f.id} missing pasteable`);
    assert.ok(f.wasted_cost_usd >= 0, `${f.id} negative cost`);
    assert.ok(["high", "medium", "low"].includes(f.severity), `${f.id} bad severity`);
    assert.ok(["inferred", "measured"].includes(f.confidence), `${f.id} bad confidence`);
  }
});

test("scanWaste degrades gracefully when no sessions exist", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tt-opt-empty-"));
  const result = await scanWaste({ home });
  assert.strictEqual(result.provenance.sessions_scanned, 0);
  assert.ok(Array.isArray(result.findings));
});

test("act apply + undo is fully reversible, and report is honest about it", async () => {
  const { home, cl } = buildFixture();
  const scan = await scanWaste({ home });
  const agentPath = path.join(cl, "agents", "ghost.md");
  assert.ok(fs.existsSync(agentPath), "ghost agent should exist pre-apply");

  const applied = await applyChanges({ findings: scan.findings, home, yes: false });
  assert.ok(applied.applied.length >= 1, "at least the safe archive/append fixes apply");
  // Ghost agent moved into the archive dir, not deleted.
  assert.ok(!fs.existsSync(agentPath), "agent should be archived away after apply");

  // Undo restores the original state.
  const undone = await undoLast({ home });
  assert.strictEqual(undone.undone, true);
  assert.ok(fs.existsSync(agentPath), "undo should restore the archived agent");

  // Re-apply and drive the 3-day report with a future clock.
  await applyChanges({ findings: scan.findings, home, yes: true });
  const report = await reportChanges({ home, nowMs: Date.now() + 4 * 86_400_000 });
  assert.ok(report.report, "report should be produced once changes are >3 days old");
  const statuses = new Set(report.report.rows.map((r) => r.status));
  assert.ok([...statuses].some((s) => ["resolved", "partial", "still_waste"].includes(s)), "rows are classified");
  assert.ok(report.report.summary.honest_note.length > 0);
});
