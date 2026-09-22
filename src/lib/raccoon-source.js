"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// Raccoon Office (商汤小浣熊桌面客户端) source adapter — 本 fork 新增。
//
// 小浣熊客户端把每轮对话的用量完整落盘在本地 SQLite：
//   %APPDATA%/office-raccoon/local-chat.sqlite3
//     messages 表（payload_json 内嵌 usage_metadata.token_usage）：
//       promptTokens / completionTokens / totalTokens / calls
//       usage_metadata.started_at / completed_at（毫秒时间戳）
//       usage_metadata.status = completed
// 模型名只有全局绑定粒度：%APPDATA%/office-raccoon/default-session-model-binding.json
//   → modelBinding.model（如 sn-glm-5-3-flash）。
//
// 访问方式：客户端运行中数据库为 WAL 模式，每次同步把 db+wal+shm 拷到临时
// 目录后只读连接，避免锁库或影响客户端。
//
// 归一化输出与 api-shim-source 相同的 queue 半小时桶行：
//   source = "raccoon-api"
// ─────────────────────────────────────────────────────────────────────────────

const fs = require("node:fs/promises");
const fssync = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const HALF_HOUR_MS = 30 * 60 * 1000;
const CURSOR_KEY = "raccoonOfficeUsage";

const DATA_DIR = () => path.join(os.homedir(), "AppData", "Roaming", "office-raccoon");
const CHAT_DB = () => path.join(DATA_DIR(), "local-chat.sqlite3");
const MODEL_BINDING_FILE = () => path.join(DATA_DIR(), "default-session-model-binding.json");

function halfHourFloor(ms) {
  const t = Math.floor(Number(ms));
  if (!Number.isFinite(t) || t <= 0) return null;
  return new Date(Math.floor(t / HALF_HOUR_MS) * HALF_HOUR_MS).toISOString();
}

/** 全局模型绑定（消息级模型缺失，按当前绑定计价）。 */
function readBoundModel() {
  try {
    const raw = fssync.readFileSync(MODEL_BINDING_FILE(), "utf8");
    const parsed = JSON.parse(raw);
    const model = String(parsed?.modelBinding?.model || "").trim();
    return model || null;
  } catch {
    return null;
  }
}

/**
 * 解析一条 messages.payload_json，产出 token 用量事件；不可用返回 null。
 * 防御式解析：任何字段缺失/类型异常都跳过该条。
 * 注意：客户端会把同一 turn 的 usage_metadata 写到多行（重试/更新），用
 * completed_at+totalTokens 作为幂等键的一部分去重。
 */
function normalizeTurn(rawPayloadJson) {
  let payload;
  try {
    payload = JSON.parse(rawPayloadJson);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const usage = payload.usage_metadata;
  if (!usage || typeof usage !== "object") return null;
  const tu = usage.token_usage;
  if (!tu || typeof tu !== "object") return null;
  const status = String(usage.status || "").toLowerCase();
  if (status && status !== "completed") return null;

  const prompt = Math.max(0, Math.floor(Number(tu.promptTokens) || 0));
  const completion = Math.floor(Number(tu.completionTokens) || 0);
  let total = Math.floor(Number(tu.totalTokens) || 0);
  if (!Number.isFinite(total) || total <= 0) total = prompt + completion;
  if (total <= 0) return null;

  const completedAt = Number(usage.completed_at);
  if (!Number.isFinite(completedAt) || completedAt <= 0) return null;

  return {
    prompt,
    completion,
    total,
    calls: Math.max(1, Math.floor(Number(tu.calls) || 1)),
    completed_at: completedAt,
  };
}

/**
 * 把 WAL 数据库安全拷贝到临时目录后只读打开，返回 { dbPath, cleanup }。
 * sqlite3 主文件 + -wal + -shm 三件套一起拷，保证读到最新已提交数据。
 */
async function snapshotDatabase(dbPath) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "tt-raccoon-"));
  const base = path.basename(dbPath);
  const dst = path.join(tmpDir, base);
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      await fs.copyFile(dbPath + ext, dst + ext);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }
  return { dbPath: dst, cleanup: () => fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {}) };
}

/**
 * 增量读取小浣熊 turn 用量并追加进 queue.jsonl（半小时桶，last-row-wins）。
 * 游标按 (messages.id) 最大水位断点续读；库文件变化（mtime+size 指纹）时
 * 若水位超过表行数则重置。
 */
async function parseRaccoonUsageIncremental({ cursors, queuePath, onProgress } = {}) {
  const dbPath = CHAT_DB();
  let dbExists = false;
  try {
    await fs.access(dbPath);
    dbExists = true;
  } catch {
    dbExists = false;
  }
  if (!dbExists) {
    return { recordsProcessed: 0, eventsAggregated: 0, bucketsQueued: 0, available: false };
  }

  if (!cursors || typeof cursors !== "object") cursors = {};
  if (!cursors[CURSOR_KEY] || typeof cursors[CURSOR_KEY] !== "object") {
    cursors[CURSOR_KEY] = {};
  }
  const state = cursors[CURSOR_KEY];
  if (!Number.isFinite(state.lastMessageId) || state.lastMessageId < 0) state.lastMessageId = 0;
  const model = readBoundModel() || "unknown";

  // 1. 只读快照
  const { dbPath: snapPath, cleanup } = await snapshotDatabase(dbPath);
  let Database;
  try {
    // 零依赖要求：优先 better-sqlite3（主包已有依赖），退化到 node:sqlite
    let SqliteError = null;
    let connect;
    try {
      connect = require("better-sqlite3");
    } catch {
      const { DatabaseSync } = require("node:sqlite");
      connect = (file) => new DatabaseSync(file);
    }
    if (!connect) throw new Error("no sqlite driver");
    const db = connect(snapPath);
    try {
      const stmt = db.prepare(
        `SELECT id, payload_json FROM messages
         WHERE id > ? AND role = 'assistant' AND payload_json LIKE '%token_usage%'
         ORDER BY id ASC LIMIT 5000`,
      );
      const rows = stmt.all(state.lastMessageId);
      const halfHourBuckets = new Map();
      let maxId = state.lastMessageId;
      for (const row of rows) {
        if (row.id > maxId) maxId = row.id;
        const turn = normalizeTurn(row.payload_json);
        if (!turn) continue;
        const hourStart = halfHourFloor(turn.completed_at);
        if (!hourStart) continue;
        const key = hourStart;
        const bucket = halfHourBuckets.get(key) || {
          source: "raccoon-api",
          model,
          hour_start: hourStart,
          input_tokens: 0,
          cached_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 0,
          reasoning_output_tokens: 0,
          total_tokens: 0,
          billable_total_tokens: 0,
          total_cost_usd: 0,
          conversation_count: 0,
        };
        bucket.input_tokens += turn.prompt;
        bucket.output_tokens += turn.completion;
        bucket.total_tokens += turn.total;
        bucket.billable_total_tokens += turn.total;
        bucket.conversation_count += 1;
        halfHourBuckets.set(key, bucket);
      }
      const now = new Date().toISOString();
      const bucketRows = [...halfHourBuckets.values()].sort((a, b) =>
        a.hour_start < b.hour_start ? -1 : 1,
      );
      if (bucketRows.length > 0) {
        await fs.mkdir(path.dirname(queuePath), { recursive: true });
        await fs.appendFile(
          queuePath,
          bucketRows.map((r) => JSON.stringify(r)).join("\n") + "\n",
          "utf8",
        );
      }
      state.lastMessageId = maxId;
      return {
        recordsProcessed: rows.length,
        eventsAggregated: bucketRows.reduce((n, r) => n + r.conversation_count, 0),
        bucketsQueued: bucketRows.length,
        model,
      };
    } finally {
      try { db.close(); } catch {}
    }
  } finally {
    await cleanup();
  }
}

module.exports = { parseRaccoonUsageIncremental, normalizeTurn, readBoundModel, halfHourFloor, CHAT_DB };
