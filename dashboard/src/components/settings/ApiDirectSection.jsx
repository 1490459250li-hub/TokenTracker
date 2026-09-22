import React, { useCallback, useEffect, useState } from "react";
import { SectionCard } from "./Controls.jsx";
import { getLocalApiAuthHeaders } from "../../lib/local-api-auth.ts";

/**
 * API 直连分区（本 fork 新增）：
 *   - 各上游的 API Key（写入 shim config.json，保存后热重载 shim）
 *   - 模型单价覆盖（USD/百万 token，写入 pricing.json 热生效）
 *   - key 连接测试（对上游发最小探活请求，走 local-auth 授权）
 * 所有 key 只存本地、只发给对应上游。
 */

const inputClass =
  "w-full rounded-lg border border-oai-gray-300 dark:border-oai-gray-700 bg-white dark:bg-oai-gray-800 px-2.5 py-1.5 text-sm text-oai-black dark:text-oai-white focus:outline-none focus:ring-2 focus:ring-oai-brand-500";

const UPSTREAMS = [
  { key: "deepseek", label: "DeepSeek", hint: "platform.deepseek.com，sk- 开头", consoleUrl: "https://platform.deepseek.com" },
  { key: "mimo", label: "Xiaomi MiMo · Token Plan 套餐", hint: "Token Plan 专属 key（token-plan 页面获取，与按量 key 不通用），客户端 base_url 指向 http://127.0.0.1:17444/mimo", consoleUrl: "https://platform.xiaomimimo.com" },
  { key: "mimo-payg", label: "Xiaomi MiMo · 按量计费", hint: "开放平台普通 API Key（api.xiaomimimo.com，按 token 计费），客户端 base_url 指向 http://127.0.0.1:17444/mimo-payg", consoleUrl: "https://platform.xiaomimimo.com" },
  { key: "sensenova", label: "商汤日日新", hint: "platform.sensenova.cn/console/keys，sk- 开头", consoleUrl: "https://platform.sensenova.cn/console/keys" },
];

const PRICE_MODELS = [
  "mimo-v2.5",
  "mimo-v2.5-pro",
  "sensenova-6.7-flash-lite",
  "sensenova-6.8-flash-lite",
];

export function ApiDirectSection() {
  const [keysInfo, setKeysInfo] = useState(null);
  const [keyDrafts, setKeyDrafts] = useState({});
  const [prices, setPrices] = useState({});
  const [customModels, setCustomModels] = useState([]);
  const [shimRunning, setShimRunning] = useState(null);
  const [saving, setSaving] = useState("");
  const [savedHint, setSavedHint] = useState("");
  // key 连接测试：{ [upstream]: { busy, ok, status, duration_ms, error } }
  const [keyTests, setKeyTests] = useState({});

  const testKey = useCallback(async (upstreamKey) => {
    setKeyTests((prev) => ({ ...prev, [upstreamKey]: { busy: true } }));
    try {
      // 测试端点走 local-auth 授权（与写操作同级），缺失时返回 403 unauthorized
      const auth = await getLocalApiAuthHeaders();
      const res = await fetch("/functions/tokentracker-api-keys-test", {
        method: "POST",
        headers: { "content-type": "application/json", ...auth },
        body: JSON.stringify({ upstream: upstreamKey }),
      });
      const data = await res.json().catch(() => ({ ok: false, error: "响应解析失败" }));
      setKeyTests((prev) => ({ ...prev, [upstreamKey]: {
        busy: false,
        ok: Boolean(data.ok),
        status: data.status,
        duration_ms: data.duration_ms,
        error: data.error || null,
      }}));
    } catch (e) {
      setKeyTests((prev) => ({ ...prev, [upstreamKey]: { busy: false, ok: false, error: String(e?.message || e) } }));
    }
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [keysRes, pricingRes] = await Promise.all([
        fetch("/functions/tokentracker-api-keys", { cache: "no-store" }),
        fetch("/functions/tokentracker-api-pricing", { cache: "no-store" }),
      ]);
      if (keysRes.ok) setKeysInfo(await keysRes.json());
      if (pricingRes.ok) {
        const data = await pricingRes.json();
        setPrices(data.models || {});
      }
    } catch { /* local-only */ }
    try {
      const res = await fetch("http://127.0.0.1:17444/healthz", { signal: AbortSignal.timeout(3000) });
      setShimRunning(res.ok);
    } catch {
      setShimRunning(false);
    }
  }, []);

  useEffect(() => { void loadAll(); }, [loadAll]);

  const saveKeys = useCallback(async () => {
    setSaving("keys");
    try {
      const upstreams = {};
      for (const [key, value] of Object.entries(keyDrafts)) {
        if (value && value.trim()) upstreams[key] = { api_key: value.trim() };
      }
      if (Object.keys(upstreams).length === 0) return;
      await fetch("/functions/tokentracker-api-keys", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ upstreams }),
      });
      setKeyDrafts({});
      setSavedHint("API Key 已保存");
      await loadAll();
    } finally {
      setSaving("");
    }
  }, [keyDrafts, loadAll]);

  const savePrices = useCallback(async () => {
    setSaving("prices");
    try {
      const models = Object.entries(prices).map(([model, p]) => ({
        model, input: p.input, output: p.output,
      }));
      await fetch("/functions/tokentracker-api-pricing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ models }),
      });
      setSavedHint("模型单价已保存并生效");
    } finally {
      setSaving("");
    }
  }, [prices]);

  const priceRows = PRICE_MODELS.filter((m) => !customModels.includes(m) || prices[m]);
  const allPriceRows = [...new Set([...priceRows, ...customModels])];

  return (
    <div className="space-y-4">
      <SectionCard title="API 直连">
        <div className="space-y-4">
          {/* shim 运行状态 */}
          <div className="flex items-center justify-between text-sm">
            <span className="text-oai-gray-500 dark:text-oai-gray-400">本地记账代理</span>
            {shimRunning == null ? (
              <span className="text-oai-gray-400">检查中…</span>
            ) : shimRunning ? (
              <span className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400">
                <span className="h-2 w-2 rounded-full bg-emerald-500" /> 运行中 · 端口 17444
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
                <span className="h-2 w-2 rounded-full bg-amber-500" /> 未运行（开机自启任务会拉起）
              </span>
            )}
          </div>

          {/* API Key 输入 */}
          {UPSTREAMS.map((u) => {
            const info = keysInfo?.upstreams?.[u.key];
            const draft = keyDrafts[u.key] || "";
            return (
              <div key={u.key} className="rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 p-3">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-sm font-medium">{u.label}</span>
                  <a href={u.consoleUrl} target="_blank" rel="noreferrer"
                     className="inline-flex items-center gap-1 text-xs text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-black dark:hover:text-white no-underline">
                    获取 Key <ExternalLinkIcon />
                  </a>
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="password"
                    className={inputClass}
                    placeholder={info?.has_key ? `已保存（${info.key_masked}）` : "尚未填写"}
                    value={draft}
                    onChange={(e) => setKeyDrafts((prev) => ({ ...prev, [u.key]: e.target.value }))}
                  />
                  <button
                    type="button"
                    onClick={() => void testKey(u.key)}
                    disabled={!info?.has_key || keyTests[u.key]?.busy}
                    title={info?.has_key ? "对上游发一个最小请求，验证 key 是否可用" : "先保存 key 再测试"}
                    className="shrink-0 inline-flex items-center rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 px-2.5 py-1.5 text-xs font-medium text-oai-gray-600 dark:text-oai-gray-300 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 disabled:opacity-40 transition-colors"
                  >
                    {keyTests[u.key]?.busy ? "测试中…" : "测试"}
                  </button>
                </div>
                {keyTests[u.key] && !keyTests[u.key].busy ? (
                  <p className={`mt-1 text-[11px] ${keyTests[u.key].ok ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}>
                    {keyTests[u.key].ok
                      ? `✓ 连接成功（HTTP ${keyTests[u.key].status}，${keyTests[u.key].duration_ms}ms）`
                      : `✗ ${keyTests[u.key].error || "连接失败"}`}
                  </p>
                ) : null}
                <p className="mt-1 text-[11px] text-oai-gray-400 dark:text-oai-gray-500">{u.hint} · key 只存本机、只发给对应上游</p>
              </div>
            );
          })}

          <button
            type="button"
            onClick={() => void saveKeys()}
            disabled={saving === "keys" || Object.keys(keyDrafts).length === 0}
            className="inline-flex items-center rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 px-3 py-1.5 text-xs font-medium text-oai-gray-600 dark:text-oai-gray-300 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 disabled:opacity-40 transition-colors"
          >
            {saving === "keys" ? "保存中…" : "保存 API Key"}
          </button>
        </div>
      </SectionCard>

      <SectionCard title="模型单价（USD / 百万 token）">
        <div className="space-y-3">
          {allPriceRows.map((model) => (
            <div key={model} className="grid grid-cols-[1fr_5rem_5rem] gap-2 items-center">
              <span className="text-xs text-oai-gray-600 dark:text-oai-gray-300 truncate" title={model}>{model}</span>
              <input
                type="number" min="0" step="0.01" placeholder="输入"
                className={inputClass}
                value={prices[model]?.input ?? ""}
                onChange={(e) => setPrices((prev) => ({
                  ...prev, [model]: { ...prev[model], input: Number(e.target.value) || 0 },
                }))}
              />
              <input
                type="number" min="0" step="0.01" placeholder="输出"
                className={inputClass}
                value={prices[model]?.output ?? ""}
                onChange={(e) => setPrices((prev) => ({
                  ...prev, [model]: { ...prev[model], output: Number(e.target.value) || 0 },
                }))}
              />
            </div>
          ))}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setCustomModels((prev) => [...prev, `custom-${prev.length + 1}`])}
              className="text-xs text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-black dark:hover:text-white"
            >
              + 添加其他模型
            </button>
            <button
              type="button"
              onClick={() => void savePrices()}
              disabled={saving === "prices"}
              className="inline-flex items-center rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 px-3 py-1.5 text-xs font-medium text-oai-gray-600 dark:text-oai-gray-300 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 disabled:opacity-40 transition-colors"
            >
              {saving === "prices" ? "保存中…" : "保存单价"}
            </button>
            {savedHint ? <span className="text-xs text-emerald-600 dark:text-emerald-400">{savedHint}</span> : null}
          </div>
          <p className="text-[11px] text-oai-gray-400 dark:text-oai-gray-500 leading-relaxed">
            DeepSeek 官方模型单价已内置（含峰谷时段折扣），无需填写。保存后立即对成本计算生效，无需重启。
          </p>
        </div>
      </SectionCard>
    </div>
  );
}

function ExternalLinkIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}
