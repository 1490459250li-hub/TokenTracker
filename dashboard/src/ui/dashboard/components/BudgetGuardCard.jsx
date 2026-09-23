import React, { useCallback, useEffect, useState } from "react";
import { ShieldCheck, ShieldOff, RefreshCw, KeyRound } from "lucide-react";
import { copy } from "../../../lib/copy";
import { getLocalApiAuthHeaders } from "../../../lib/local-api-auth";

// Budget guard card, mounted on the Limits (rate/budget) page. Turns the panel
// from passive "here is your spend" into an active opt-in guard: soft/hard
// budget limits + a no-output checkpoint, installed as Claude Code hooks via the
// CLI's /api/p5/guard endpoints. Mutations carry the local-auth token.

const usd = (n) => `$${(Number(n) || 0).toFixed(0)}`;

export function BudgetGuardCard() {
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState({ soft: 5, hard: 15, checkpoint: 3 });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/p5/guard/status");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const s = await res.json();
      setStatus(s);
      if (s && s.config) setForm({ soft: s.config.soft, hard: s.config.hard, checkpoint: s.config.checkpoint });
    } catch (e) {
      setMsg(copy("guard.error", { msg: String(e.message || e) }));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function post(path, body, okMsg) {
    setBusy(true);
    setMsg("");
    try {
      const headers = { "content-type": "application/json", ...(await getLocalApiAuthHeaders()) };
      const res = await fetch(`/api/p5/guard/${path}`, { method: "POST", headers, body: JSON.stringify(body || {}) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      setMsg(okMsg ? okMsg(out) : "");
      await load();
    } catch (e) {
      setMsg(copy("guard.error", { msg: String(e.message || e) }));
    } finally {
      setBusy(false);
    }
  }

  const enabled = !!(status && status.enabled);

  return (
    <section className="mt-8 rounded-2xl border border-oai-gray-200 dark:border-oai-gray-800 p-5">
      <div className="flex flex-wrap items-center gap-3">
        {enabled ? <ShieldCheck className="h-5 w-5 text-emerald-500" aria-hidden /> : <ShieldOff className="h-5 w-5 text-oai-gray-500" aria-hidden />}
        <div>
          <h2 className="text-base font-semibold">{copy("guard.card.title")}</h2>
          <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("guard.card.subtitle")}</p>
        </div>
        <span className={`ml-auto rounded-full px-3 py-1 text-xs font-medium ${enabled ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400" : "bg-oai-gray-200 dark:bg-oai-gray-800 text-oai-gray-600 dark:text-oai-gray-400"}`}>
          {enabled ? copy("guard.status.enabled") : copy("guard.status.disabled")}
        </span>
      </div>

      {status && (
        <p className="mt-3 text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {status.hooksPresent ? copy("guard.status.hooks_installed") : copy("guard.status.hooks_missing")}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <label className="flex flex-col text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {copy("guard.field.soft")}
          <input type="number" min="0" value={form.soft} onChange={(e) => setForm((f) => ({ ...f, soft: Number(e.target.value) }))} className="mt-1 w-24 rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 bg-transparent px-2 py-1 text-sm font-mono text-oai-black dark:text-white" />
        </label>
        <label className="flex flex-col text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {copy("guard.field.hard")}
          <input type="number" min="0" value={form.hard} onChange={(e) => setForm((f) => ({ ...f, hard: Number(e.target.value) }))} className="mt-1 w-24 rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 bg-transparent px-2 py-1 text-sm font-mono text-oai-black dark:text-white" />
        </label>
        <label className="flex flex-col text-xs text-oai-gray-500 dark:text-oai-gray-400">
          {copy("guard.field.checkpoint")}
          <input type="number" min="0" value={form.checkpoint} onChange={(e) => setForm((f) => ({ ...f, checkpoint: Number(e.target.value) }))} className="mt-1 w-24 rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 bg-transparent px-2 py-1 text-sm font-mono text-oai-black dark:text-white" />
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => post("on", form, (o) => copy("guard.saved_enabled", { soft: usd(o.config.soft), hard: usd(o.config.hard), checkpoint: usd(o.config.checkpoint) }))} className="inline-flex items-center gap-1.5 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            <ShieldCheck className="h-4 w-4" aria-hidden /> {copy("guard.enable")}
          </button>
          <button type="button" disabled={busy} onClick={() => { if (window.confirm(copy("guard.confirm_disable"))) post("off", {}, () => copy("guard.saved_disabled")); }} className="inline-flex items-center gap-1.5 rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 px-3 py-1.5 text-sm disabled:opacity-50">
            <ShieldOff className="h-4 w-4" aria-hidden /> {copy("guard.disable")}
          </button>
          <button type="button" disabled={busy} onClick={() => post("allow", {}, () => copy("guard.allowed_once"))} className="inline-flex items-center gap-1.5 rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 px-3 py-1.5 text-sm disabled:opacity-50">
            <KeyRound className="h-4 w-4" aria-hidden /> {copy("guard.allow_once")}
          </button>
          <button type="button" disabled={busy} onClick={load} aria-label={copy("guard.reload")} className="inline-flex items-center rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 px-2.5 py-1.5 text-sm disabled:opacity-50">
            <RefreshCw className="h-4 w-4" aria-hidden />
          </button>
        </div>
      </div>

      {msg && <p className="mt-3 text-sm text-oai-gray-600 dark:text-oai-gray-300">{msg}</p>}
      <p className="mt-2 text-xs text-oai-gray-400 dark:text-oai-gray-500">{copy("guard.restart_hint")}</p>
    </section>
  );
}

export default BudgetGuardCard;
