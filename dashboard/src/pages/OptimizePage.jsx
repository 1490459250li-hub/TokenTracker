import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw, Wand2, Undo2, ClipboardCheck, Copy, ShieldCheck } from "lucide-react";
import { copy } from "../lib/copy";
import { getLocalApiAuthHeaders } from "../lib/local-api-auth";

// /optimize — the P1 "where is money wasted, and how to stop it" loop, wired
// into the dashboard. Reads /api/p5/optimize (scanWaste) and drives
// /api/p5/act/{apply,undo,report}. Mutations send the local-auth token the
// dashboard already uses for writes.

const SEV_STYLE = {
  high: "bg-red-500/15 text-red-400",
  medium: "bg-amber-500/15 text-amber-400",
  low: "bg-white/10 text-white/60",
};

function money(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}
function tokens(n) {
  const v = Number(n) || 0;
  return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v);
}

export default function OptimizePage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  const flash = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(""), 2600);
  }, []);

  const scan = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/p5/optimize");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      flash(copy("optimize.error", { msg: String(e.message || e) }));
    } finally {
      setLoading(false);
    }
  }, [flash]);

  useEffect(() => {
    scan();
  }, [scan]);

  async function act(path, body, okMsg) {
    setBusy(true);
    try {
      const headers = { "content-type": "application/json", ...(await getLocalApiAuthHeaders()) };
      const res = await fetch(`/api/p5/act/${path}`, { method: "POST", headers, body: JSON.stringify(body || {}) });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      flash(okMsg(out));
      await scan();
    } catch (e) {
      flash(copy("optimize.error", { msg: String(e.message || e) }));
    } finally {
      setBusy(false);
    }
  }

  async function report() {
    setBusy(true);
    try {
      const headers = await getLocalApiAuthHeaders();
      const res = await fetch("/api/p5/act/report", { headers });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
      const s = out.report && out.report.summary;
      flash(s ? copy("optimize.report_done", { est: money(s.estimated_total_usd), real: money(s.realized_measurable_usd) }) : (out.message || ""));
    } catch (e) {
      flash(copy("optimize.error", { msg: String(e.message || e) }));
    } finally {
      setBusy(false);
    }
  }

  const findings = (data && data.findings) || [];
  const totals = data && data.totals;

  return (
    <div className="flex flex-col flex-1 gap-5 p-5 md:p-8">
      <header className="flex flex-wrap items-center gap-3">
        <Wand2 className="h-6 w-6 text-violet-400" aria-hidden />
        <div>
          <h1 className="text-xl font-semibold">{copy("optimize.title")}</h1>
          <p className="text-sm opacity-60">{copy("optimize.subtitle")}</p>
        </div>
        <div className="ml-auto flex flex-wrap gap-2">
          <button onClick={scan} disabled={loading || busy} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-sm disabled:opacity-50">
            <RefreshCw className="h-4 w-4" aria-hidden /> {copy("optimize.rescan")}
          </button>
          <button onClick={() => act("apply", { yes: false }, (o) => copy("optimize.apply_done", { n: (o.applied || []).length }))} disabled={busy} className="inline-flex items-center gap-2 rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50">
            <ShieldCheck className="h-4 w-4" aria-hidden /> {copy("optimize.apply_safe")}
          </button>
          <button onClick={() => { if (window.confirm(copy("optimize.confirm_apply_all"))) act("apply", { yes: true }, (o) => copy("optimize.apply_done", { n: (o.applied || []).length })); }} disabled={busy} className="rounded-lg border border-white/10 px-3 py-1.5 text-sm disabled:opacity-50">
            {copy("optimize.apply_all")}
          </button>
          <button onClick={() => act("undo", {}, (o) => (o.undone ? copy("optimize.undo_done") : copy("optimize.undo_none")))} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-sm disabled:opacity-50">
            <Undo2 className="h-4 w-4" aria-hidden /> {copy("optimize.undo")}
          </button>
          <button onClick={report} disabled={busy} className="inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-sm disabled:opacity-50">
            <ClipboardCheck className="h-4 w-4" aria-hidden /> {copy("optimize.report")}
          </button>
        </div>
      </header>

      {totals && (
        <p className="text-sm opacity-70">
          {copy("optimize.summary", { sessions: data.provenance.sessions_scanned, tokens: tokens(totals.wasted_tokens), cost: money(totals.wasted_cost_usd), count: totals.findings })}
        </p>
      )}

      {loading && <p className="text-sm opacity-60">{copy("optimize.loading")}</p>}

      {!loading && findings.length === 0 && <p className="text-sm opacity-60">{copy("optimize.empty")}</p>}

      <div className="flex flex-col gap-3">
        {findings.map((f) => (
          <article key={f.id} className="rounded-xl border border-white/10 bg-white/5 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded px-2 py-0.5 text-xs font-semibold ${SEV_STYLE[f.severity] || SEV_STYLE.low}`}>
                {f.severity === "high" ? copy("optimize.sev.high") : f.severity === "medium" ? copy("optimize.sev.medium") : copy("optimize.sev.low")}
              </span>
              <span className="font-medium">{f.title}</span>
              <span className="ml-auto font-mono text-sm text-emerald-400">{tokens(f.wasted_tokens)} tok · {money(f.wasted_cost_usd)}</span>
            </div>
            {f.fix && f.fix.description && <p className="mt-2 text-sm opacity-70">{f.fix.description}</p>}
            {f.fix && f.fix.pasteable && (
              <pre className="mt-2 overflow-x-auto rounded-lg bg-black/30 p-2 font-mono text-xs">{f.fix.pasteable}</pre>
            )}
            <div className="mt-3 flex gap-2">
              <button onClick={() => act("apply", { ids: [f.id] }, () => copy("optimize.apply_done", { n: 1 }))} disabled={busy} className="rounded-lg bg-violet-600/80 px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50">
                {copy("optimize.apply_item")}
              </button>
              {f.fix && f.fix.pasteable && (
                <button onClick={() => { navigator.clipboard && navigator.clipboard.writeText(f.fix.pasteable); flash(copy("optimize.copied")); }} className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2.5 py-1 text-xs">
                  <Copy className="h-3 w-3" aria-hidden /> {copy("optimize.copy_item")}
                </button>
              )}
            </div>
          </article>
        ))}
      </div>

      {toast && <div className="fixed bottom-6 right-6 rounded-lg border border-white/10 bg-neutral-900 px-4 py-2 text-sm shadow-lg">{toast}</div>}
    </div>
  );
}
