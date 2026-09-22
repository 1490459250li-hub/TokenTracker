import React, { useCallback, useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { copy } from "../lib/copy";
import { ProviderIcon } from "../ui/dashboard/components/ProviderIcon.jsx";

/**
 * API 直连套餐限额卡（DeepSeek 余额/预算、MiMo 月度 Credits、日日新 5h 调用窗口）。
 * 数据：usageLimits.apiPlans（shim 记账聚合）+ /functions/tokentracker-api-plans（用户设置）。
 * 所有输入留占位，由用户在界面上填写，保存到 ~/.tokentracker/api-shim/budgets.json。
 */

const IS_LOCAL_HOST =
  typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");

function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + "B";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function Card({ icon, title, subtitle, children, link }) {
  return (
    <div className="rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 bg-white dark:bg-oai-gray-900 p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <ProviderIcon provider={icon} size={20} />
          <div className="min-w-0">
            <div className="font-medium text-sm sm:text-base truncate">{title}</div>
            {subtitle ? (
              <div className="text-xs text-oai-gray-500 dark:text-oai-gray-400 truncate">{subtitle}</div>
            ) : null}
          </div>
        </div>
        {link ? (
          <a
            href={link}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 inline-flex items-center gap-1 text-xs text-oai-gray-500 dark:text-oai-gray-400 hover:text-oai-black dark:hover:text-white no-underline"
          >
            控制台 <ExternalLink className="h-3 w-3" />
          </a>
        ) : null}
      </div>
      {children}
    </div>
  );
}

const inputClass =
  "w-full rounded-lg border border-oai-gray-300 dark:border-oai-gray-700 bg-white dark:bg-oai-gray-800 px-2.5 py-1.5 text-sm text-oai-black dark:text-oai-white focus:outline-none focus:ring-2 focus:ring-oai-brand-500";

function pctColor(pct) {
  if (pct >= 90) return "text-red-600 dark:text-red-400";
  if (pct >= 70) return "text-amber-600 dark:text-amber-400";
  return "text-emerald-600 dark:text-emerald-400";
}

/**
 * 迷你趋势线（纯 SVG，零依赖）。
 * values: 数字数组（时间从左到右）；空数据或全 0 时返回 null 不占位。
 */
function Sparkline({ values, label, strokeClass }) {
  const data = Array.isArray(values) ? values.filter((v) => Number.isFinite(v)) : [];
  const hasData = data.length >= 2 && data.some((v) => v > 0);
  if (!hasData) return null;
  const w = 100;
  const h = 26;
  const max = Math.max(...data);
  const step = w / (data.length - 1);
  // 面积 + 描边，贴合卡片轻量风格
  const pts = data.map((v, i) => `${(i * step).toFixed(2)},${(h - 2 - (max > 0 ? (v / max) * (h - 6) : 0)).toFixed(2)}`);
  const line = `M ${pts.join(" L ")}`;
  const area = `${line} L ${w},${h} L 0,${h} Z`;
  return (
    <div className="pt-1">
      <div className="flex justify-between text-[10px] text-oai-gray-400 dark:text-oai-gray-500 mb-0.5">
        <span>{label}</span>
        <span>峰值 {formatTokens(max)}</span>
      </div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[26px]" preserveAspectRatio="none" aria-hidden="true">
        <path d={area} fill="currentColor" className={strokeClass} opacity="0.12" />
        <path d={line} fill="none" stroke="currentColor" className={strokeClass} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </div>
  );
}

export function ApiPlanCards({ apiPlans }) {
  const [budgets, setBudgets] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [toast, setToast] = useState(null); // { kind: "ok" | "err", msg }
  const [draft, setDraft] = useState(null);

  const loadBudgets = useCallback(async () => {
    try {
      const res = await fetch("/functions/tokentracker-api-plans", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setBudgets(data);
      setDraft(JSON.parse(JSON.stringify(data)));
    } catch {
      /* local-only endpoint; web surface never gets here */
    }
  }, []);

  useEffect(() => {
    if (IS_LOCAL_HOST) void loadBudgets();
  }, [loadBudgets]);

  // toast 自动消失（3 秒）
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  const save = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const res = await fetch("/functions/tokentracker-api-plans", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSavedAt(new Date());
      setBudgets(JSON.parse(JSON.stringify(draft)));
      setToast({ kind: "ok", msg: "套餐设置已保存" });
    } catch (err) {
      setToast({ kind: "err", msg: `保存失败：${String(err && err.message ? err.message : err)}` });
    } finally {
      setSaving(false);
    }
  }, [draft]);

  if (!IS_LOCAL_HOST) return null;
  if (!budgets || !draft) return null;

  const plans = apiPlans?.plans || {};
  const deepseek = plans.deepseek || {};
  const mimo = plans.mimo || {};
  const sensenova = plans.sensenova || {};

  const updateDraft = (fn) => setDraft((prev) => {
    const next = JSON.parse(JSON.stringify(prev));
    fn(next);
    return next;
  });

  const dirty = JSON.stringify(budgets) !== JSON.stringify(draft);

  // ── DeepSeek ──
  const dsBudget = Number(draft.deepseek?.budgetUsd) || 0;
  const dsSpend = Number(deepseek.spend_today_usd) || 0;
  const dsPct = dsBudget > 0 ? Math.min(100, (dsSpend / dsBudget) * 100) : 0;

  // ── MiMo ──
  const mimoPlan = Number(draft.mimo?.planCredits) || 0;
  const mimoUsed = Number(mimo.credits_used) || 0;
  const mimoPct = mimoPlan > 0 ? Math.min(100, (mimoUsed / mimoPlan) * 100) : 0;

  // ── SenseNova ──
  const snWindow = Number(draft.sensenova?.windowHours) || 5;
  const snDefaultCalls = Number(draft.sensenova?.callsPerWindow) || 1500;
  const snModels = (sensenova.models || []).slice(0, 4);

  return (
    <div className="mb-8">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-lg font-semibold text-oai-black dark:text-white">API 直连套餐</h2>
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="inline-flex items-center rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 px-3 py-1.5 text-xs font-medium text-oai-gray-600 dark:text-oai-gray-300 hover:bg-oai-gray-100 dark:hover:bg-oai-gray-800 disabled:opacity-40 transition-colors"
        >
          {saving ? "保存中…" : dirty ? "保存设置" : savedAt ? "已保存" : "无改动"}
        </button>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {toast ? (
          <div
            role="status"
            aria-live="polite"
            className={`fixed bottom-6 right-6 z-50 rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg border ${
              toast.kind === "ok"
                ? "bg-emerald-50 dark:bg-emerald-950 border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300"
                : "bg-red-50 dark:bg-red-950 border-red-300 dark:border-red-700 text-red-700 dark:text-red-300"
            }`}
          >
            {toast.msg}
          </div>
        ) : null}
        <Card icon="DEEPSEEK-API" title="DeepSeek" subtitle="按量计费 · 余额与预算" link="https://platform.deepseek.com">
          <div className="space-y-2.5 text-sm">
            <div className="flex justify-between">
              <span className="text-oai-gray-500 dark:text-oai-gray-400">官方余额</span>
              <span className="font-medium">
                {deepseek.balance != null
                  ? `${Number(deepseek.balance).toFixed(2)} ${deepseek.balance_currency || ""}`
                  : "—"}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-oai-gray-500 dark:text-oai-gray-400">今日已用</span>
              <span className="font-medium">${dsSpend.toFixed(4)}</span>
            </div>
            <div>
              <label className="block text-xs text-oai-gray-500 dark:text-oai-gray-400 mb-1">
                预算线（美元，0 = 不显示进度）
              </label>
              <input
                type="number" min="0" step="1"
                className={inputClass}
                value={draft.deepseek?.budgetUsd ?? ""}
                onChange={(e) => updateDraft((d) => { d.deepseek = d.deepseek || {}; d.deepseek.budgetUsd = Number(e.target.value) || 0; })}
                placeholder="例如 50"
              />
            </div>
            {dsBudget > 0 ? (
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-oai-gray-500 dark:text-oai-gray-400">预算消耗</span>
                  <span className={`pct font-medium ${pctColor(dsPct)}`}>{dsPct.toFixed(1)}%</span>
                </div>
                <div className="h-2 rounded-full bg-oai-gray-200 dark:bg-oai-gray-800 overflow-hidden">
                  <div className={`h-full rounded-full ${dsPct >= 90 ? "bg-red-500" : dsPct >= 70 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${dsPct}%` }} />
                </div>
              </div>
            ) : null}
            <Sparkline values={deepseek.hourly_spend_usd} label="今日花费走势（按小时）" strokeClass="text-emerald-500" />
          </div>
        </Card>

        <Card icon="MIMO-API" title="Xiaomi MiMo" subtitle="Token Plan · 月度 Credits" link="https://platform.xiaomimimo.com">
          <div className="space-y-2.5 text-sm">
            <div>
              <label className="block text-xs text-oai-gray-500 dark:text-oai-gray-400 mb-1">套餐档位</label>
              <select
                className={inputClass}
                value={draft.mimo?.planLabel || ""}
                onChange={(e) => {
                  const label = e.target.value;
                  const preset = (budgets.presets?.mimo || []).find((p) => p.label === label);
                  updateDraft((d) => {
                    d.mimo = d.mimo || {};
                    d.mimo.planLabel = label;
                    if (preset) d.mimo.planCredits = preset.credits;
                  });
                }}
              >
                <option value="">自定义（手动填写）</option>
                {(budgets.presets?.mimo || []).map((p) => (
                  <option key={p.label} value={p.label}>{p.label} · {formatTokens(p.credits)} Credits（月）</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-oai-gray-500 dark:text-oai-gray-400 mb-1">
                套餐总量（Credits/月，可手动修改）
              </label>
              <input
                type="number" min="0" step="1"
                className={inputClass}
                value={draft.mimo?.planCredits ?? ""}
                onChange={(e) => updateDraft((d) => { d.mimo = d.mimo || {}; d.mimo.planCredits = Number(e.target.value) || 0; })}
                placeholder="例如 200000000"
              />
            </div>
            <div className="flex justify-between">
              <span className="text-oai-gray-500 dark:text-oai-gray-400">本月已用</span>
              <span className="font-medium">
                {formatTokens(mimoUsed)} / {mimoPlan > 0 ? formatTokens(mimoPlan) : "—"} Credits
                {mimoPlan > 0 ? <span className={`ml-2 pct ${pctColor(mimoPct)}`}>{mimoPct.toFixed(1)}%</span> : null}
              </span>
            </div>
            {mimo.payg && (mimo.payg.requests_today > 0 || mimo.payg.spend_today_usd > 0) ? (
              <div className="flex justify-between">
                <span className="text-oai-gray-500 dark:text-oai-gray-400">按量计费今日（api.xiaomimimo.com）</span>
                <span className="font-medium">
                  ${Number(mimo.payg.spend_today_usd || 0).toFixed(4)} · {formatTokens(mimo.payg.tokens_today || 0)} tok
                </span>
              </div>
            ) : null}
            <p className="text-[11px] text-oai-gray-400 dark:text-oai-gray-500 leading-relaxed">
              Credits = token × 模型倍率（默认 1x，可在 budgets.json 的 multipliers 中按模型覆盖，官方：Pro 2x/4x）
            </p>
            <Sparkline values={mimo.daily_credits} label="本月 Credits 消耗（按日）" strokeClass="text-emerald-500" />
          </div>
        </Card>

        <Card icon="SENSENOVA-API" title="商汤日日新" subtitle="Token Plan · 5 小时调用窗口" link="https://platform.sensenova.cn">
          <div className="space-y-2.5 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-xs text-oai-gray-500 dark:text-oai-gray-400 mb-1">窗口（小时）</label>
                <input
                  type="number" min="1" max="24" step="1"
                  className={inputClass}
                  value={draft.sensenova?.windowHours ?? 5}
                  onChange={(e) => updateDraft((d) => { d.sensenova = d.sensenova || {}; d.sensenova.windowHours = Number(e.target.value) || 5; })}
                />
              </div>
              <div>
                <label className="block text-xs text-oai-gray-500 dark:text-oai-gray-400 mb-1">通用池次数上限</label>
                <input
                  type="number" min="1" step="1"
                  className={inputClass}
                  value={draft.sensenova?.callsPerWindow ?? 1500}
                  onChange={(e) => updateDraft((d) => { d.sensenova = d.sensenova || {}; d.sensenova.callsPerWindow = Number(e.target.value) || 1500; })}
                />
              </div>
            </div>
            <div>
              <label className="block text-xs text-oai-gray-500 dark:text-oai-gray-400 mb-1">
                Flash-Lite 专属积分池次数上限（模型名含 flash-lite 走此池）
              </label>
              <input
                type="number" min="1" step="1"
                className={inputClass}
                value={draft.sensenova?.flashliteCallsPerWindow ?? 1500}
                onChange={(e) => updateDraft((d) => { d.sensenova = d.sensenova || {}; d.sensenova.flashliteCallsPerWindow = Number(e.target.value) || 1500; })}
              />
            </div>
            {snModels.length > 0 ? (
              <div className="space-y-1.5">
                {snModels.map((m) => {
                  const pct = m.limit > 0 ? Math.min(100, (m.calls_in_window / m.limit) * 100) : 0;
                  return (
                    <div key={m.model}>
                      <div className="flex justify-between text-xs mb-0.5">
                        <span className="truncate text-oai-gray-500 dark:text-oai-gray-400">
                          {m.model} <span className="text-oai-gray-400 dark:text-oai-gray-500">（{m.pool === "flashlite" ? "Flash-Lite 专属池" : "通用池"}）</span>
                        </span>
                        <span className={`font-medium ${pctColor(pct)}`}>{m.calls_in_window}/{m.limit} · {pct.toFixed(0)}%</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-oai-gray-200 dark:bg-oai-gray-800 overflow-hidden">
                        <div className={`h-full rounded-full ${pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-xs text-oai-gray-400 dark:text-oai-gray-500">
                尚无调用记录。把客户端 base_url 指向 shim 的 /sensenova/v1 后，这里会显示各模型窗口用量。
              </p>
            )}
            <Sparkline values={sensenova.calls_trend_30m} label="窗口内调用走势（30 分钟/格）" strokeClass="text-emerald-500" />
          </div>
        </Card>
      </div>
    </div>
  );
}
