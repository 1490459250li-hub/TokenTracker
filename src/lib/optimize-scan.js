"use strict";

// optimize-scan.js — the "where is money being wasted, and how do I stop it"
// scanner that turns raw session/config data into ranked, actionable findings.
//
// This is the TokenTracker counterpart to CodeBurn's `optimize`: instead of
// only reporting *how much* you spent, it looks for repeated waste patterns
// across sessions and the ~/.claude config, prices each one, and hands back a
// pasteable fix. Every finding carries an explicit `confidence` because these
// are heuristics over local files, not ground truth — nothing here is guessed
// silently.
//
// Privacy: everything runs on local files only. Prompt/response *text* is never
// returned; we keep counts, sizes, tool names, file paths, and token totals.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { estimateTokens } = require("./context-health");
const { physicalJsonlRecords } = require("./jsonl-lines");
const { computeRowCost, getModelPricing, ensurePricingLoaded } = require("./pricing");

// Tool_use names (lowercased) that mutate files — used for the Read:Edit ratio.
const EDIT_TOOLS = new Set([
  "edit", "write", "multiedit", "apply_patch", "notebookedit",
  "search_replace", "str_replace", "create_file", "write_file", "replace",
]);
const READ_TOOLS = new Set(["read"]);

// Conservative overhead model for a "phantom" MCP server that is configured but
// never called: its tool schemas are injected into every session's context. The
// same two knobs as context-health use, so the numbers stay consistent.
function mcpSchemaTokens(env) {
  const perTool = Math.max(0, Number(env.TOKENTRACKER_MCP_TOOL_SCHEMA_TOKENS || 400));
  const toolsPerServer = Math.max(1, Number(env.TOKENTRACKER_MCP_TOOLS_PER_SERVER || 5));
  return perTool * toolsPerServer;
}

function claudeDirFor(opts) {
  const env = opts.env || process.env;
  const home = opts.home || os.homedir();
  // Honor CLAUDE_CONFIG_DIR when present (it points *at* the .claude dir).
  const override = env.CLAUDE_CONFIG_DIR || opts.claudeDir;
  return { home, claudeDir: override ? path.resolve(override) : path.join(home, ".claude") };
}

function listFilesRecursive(rootDir, { match, limit = 2000 }) {
  const out = [];
  const stack = [rootDir];
  while (stack.length && out.length < limit) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(filePath);
      else if (entry.isFile() && match(entry.name)) out.push(filePath);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// Configured MCP server names from every place Claude/Codex may declare them.
function readMcpServers(home, cwd) {
  const found = new Map(); // name -> sourceFile
  const jsonFiles = [
    path.join(home, ".claude.json"),
    path.join(home, ".claude", "settings.json"),
    path.join(cwd, ".mcp.json"),
  ];
  for (const filePath of jsonFiles) {
    try {
      const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
      const servers = data.mcpServers || data.mcp_servers || {};
      for (const name of Object.keys(servers)) if (!found.has(name)) found.set(name, filePath);
    } catch { /* absent / not JSON */ }
  }
  try {
    const toml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    for (const m of toml.matchAll(/^\s*\[mcp_servers\.([^\]]+)\]/gm)) {
      const name = m[1].trim();
      if (name && !found.has(name)) found.set(name, path.join(home, ".codex", "config.toml"));
    }
  } catch { /* absent */ }
  return found;
}

function readText(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch { return null; }
}

// Pull the file path a Read/Edit tool_use targeted, from the shapes Claude uses.
function toolFilePath(input) {
  if (!input || typeof input !== "object") return "";
  return String(input.file_path || input.path || input.notebook_path || input.target || "");
}

// Parse a single Claude session transcript into the signals the rules need.
async function parseSession(filePath) {
  const session = {
    filePath,
    model: "",
    endedAt: 0,
    totals: { input_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 },
    readCounts: new Map(),   // normalized file path -> number of Read calls
    readResultTokens: new Map(), // file path -> summed tokens returned by those Reads
    edits: 0,
    editsWithoutPriorRead: 0,
    mcpServersUsed: new Set(),
    subagentsUsed: new Set(),
    slashUsed: new Set(),
    skillUsed: new Set(),
    pendingReadsByToolId: new Map(), // tool_use_id -> file path (awaiting its result size)
  };
  // Seen files read *earlier in this session*, so an Edit before a Read counts.
  const readSoFar = new Set();
  let stream;
  try {
    stream = fs.createReadStream(filePath);
  } catch {
    return session;
  }
  try {
    for await (const rec of physicalJsonlRecords(stream, { invalidUtf8: "record" })) {
      if (!rec.utf8Valid || !rec.line) continue;
      let obj;
      try { obj = JSON.parse(rec.line); } catch { continue; }
      if (obj.timestamp) { const t = Date.parse(obj.timestamp); if (Number.isFinite(t)) session.endedAt = Math.max(session.endedAt, t); }
      const message = obj.message;
      if (!message || typeof message !== "object") continue;
      if (message.model) session.model = String(message.model);
      const usage = message.usage;
      if (usage && typeof usage === "object") {
        session.totals.input_tokens += Number(usage.input_tokens || 0);
        session.totals.cached_input_tokens += Number(usage.cache_read_input_tokens || 0);
        session.totals.cache_creation_input_tokens += Number(usage.cache_creation_input_tokens || 0);
        session.totals.output_tokens += Number(usage.output_tokens || 0);
        session.totals.reasoning_output_tokens += Number(usage.reasoning_output_tokens || 0);
      }
      const content = Array.isArray(message.content) ? message.content : [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "tool_use") {
          const name = String(block.name || "").toLowerCase();
          if (name.startsWith("mcp__")) {
            const parts = String(block.name).split("__");
            if (parts.length >= 2 && parts[1]) session.mcpServersUsed.add(parts[1]);
          }
          if (READ_TOOLS.has(name)) {
            const fp = toolFilePath(block.input);
            if (fp) {
              const key = fp.replace(/\\/g, "/");
              session.readCounts.set(key, (session.readCounts.get(key) || 0) + 1);
              readSoFar.add(key);
              if (block.id) session.pendingReadsByToolId.set(String(block.id), key);
            }
          } else if (EDIT_TOOLS.has(name)) {
            session.edits += 1;
            const fp = toolFilePath(block.input).replace(/\\/g, "/");
            if (!fp || !readSoFar.has(fp)) session.editsWithoutPriorRead += 1;
          } else if ((name === "task" || name === "agent") && block.input && block.input.subagent_type) {
            session.subagentsUsed.add(String(block.input.subagent_type).toLowerCase());
          } else if (name === "skill" && block.input && (block.input.command || block.input.skill)) {
            session.skillUsed.add(String(block.input.command || block.input.skill).toLowerCase());
          }
        } else if (block.type === "tool_result") {
          // Attribute the result payload size to the Read that produced it.
          const targetId = String(block.tool_use_id || "");
          const fileKey = session.pendingReadsByToolId.get(targetId);
          if (fileKey) {
            const tokens = estimateTokens(stringifyToolResult(block.content));
            session.readResultTokens.set(fileKey, (session.readResultTokens.get(fileKey) || 0) + tokens);
            session.pendingReadsByToolId.delete(targetId);
          }
        }
      }
      // Slash commands / skills also surface as `/<name>` at the start of user text.
      if (obj.type === "user" && typeof message.content === "string") {
        for (const m of message.content.matchAll(/(?:^|\s)\/([a-z0-9][a-z0-9:_-]{0,40})\b/gi)) {
          session.slashUsed.add(m[1].toLowerCase());
        }
      }
    }
  } catch { /* truncated / unreadable transcript: keep partial signals */ } finally {
    try { stream.destroy(); } catch { /* already closed */ }
  }
  return session;
}

function stringifyToolResult(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.text === "string") parts.push(item.text);
  }
  return parts.join("\n");
}

function listClaudeSessionFiles(projectsDir, sinceMs) {
  return listFilesRecursive(projectsDir, { match: (name) => name.endsWith(".jsonl") })
    .filter((filePath) => {
      if (!sinceMs) return true;
      try { return fs.statSync(filePath).mtimeMs >= sinceMs; } catch { return true; }
    });
}

function dominantModel(sessions) {
  const tally = new Map();
  for (const s of sessions) if (s.model) tally.set(s.model, (tally.get(s.model) || 0) + 1);
  let best = "";
  let bestCount = 0;
  for (const [model, count] of tally) if (count > bestCount) { best = model; bestCount = count; }
  return best;
}

// Price a batch of "would-be-injected-every-session" tokens. These are mostly
// cache-read context on repeat sessions, so we bill at the cheapest credible
// rate and label it conservative. Falls back to the seeded pricing map (works
// offline via resetPricingForTests/seed-snapshot).
function priceContextTokens(model, tokens) {
  if (!model || !tokens) return 0;
  const row = {
    model, source: "claude",
    input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0,
    cached_input_tokens: tokens, cache_creation_input_tokens: 0,
  };
  const cost = computeRowCost(row);
  if (Number.isFinite(cost) && cost > 0) return cost;
  // Zero pricing usually means the model is unknown to the seed — estimate with
  // a generic Claude Sonnet cache-read rate so the finding is not silently $0.
  const pricing = getModelPricing(model, { source: "claude" });
  const rate = pricing && pricing.cache_read ? pricing.cache_read : 0.3;
  return (tokens * rate) / 1_000_000;
}

async function scanWaste(options = {}) {
  const env = options.env || process.env;
  const { home, claudeDir } = claudeDirFor({ ...options, env });
  const cwd = options.cwd || process.cwd();
  const projectsDir = options.projectsDir || path.join(claudeDir, "projects");
  const sinceDays = Number(options.sinceDays || 0);
  const sinceMs = sinceDays > 0 ? Date.now() - sinceDays * 86_400_000 : 0;

  // ensurePricingLoaded may hit the network; never let that block the scan.
  await ensurePricingLoaded().catch(() => {});

  const findings = [];
  const sessionFiles = listClaudeSessionFiles(projectsDir, sinceMs);
  const sessions = [];
  for (const filePath of sessionFiles) sessions.push(await parseSession(filePath));

  const sessionCount = sessions.length;
  const model = dominantModel(sessions) || "claude-sonnet-4-5";

  const totals = sessions.reduce((acc, s) => {
    for (const key of Object.keys(acc)) acc[key] += s.totals[key] || 0;
    return acc;
  }, { input_tokens: 0, cached_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 });

  const usedMcp = new Set();
  const usedSubagents = new Set();
  const usedSlash = new Set();
  const usedSkills = new Set();
  for (const s of sessions) {
    for (const n of s.mcpServersUsed) usedMcp.add(n);
    for (const n of s.subagentsUsed) usedSubagents.add(n);
    for (const n of s.slashUsed) usedSlash.add(n);
    for (const n of s.skillUsed) usedSkills.add(n);
  }

  // ---- R1: unused MCP servers (pay schema overhead every session) ----
  const servers = readMcpServers(home, cwd);
  const perServerTokens = mcpSchemaTokens(env);
  for (const [name, sourceFile] of servers) {
    if (usedMcp.has(name)) continue;
    const tokens = perServerTokens * Math.max(1, sessionCount);
    findings.push(makeFinding({
      type: "unused_mcp",
      severity: sessionCount >= 5 ? "high" : sessionCount >= 2 ? "medium" : "low",
      title: `MCP server "${name}" is configured but never called`,
      confidence: "inferred",
      evidence: { name, sourceFile, schema_tokens_per_session: perServerTokens, sessions: sessionCount },
      wasted_tokens: tokens,
      wasted_cost_usd: priceContextTokens(model, tokens),
      fix: {
        description: "Remove the idle server (or delete it from config) so its tool schemas stop loading every session.",
        pasteable: `claude mcp remove --scope user ${JSON.stringify(name)}`,
        apply: { kind: "remove_mcp_server", name, sourceFile, safe: false },
      },
    }));
  }

  // ---- R2: ghost agents (defined under agents/, never invoked as a subagent) ----
  for (const filePath of listFilesRecursive(path.join(claudeDir, "agents"), { match: (n) => n.endsWith(".md") })) {
    const name = path.basename(filePath, ".md").toLowerCase();
    if (usedSubagents.has(name)) continue;
    const text = readText(filePath) || "";
    findings.push(makeFinding({
      type: "ghost_agent",
      severity: "low",
      title: `Agent "${name}" is defined but never used`,
      confidence: "inferred",
      evidence: { name, filePath, tokens: estimateTokens(text) },
      wasted_tokens: 0,
      wasted_cost_usd: 0,
      fix: {
        description: "Archive the unused agent so it is not offered; restore anytime with act undo.",
        pasteable: `mv ${JSON.stringify(filePath)} ${JSON.stringify(path.join(home, ".tokentracker", "optimize", "archive"))}`,
        apply: { kind: "archive_path", src: filePath, safe: true },
      },
    }));
  }

  // ---- R3: ghost skills ----
  for (const filePath of listFilesRecursive(path.join(claudeDir, "skills"), { match: (n) => n === "SKILL.md" })) {
    const skillDir = path.dirname(filePath);
    const name = path.basename(skillDir).toLowerCase();
    if (usedSkills.has(name) || usedSlash.has(name)) continue;
    const text = readText(filePath) || "";
    findings.push(makeFinding({
      type: "ghost_skill",
      severity: "low",
      title: `Skill "${name}" is installed but never invoked`,
      confidence: "inferred",
      evidence: { name, filePath, tokens: estimateTokens(text) },
      wasted_tokens: estimateTokens(text) * Math.max(1, sessionCount) * 0 /* listing cost only; not priced */,
      wasted_cost_usd: 0,
      fix: {
        description: "Archive the unused skill (skills are cheap until triggered, so this is tidiness more than savings).",
        pasteable: `mv ${JSON.stringify(skillDir)} ${JSON.stringify(path.join(home, ".tokentracker", "optimize", "archive"))}`,
        apply: { kind: "archive_path", src: skillDir, safe: true },
      },
    }));
  }

  // ---- R4: ghost slash commands ----
  for (const filePath of listFilesRecursive(path.join(claudeDir, "commands"), { match: (n) => n.endsWith(".md") })) {
    const name = path.basename(filePath, ".md").toLowerCase();
    if (usedSlash.has(name) || usedSkills.has(name)) continue;
    findings.push(makeFinding({
      type: "ghost_command",
      severity: "low",
      title: `Slash command "/${name}" is defined but never used`,
      confidence: "inferred",
      evidence: { name, filePath, tokens: estimateTokens(readText(filePath) || "") },
      wasted_tokens: 0,
      wasted_cost_usd: 0,
      fix: {
        description: "Archive the unused command definition.",
        pasteable: `mv ${JSON.stringify(filePath)} ${JSON.stringify(path.join(home, ".tokentracker", "optimize", "archive"))}`,
        apply: { kind: "archive_path", src: filePath, safe: true },
      },
    }));
  }

  // ---- R5: CLAUDE.md bloat + @import expansion ----
  for (const mdPath of [path.join(claudeDir, "CLAUDE.md"), path.join(cwd, "CLAUDE.md")]) {
    const text = readText(mdPath);
    if (!text) continue;
    const tokens = estimateTokens(text);
    const imports = [...text.matchAll(/@[^\s]+\.(?:md|txt)\b/g)];
    if (tokens < 1500) continue;
    // Everything after the "budget" still rides along every session as context.
    const budget = 1500;
    const excess = tokens - budget;
    const tokens_across = excess * Math.max(1, sessionCount);
    findings.push(makeFinding({
      type: "claude_md_bloat",
      severity: tokens >= 6000 ? "high" : tokens >= 3000 ? "medium" : "low",
      title: `CLAUDE.md is ~${tokens.toLocaleString()} tokens${imports.length ? ` and expands ${imports.length} @import(s)` : ""}`,
      confidence: "measured",
      evidence: { filePath: mdPath, tokens, import_count: imports.length, budget, sessions: sessionCount },
      wasted_tokens: tokens_across,
      wasted_cost_usd: priceContextTokens(model, tokens_across),
      fix: {
        description: "Move rarely-needed detail into a skill or @import that loads on demand; keep CLAUDE.md to always-true rules.",
        pasteable: pasteableClaudeMdRule("Keep CLAUDE.md lean: move per-task detail into skills/@import, always-on rules only here."),
        apply: null,
      },
    }));
  }

  // ---- R6: repeated re-reads across sessions ----
  const globalReads = new Map(); // file -> {reads, tokens}
  for (const s of sessions) {
    for (const [fp, count] of s.readCounts) {
      const entry = globalReads.get(fp) || { reads: 0, tokensPerRead: 0 };
      entry.reads += count;
      const resultTokens = s.readResultTokens.get(fp) || 0;
      if (resultTokens > 0) entry.tokensPerRead = Math.max(entry.tokensPerRead, Math.round(resultTokens / count));
      globalReads.set(fp, entry);
    }
  }
  const repeats = [...globalReads.entries()]
    .filter(([, v]) => v.reads >= 4)
    .map(([fp, v]) => ({ fp, reads: v.reads, tokensPerRead: v.tokensPerRead }))
    .sort((a, b) => (b.reads - 1) * b.tokensPerRead - (a.reads - 1) * a.tokensPerRead)
    .slice(0, 15);
  for (const { fp, reads, tokensPerRead } of repeats) {
    const redundant = reads - 1;
    const tokens = redundant * (tokensPerRead || estimateTokens(fp) * 60); // fallback size if no captured result
    findings.push(makeFinding({
      type: "repeated_reads",
      severity: tokens >= 100_000 ? "high" : tokens >= 25_000 ? "medium" : "low",
      title: `${fp.split("/").pop()} was Read ${reads} times across sessions`,
      confidence: tokensPerRead ? "measured" : "inferred",
      evidence: { file: fp, reads, tokens_per_read: tokensPerRead },
      wasted_tokens: tokens,
      wasted_cost_usd: priceContextTokens(model, tokens),
      fix: {
        description: "Pin this file's essentials into CLAUDE.md/@import (or a skill) so the model stops re-reading it cold.",
        pasteable: pasteableClaudeMdRule(`When working on ${path.basename(fp)}, its key invariants are already in context — do not re-read it from scratch.`),
        apply: { kind: "append_claude_md", target: path.join(claudeDir, "CLAUDE.md"), rule: `When working on ${path.basename(fp)}, reuse context instead of re-reading it cold.`, safe: true },
      },
    }));
  }

  // ---- R7: edits without a prior read (blind edits -> retries) ----
  let editsTotal = 0;
  let blindEdits = 0;
  for (const s of sessions) { editsTotal += s.edits; blindEdits += s.editsWithoutPriorRead; }
  if (editsTotal >= 10 && blindEdits / editsTotal >= 0.3) {
    const avgTurnTokens = sessionCount ? Math.round((totals.input_tokens + totals.output_tokens) / Math.max(1, sessionCount * 12)) : 3000;
    const tokens = blindEdits * avgTurnTokens;
    findings.push(makeFinding({
      type: "read_before_edit",
      severity: blindEdits / editsTotal >= 0.6 ? "high" : "medium",
      title: `${blindEdits} of ${editsTotal} edits (${Math.round((blindEdits / editsTotal) * 100)}%) happened without reading the file first`,
      confidence: "inferred",
      evidence: { edits: editsTotal, blind_edits: blindEdits },
      wasted_tokens: tokens,
      wasted_cost_usd: priceContextTokens(model, tokens),
      fix: {
        description: "Add a rule that the model Reads a file in the same session before Editing it, to cut edit-retry loops.",
        pasteable: pasteableClaudeMdRule("Always Read a file in this session before Editing it. Do not edit files you have not just read."),
        apply: { kind: "append_claude_md", target: path.join(claudeDir, "CLAUDE.md"), rule: "Always Read a file in the current session before Editing it.", safe: true },
      },
    }));
  }

  // ---- R8: weak prompt-cache hit ratio ----
  const cacheRead = totals.cached_input_tokens;
  const cacheCreate = totals.cache_creation_input_tokens;
  const denom = cacheRead + cacheCreate;
  if (denom >= 50_000 && cacheCreate / denom >= 0.5) {
    // Each avoidable cache_creation is billed at the higher write rate; a healthy
    // setup would have most of this as cache_read. Estimate the overcharge.
    const excess = Math.max(0, cacheCreate - denom * 0.25);
    const pricing = getModelPricing(model, { source: "claude" }) || {};
    const writeRate = pricing.cache_write || 3.75;
    const readRate = pricing.cache_read || 0.3;
    const cost = (excess * (writeRate - readRate)) / 1_000_000;
    findings.push(makeFinding({
      type: "cache_overhead",
      severity: cacheCreate / denom >= 0.7 ? "high" : "medium",
      title: `Prompt cache is cold: ${Math.round((cacheCreate / denom) * 100)}% of cache tokens are writes, not reads`,
      confidence: "measured",
      evidence: { cache_read: cacheRead, cache_creation: cacheCreate, hit_rate: denom ? cacheRead / denom : 0 },
      wasted_tokens: excess,
      wasted_cost_usd: cost,
      fix: {
        description: "Keep a large, stable prefix (system rules, pinned files) at the very top and avoid editing it, so turns reuse one cache instead of re-creating it.",
        pasteable: pasteableClaudeMdRule("Keep the top of the prompt stable and pinned so cache reads, not cache writes, dominate."),
        apply: null,
      },
    }));
  }

  findings.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || (b.wasted_cost_usd - a.wasted_cost_usd));

  const total_cost = findings.reduce((sum, f) => sum + (f.wasted_cost_usd || 0), 0);
  const total_tokens = findings.reduce((sum, f) => sum + (f.wasted_tokens || 0), 0);

  return {
    generated_at: new Date().toISOString(),
    provenance: { home, claude_dir: claudeDir, projects_dir: projectsDir, sessions_scanned: sessionCount, model, confidence: "inferred" },
    totals: { wasted_tokens: total_tokens, wasted_cost_usd: total_cost, findings: findings.length, by_type: byType(findings) },
    findings,
  };
}

// Cross-model waste scan driven by the provider-agnostic queue (works for
// workbuddy / API-aggregator / any tool that writes queue.jsonl). Unlike the
// Claude-config scanner, these rules are about where your SPEND goes:
//   - expensive_share : the priciest model eating a large slice of spend
//   - cache_overhead  : cache writes dominating (only when the source reports them)
//   - unpriced_models : models with no known price (blind spot in your cost view)
//   - day_spike       : an unusually heavy day vs. your recent average
function scanWasteFromQueue(agg) {
  const findings = [];
  const total = agg.totals.cost_usd || 0;
  const priced = (agg.by_model || []).filter((m) => m.priced && m.cost_usd > 0);

  // expensive_share: top priced model by cost, if it dominates
  if (priced.length >= 2 && total > 0) {
    const top = priced[0];
    const share = top.cost_usd / total;
    const cheapest = priced[priced.length - 1];
    if (share >= 0.35) {
      findings.push(makeFinding({
        type: "expensive_share",
        severity: share >= 0.6 ? "high" : "medium",
        title: `${top.model} 占了你 ${Math.round(share * 100)}% 的花费（$${top.cost_usd.toFixed(2)}）`,
        confidence: "measured",
        evidence: { model: top.model, cost_usd: top.cost_usd, share: Math.round(share * 1000) / 10, tokens: top.total_tokens },
        wasted_tokens: 0,
        wasted_cost_usd: 0,
        fix: {
          description: `这是你最大的单项开销。若其中部分是简单/批量任务，可评估迁到更便宜的模型（如 ${cheapest.model}，$${cheapest.cost_usd.toFixed(2)}）来压成本。`,
          pasteable: `# 评估把 ${top.model} 的低难度用量迁移到更便宜的模型`,
          apply: null,
        },
      }));
    }
  }

  // cache_overhead: only when the source reports cache writes
  const cacheDenom = agg.totals.cache_read_tokens + agg.totals.cache_creation_tokens;
  if (agg.totals.cache_creation_tokens > 0 && cacheDenom > 0 && agg.totals.cache_creation_tokens / cacheDenom >= 0.5) {
    const excess = agg.totals.cache_creation_tokens - cacheDenom * 0.25;
    findings.push(makeFinding({
      type: "cache_overhead",
      severity: agg.totals.cache_creation_tokens / cacheDenom >= 0.7 ? "high" : "medium",
      title: `缓存偏冷：${Math.round((agg.totals.cache_creation_tokens / cacheDenom) * 100)}% 的缓存 token 是写入而非命中`,
      confidence: "measured",
      evidence: { cache_read: agg.totals.cache_read_tokens, cache_creation: agg.totals.cache_creation_tokens },
      wasted_tokens: excess,
      wasted_cost_usd: 0,
      fix: { description: "保持提示词前缀稳定、少改动，让多数轮次命中缓存而非重建。", pasteable: "# 稳定 prompt 前缀以提高缓存命中", apply: null },
    }));
  }

  // unpriced_models: cost blind spot
  const unpriced = (agg.by_model || []).filter((m) => !m.priced);
  if (unpriced.length) {
    const tokens = unpriced.reduce((s, m) => s + m.total_tokens, 0);
    findings.push(makeFinding({
      type: "unpriced_models",
      severity: "low",
      title: `${unpriced.length} 个模型没有价格，成本统计里看不到它们的真实花费`,
      confidence: "measured",
      evidence: { models: unpriced.map((m) => m.model), tokens },
      wasted_tokens: tokens,
      wasted_cost_usd: 0,
      fix: { description: "给这些模型补价格（curated-overrides.json）或在对比时按 token 量而非金额看。", pasteable: `# 无价模型：${unpriced.map((m) => m.model).join(", ")}`, apply: null },
    }));
  }

  // day_spike: heaviest day vs. average
  const days = agg.by_day || [];
  if (days.length >= 4) {
    const avg = days.reduce((s, d) => s + d.cost_usd, 0) / days.length;
    const peak = days.reduce((a, b) => (b.cost_usd > a.cost_usd ? b : a), days[0]);
    if (avg > 0 && peak.cost_usd >= avg * 2.5) {
      findings.push(makeFinding({
        type: "day_spike",
        severity: "low",
        title: `${peak.date} 花费 $${peak.cost_usd.toFixed(2)}，是近期日均（$${avg.toFixed(2)}）的 ${(peak.cost_usd / avg).toFixed(1)} 倍`,
        confidence: "measured",
        evidence: { date: peak.date, cost_usd: peak.cost_usd, avg: Math.round(avg * 100) / 100 },
        wasted_tokens: 0,
        wasted_cost_usd: 0,
        fix: { description: "看看那天是否有失控的长会话/大上下文任务，作为预算参考。", pasteable: `# 复核 ${peak.date} 的高用量会话`, apply: null },
      }));
    }
  }

  findings.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || (b.wasted_cost_usd - a.wasted_cost_usd));
  return {
    generated_at: new Date().toISOString(),
    source: "usage-queue",
    provenance: { provider_agnostic: true, sessions_scanned: agg.totals.rows, models: agg.totals.models, sources: agg.totals.sources, model: (agg.by_model[0] && agg.by_model[0].model) || "n/a", confidence: "measured" },
    totals: { wasted_tokens: findings.reduce((s, f) => s + f.wasted_tokens, 0), wasted_cost_usd: 0, findings: findings.length, by_type: byType(findings) },
    findings,
  };
}

const SEVERITY_RANK = { high: 3, medium: 2, low: 1 };

function byType(findings) {
  const out = {};
  for (const f of findings) out[f.type] = (out[f.type] || 0) + 1;
  return out;
}

function pasteableClaudeMdRule(rule) {
  return `# Add to ~/.claude/CLAUDE.md\n${rule}`;
}

function makeFinding({ type, severity, title, confidence, evidence, wasted_tokens, wasted_cost_usd, fix }) {
  return {
    id: `${type}:${String(evidence.name || evidence.file || evidence.filePath || title).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 48)}`,
    type, severity, title, confidence, evidence,
    wasted_tokens: Math.max(0, Math.round(wasted_tokens || 0)),
    wasted_cost_usd: Math.max(0, Number(wasted_cost_usd || 0)),
    fix,
  };
}

module.exports = {
  scanWaste,
  scanWasteFromQueue,
  // exported for tests / reuse:
  parseSession,
  readMcpServers,
  priceContextTokens,
  EDIT_TOOLS,
};
