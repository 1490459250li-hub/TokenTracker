#!/usr/bin/env node
"use strict";

// ─────────────────────────────────────────────────────────────────────────────
// TokenTracker API shim — local reverse proxy with per-request usage accounting.
//
// Direct API calls (DeepSeek, Xiaomi MiMo, any OpenAI-compatible endpoint) never
// leave local session logs, so the passive readers in rollout.js cannot see
// them. This shim fills that gap: your app points its base_url at this proxy,
// which forwards requests verbatim to the real upstream and appends one JSON
// line per request to a local usage log. The sync pipeline
// (src/lib/api-shim-source.js) picks that log up and feeds the dashboard.
//
//   your app ──> http://127.0.0.1:<port>/<upstream-key>/... ──> real upstream
//                        │  reads the response `usage` object (exact counts,
//                        │  never estimated) and appends one JSONL row
//                        ▼
//        ~/.tokentracker/api-shim/usage.jsonl
//
// Privacy: prompts/responses are forwarded untouched and NEVER written to disk.
// Only token counts, model name, status, and latency are recorded. API keys
// live in the local config file and are only sent to the configured upstream.
//
// Zero npm dependencies. Run:  node src/api-shim/server.js [--config <path>]
// ─────────────────────────────────────────────────────────────────────────────

const http = require("node:http");
const https = require("node:https");
const fs = require("node:fs");
const fsp = fs.promises;
const os = require("node:os");
const path = require("node:path");

const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  ".tokentracker",
  "api-shim",
  "config.json",
);
const DEFAULT_LOG_PATH = path.join(
  os.homedir(),
  ".tokentracker",
  "api-shim",
  "usage.jsonl",
);
const MAX_BUFFERED_RESPONSE_BYTES = 32 * 1024 * 1024;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--config") out.config = argv[++i];
    else if (arg.startsWith("--config=")) out.config = arg.slice("--config=".length);
    else if (arg === "--port") out.port = Number(argv[++i]);
    else if (arg.startsWith("--port=")) out.port = Number(arg.slice("--port=".length));
  }
  return out;
}

function resolveConfigPath(explicit) {
  if (explicit) return path.resolve(explicit);
  const candidates = [
    DEFAULT_CONFIG_PATH,
    path.resolve(process.cwd(), "api-shim.config.json"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function normalizeUpstream(key, raw) {
  if (!raw || typeof raw !== "object") return null;
  const base = String(raw.base_url || raw.baseUrl || "").trim();
  if (!base) return null;
  return {
    key,
    base_url: base.replace(/\/+$/, ""),
    api_key: String(raw.api_key || raw.apiKey || ""),
    label: String(raw.label || key),
    inject_include_usage: raw.inject_include_usage !== false,
  };
}

async function loadConfig(explicitPath, portOverride) {
  const configPath = resolveConfigPath(explicitPath);
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Failed to read config ${configPath}: ${err.message}`);
    }
  }
  const upstreams = {};
  for (const [key, value] of Object.entries(raw.upstreams || {})) {
    const upstream = normalizeUpstream(key, value);
    if (upstream) upstreams[key] = upstream;
  }
  if (Object.keys(upstreams).length === 0) {
    throw new Error(
      `No upstreams configured. Edit ${configPath} (see src/api-shim/config.example.json).`,
    );
  }
  return {
    configPath,
    host: raw.host || "127.0.0.1",
    port: Number(portOverride || raw.port || 17444),
    log_path: raw.log_path
      ? path.resolve(raw.log_path)
      : path.join(path.dirname(configPath), "usage.jsonl"),
    upstreams,
  };
}

// Map an OpenAI-compatible `usage` object onto the tracker's token columns.
function mapUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const detailsIn = usage.prompt_tokens_details || {};
  const detailsOut = usage.completion_tokens_details || {};
  const input = Number(usage.prompt_tokens) || 0;
  const cached = Number(detailsIn.cached_tokens) || 0;
  const output = Number(usage.completion_tokens) || 0;
  const reasoning = Number(detailsOut.reasoning_tokens) || 0;
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    cache_creation_input_tokens: 0,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: Number(usage.total_tokens) || input + output,
  };
}

function makeUsageScanner() {
  let tail = "";
  let lastUsage = null;
  // Extract one balanced JSON object starting at `start` (the `"` of "usage").
  // Returns { obj, end } or null when the stream has not delivered the whole
  // object yet. Handles nested braces and strings with escapes.
  const extractObject = (text, start) => {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const braceStart = text.indexOf("{", start);
          return { obj: text.slice(braceStart, i + 1), end: i + 1 };
        }
      }
    }
    return null;
  };
  return {
    feed(text) {
      tail += text;
      let guard = 0;
      while (guard++ < 64) {
        const idx = tail.indexOf('"usage"');
        if (idx === -1) {
          if (tail.length > 65536) tail = tail.slice(-1024);
          return;
        }
        const found = extractObject(tail, idx);
        if (!found) {
          tail = tail.slice(idx);
          if (tail.length > 262144) tail = tail.slice(-1024);
          return;
        }
        try {
          const parsed = JSON.parse(found.obj);
          if (parsed && typeof parsed === "object") lastUsage = parsed;
        } catch {
          /* malformed fragment — keep scanning */
        }
        tail = tail.slice(found.end);
      }
    },
    get usage() {
      return lastUsage;
    },
  };
}

const CORS_HEADERS = { "access-control-allow-origin": "*" };

class UsageLog {
  constructor(logPath) {
    this.logPath = logPath;
    this.ready = fsp
      .mkdir(path.dirname(logPath), { recursive: true })
      .then(() => fsp.appendFile(logPath, ""))
      .catch((err) => {
        process.stderr.write(`[api-shim] log init failed: ${err.message}\n`);
      });
  }
  async append(row) {
    await this.ready;
    try {
      await fsp.appendFile(this.logPath, `${JSON.stringify(row)}\n`, "utf8");
    } catch (err) {
      process.stderr.write(`[api-shim] log append failed: ${err.message}\n`);
    }
  }
}

function forward(upstream, req, res, bodyBuffer, log) {
  const isStream = /"stream"\s*:\s*true/.test(bodyBuffer.toString("utf8"));
  let payload = bodyBuffer;
  if (isStream && upstream.inject_include_usage) {
    try {
      const parsed = JSON.parse(bodyBuffer.toString("utf8"));
      if (!parsed.stream_options || typeof parsed.stream_options !== "object") {
        parsed.stream_options = { include_usage: true };
        payload = Buffer.from(JSON.stringify(parsed), "utf8");
      }
    } catch {
      /* forward the body untouched if it is not valid JSON */
    }
  }
  const target = new URL(upstream.base_url + req.url.slice(upstream.prefix.length));
  const isHttps = target.protocol === "https:";
  const headers = { ...req.headers };
  delete headers.host;
  delete headers["content-length"];
  delete headers.authorization;
  delete headers["x-api-key"];
  if (upstream.api_key) headers.authorization = `Bearer ${upstream.api_key}`;
  headers["content-length"] = Buffer.byteLength(payload);

  const lib = isHttps ? https : http;
  const upstreamReq = lib.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers,
    },
    (upstreamRes) => {
      const started = Date.now();
      res.writeHead(upstreamRes.statusCode || 502, { ...upstreamRes.headers, ...CORS_HEADERS });
      const contentType = String(
        upstreamRes.headers["content-type"] || "",
      ).toLowerCase();
      const scanner = makeUsageScanner();
      const finish = () => {
        const usage = mapUsage(scanner.usage);
        if (usage) {
          void log.append({
            ts: new Date().toISOString(),
            source: `${upstream.key}-api`,
            model: String(lastModel || ""),
            ...usage,
            status: upstreamRes.statusCode || 0,
            duration_ms: Date.now() - started,
            stream: isStream,
          });
        }
      };
      let lastModel = "";
      if (contentType.includes("text/event-stream")) {
        upstreamRes.on("data", (chunk) => {
          scanner.feed(chunk.toString("utf8"));
          const m = /"model":"([^"]+)"/.exec(chunk.toString("utf8"));
          if (m) lastModel = m[1];
        });
        upstreamRes.on("end", finish);
        upstreamRes.pipe(res);
      } else {
        const chunks = [];
        let size = 0;
        upstreamRes.on("data", (chunk) => {
          size += chunk.length;
          if (size <= MAX_BUFFERED_RESPONSE_BYTES) chunks.push(chunk);
        });
        upstreamRes.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          scanner.feed(body);
          const m = /"model"\s*:\s*"([^"]+)"/.exec(body);
          if (m) lastModel = m[1];
          finish();
          res.end(Buffer.from(body, "utf8"));
        });
        upstreamRes.on("error", () => res.end());
      }
    },
  );
  upstreamReq.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: { message: `upstream error: ${err.message}` } }));
  });
  upstreamReq.end(payload);
}

function createServer(config, log, reloadConfig) {
  const upstreamPrefixes = new Map();
  function rebuildPrefixes() {
    upstreamPrefixes.clear();
    for (const upstream of Object.values(config.upstreams)) {
      upstream.prefix = `/${upstream.key}`;
      upstreamPrefixes.set(`/${upstream.key}`, upstream);
    }
  }
  rebuildPrefixes();
    return http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        ...CORS_HEADERS,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "*",
      });
      res.end();
      return;
    }
    if (req.method === "GET" && req.url === "/healthz") {
      res.writeHead(200, { "content-type": "application/json", ...CORS_HEADERS });
      res.end(
        JSON.stringify({
          ok: true,
          log: config.log_path,
          upstreams: Object.fromEntries(
            Object.values(config.upstreams).map((u) => [
              u.key,
              { base_url: u.base_url, prefix: u.prefix },
            ]),
          ),
        }),
      );
      return;
    }
    // 热重载：设置页保存 API key 后由 dashboard 调用，免重启生效
    if (req.method === "POST" && req.url === "/reload") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        try {
          const fresh = await reloadConfig();
          res.writeHead(200, { "content-type": "application/json", ...CORS_HEADERS });
          res.end(JSON.stringify({
            ok: true,
            upstreams: Object.keys(fresh.upstreams),
            log: fresh.log_path,
          }));
        } catch (err) {
          res.writeHead(500, { "content-type": "application/json", ...CORS_HEADERS });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }
    const prefix = `/${req.url.split("/").filter(Boolean)[0] || ""}`;
    const upstream = upstreamPrefixes.get(prefix);
    if (!upstream) {
      res.writeHead(404, { "content-type": "application/json", ...CORS_HEADERS });
      res.end(
        JSON.stringify({
          error: {
            message: `unknown upstream prefix '${prefix}'. Known: ${[...upstreamPrefixes.keys()].join(", ")}`,
          },
        }),
      );
      return;
    }
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BUFFERED_RESPONSE_BYTES) chunks.push(chunk);
    });
    req.on("end", () => {
      forward(upstream, req, res, Buffer.concat(chunks), log);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const config = await loadConfig(args.config, args.port);
  const log = new UsageLog(config.log_path);
  const reloadConfig = async () => {
    const fresh = await loadConfig(args.config, args.port);
    Object.assign(config, fresh);
    return config;
  };
  const server = createServer(config, log, reloadConfig);
  server.listen(config.port, config.host, () => {
    console.log(`[api-shim] listening on http://${config.host}:${config.port}`);
    for (const upstream of Object.values(config.upstreams)) {
      console.log(`[api-shim]   ${upstream.prefix}/...  ->  ${upstream.base_url}`);
    }
    console.log(`[api-shim] usage log: ${config.log_path}`);
    console.log(
      `[api-shim] point your client's base_url at http://${config.host}:${config.port}/<upstream-key>`,
    );
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`[api-shim] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { mapUsage, makeUsageScanner, loadConfig, createServer };
