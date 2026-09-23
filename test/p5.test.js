"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");

const ds = require("../src/lib/device-sync");

const TRACKER = path.join(__dirname, "..", "bin", "tracker.js");
const PORT = 7788 + (process.pid % 50); // avoid clashing with a dev server

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request(
      { host: "127.0.0.1", port: PORT, path: urlPath, method, headers: data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {} },
      (res) => {
        let buf = "";
        res.on("data", (c) => { buf += c; if (urlPath === "/api/p5/device/events") { res.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: buf }); } });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      },
    );
    r.on("error", reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForServer(tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try { await req("GET", "/api/p5/device/state"); return; } catch { await new Promise((r) => setTimeout(r, 250)); }
  }
  throw new Error("server did not start");
}

test("device-sync: pin pairing, reject, merge, prune", () => {
  ds.reset();
  const { pin } = ds.newPin();
  assert.match(pin, /^[A-Z2-9]{4}$/);
  const ok = ds.join({ pin, id: "a", label: "laptop", totals: { cost_usd: 1.2, total_tokens: 500, sessions: 1 } });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ds.join({ pin: "ZZZZ", id: "b", totals: {} }).ok, false);
  ds.upsertDevice({ id: "c", label: "desktop", totals: { cost_usd: 0.8, total_tokens: 300, sessions: 2 } });
  const merged = ds.mergedTotals();
  assert.strictEqual(merged.cost_usd, 2); // 1.2 + 0.8
  assert.strictEqual(merged.total_tokens, 800);
  assert.strictEqual(merged.sessions, 3);
  // stale devices drop out
  assert.strictEqual(ds.pruneStale(Date.now() + ds.DEVICE_STALE_MS + 1), true);
  assert.strictEqual(ds.snapshot().devices.length, 0);
  ds.reset();
});

test("p5 HTTP endpoints serve over the real local server", async () => {
  const child = spawn(process.execPath, [TRACKER, "serve", "--port", String(PORT), "--no-open", "--no-sync"], { stdio: "ignore" });
  try {
    await waitForServer();

    // The repo ships these as data endpoints consumed by the React dashboard
    // (no standalone p5.html page here); assert the endpoint contract.
    const snap = await req("GET", "/api/p5/snapshot");
    assert.strictEqual(snap.status, 200);
    const s = JSON.parse(snap.body);
    for (const key of ["sessions", "cost_usd", "cache_hit_rate", "top_models", "equivalents", "roi", "savings"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(s, key), `snapshot has ${key}`);
    }

    const report = await req("GET", "/api/p5/report");
    assert.strictEqual(report.status, 200);
    assert.match(report.headers["content-type"], /text\/plain/);

    const pinRes = JSON.parse((await req("POST", "/api/p5/device/pin")).body);
    assert.match(pinRes.pin, /^[A-Z2-9]{4}$/);
    const join = JSON.parse((await req("POST", "/api/p5/device/join", { pin: pinRes.pin, id: "dev1", label: "x", totals: { cost_usd: 5, total_tokens: 1000, sessions: 2 } })).body);
    assert.strictEqual(join.ok, true);
    const bad = await req("POST", "/api/p5/device/join", { pin: "0000", id: "y" });
    assert.strictEqual(bad.status, 401);
    const state = JSON.parse((await req("GET", "/api/p5/device/state")).body);
    assert.ok(state.devices.some((d) => d.id === "dev1"));
    assert.strictEqual(state.merged.cost_usd, 5);

    const sse = await req("GET", "/api/p5/device/events");
    assert.strictEqual(sse.status, 200);
    assert.match(sse.headers["content-type"], /text\/event-stream/);
    assert.ok(sse.body.startsWith(": ok"));
  } finally {
    child.kill("SIGKILL");
  }
});
