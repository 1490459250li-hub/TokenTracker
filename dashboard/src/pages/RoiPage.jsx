import React, { useCallback, useEffect, useState } from "react";
import { RefreshCw, CircleDollarSign } from "lucide-react";
import { copy } from "../lib/copy";

// /roi — P4 "did this session's money actually reach the trunk?" as an explicit
// metric. Reads /api/p5/yield (per-session ROI from git attribution). Read-only.

const STATUS_COLOR = {
  productive: "text-emerald-400",
  reverted: "text-red-400",
  abandoned: "text-amber-400",
  ambiguous: "text-white/50",
};

function money(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}
function pct(n) {
  return n == null ? "—" : `${n}%`;
}

// Literal copy() calls per status so validate:copy sees (and checks) every key.
function statusLabel(k) {
  if (k === "productive") return copy("roi.status.productive");
  if (k === "reverted") return copy("roi.status.reverted");
  if (k === "abandoned") return copy("roi.status.abandoned");
  return copy("roi.status.ambiguous");
}

function Stat({ value, label, tone }) {
  return (
    <div className="rounded-xl border border-white/10 bg-white/5 p-4 text-center">
      <div className={`font-mono text-2xl font-semibold ${tone || ""}`}>{value}</div>
      <div className="mt-1 text-xs opacity-60">{label}</div>
    </div>
  );
}

export default function RoiPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/p5/yield");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json());
    } catch (e) {
      setError(copy("roi.error", { msg: String(e.message || e) }));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const roi = data && data.roi;
  const realized = roi && roi.realized_pct != null ? roi.realized_pct : 0;
  const bs = (data && data.totals.by_status) || {};

  return (
    <div className="flex flex-col flex-1 gap-5 p-5 md:p-8">
      <header className="flex flex-wrap items-center gap-3">
        <CircleDollarSign className="h-6 w-6 text-emerald-400" aria-hidden />
        <div>
          <h1 className="text-xl font-semibold">{copy("roi.title")}</h1>
          <p className="text-sm opacity-60">{copy("roi.subtitle")}</p>
        </div>
        <button onClick={load} disabled={loading} className="ml-auto inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-1.5 text-sm disabled:opacity-50">
          <RefreshCw className="h-4 w-4" aria-hidden /> {copy("roi.refresh")}
        </button>
      </header>

      {loading && <p className="text-sm opacity-60">{copy("roi.loading")}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {data && !loading && (
        <>
          {data.totals.sessions === 0 && <p className="text-sm opacity-60">{copy("roi.empty")}</p>}

          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat value={money(data.totals.total_cost_usd)} label={copy("roi.kpi_total")} />
            <Stat value={pct(roi && roi.realized_pct)} label={copy("roi.kpi_landed")} tone="text-emerald-400" />
            <Stat value={money(roi && roi.value_at_risk_usd)} label={copy("roi.kpi_at_risk")} tone="text-amber-400" />
            <Stat value={String(data.totals.sessions)} label={copy("roi.kpi_sessions")} />
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <section className="rounded-xl border border-white/10 bg-white/5 p-4">
              <h2 className="mb-3 text-sm font-semibold opacity-80">{copy("roi.by_status")}</h2>
              <div className="flex flex-col gap-2">
                {["productive", "reverted", "abandoned", "ambiguous"].map((k) => (
                  <div key={k} className="flex items-center justify-between text-sm">
                    <span className={STATUS_COLOR[k]}>{statusLabel(k)}</span>
                    <span className="font-mono opacity-80">{(bs[k] && bs[k].sessions) || 0} · {money(bs[k] && bs[k].cost_usd)}</span>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-xl border border-white/10 bg-white/5 p-4">
              <h2 className="mb-3 text-sm font-semibold opacity-80">{copy("roi.by_model")}</h2>
              <table className="w-full text-sm">
                <thead className="text-xs opacity-60">
                  <tr><th className="text-left font-medium">{copy("roi.col_model")}</th><th className="text-right font-medium">{copy("roi.col_roi")}</th><th className="text-right font-medium">{copy("roi.col_spend")}</th></tr>
                </thead>
                <tbody>
                  {(data.by_model || []).slice(0, 8).map((m) => (
                    <tr key={m.model} className="border-t border-white/5">
                      <td className="py-1">{m.model}</td>
                      <td className="py-1 text-right font-mono">{m.roi == null ? "—" : `${m.roi}%`}</td>
                      <td className="py-1 text-right font-mono">{money(m.total_cost_usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          {(data.worst_sessions || []).length > 0 && (
            <section className="rounded-xl border border-white/10 bg-white/5 p-4">
              <h2 className="mb-3 text-sm font-semibold opacity-80">{copy("roi.worst_title")}</h2>
              <table className="w-full text-sm">
                <thead className="text-xs opacity-60">
                  <tr><th className="text-left font-medium">{copy("roi.col_model")}</th><th className="text-left font-medium">{copy("roi.col_status")}</th><th className="text-right font-medium">{copy("roi.col_cost")}</th><th className="text-right font-medium">{copy("roi.col_time")}</th></tr>
                </thead>
                <tbody>
                  {data.worst_sessions.slice(0, 10).map((w, i) => (
                    <tr key={`${w.model}-${i}`} className="border-t border-white/5">
                      <td className="py-1">{w.model}</td>
                      <td className={`py-1 ${STATUS_COLOR[w.status]}`}>{statusLabel(w.status)}</td>
                      <td className="py-1 text-right font-mono">{money(w.cost_usd)}</td>
                      <td className="py-1 text-right text-xs opacity-60">{(w.session_started_at || "").slice(0, 10)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {data.provenance && data.provenance.coverage && (
            <p className="text-xs opacity-50">{copy("roi.coverage", { pct: pct(data.provenance.coverage.attributable_cost_pct) })}</p>
          )}
        </>
      )}
    </div>
  );
}
