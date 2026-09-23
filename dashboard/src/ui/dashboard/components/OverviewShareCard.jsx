import React, { useCallback, useEffect, useState } from "react";
import { Sparkles, Copy, FileText } from "lucide-react";
import { copy } from "../../../lib/copy";

// Shareable overview card on the Widgets page: cache-hit, token fun-equivalents
// (趣味当量), and a copy-paste monthly report. Reads the local /api/p5/snapshot
// + /api/p5/report endpoints (no cloud). Purely presentational.

const fmt = (n) => {
  const v = Number(n) || 0;
  return v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${v >= 1e5 ? Math.round(v / 1e3) : (v / 1e3).toFixed(1)}k` : String(v);
};

function Eq({ value, label }) {
  return (
    <div className="rounded-xl border border-oai-gray-200 dark:border-oai-gray-800 p-3 text-center">
      <div className="font-mono text-lg font-semibold">{value}</div>
      <div className="mt-0.5 text-xs text-oai-gray-500 dark:text-oai-gray-400">{label}</div>
    </div>
  );
}

export function OverviewShareCard() {
  const [data, setData] = useState(null);
  const [report, setReport] = useState("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async (markdown) => {
    setLoading(true);
    try {
      const [snap, rep] = await Promise.all([
        fetch("/api/p5/snapshot").then((r) => r.json()),
        fetch(`/api/p5/report${markdown ? "?markdown=1" : ""}`).then((r) => r.text()),
      ]);
      setData(snap);
      setReport(rep);
    } catch (e) {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);

  const e = (data && data.equivalents) || {};

  return (
    <section aria-label={copy("share.card.title")} className="rounded-2xl border border-oai-gray-200 dark:border-oai-gray-800 p-5">
      <div className="flex items-center gap-2">
        <Sparkles className="h-5 w-5 text-violet-500" aria-hidden />
        <div>
          <h2 className="text-base font-semibold">{copy("share.card.title")}</h2>
          <p className="text-sm text-oai-gray-500 dark:text-oai-gray-400">{copy("share.card.subtitle")}</p>
        </div>
      </div>

      {loading && <p className="mt-4 text-sm opacity-60">{copy("share.loading")}</p>}

      {!loading && data && (
        <>
          <p className="mt-4 text-sm">
            {copy("share.headline_prefix")} <span className="font-semibold">{data.share_headline}</span>
            {" · "}{copy("share.cache_hit")} <span className="font-mono">{data.cache_hit_rate == null ? "—" : `${data.cache_hit_rate}%`}</span>
          </p>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Eq value={fmt(e.code_lines)} label={copy("share.eq_code")} />
            <Eq value={fmt(e.words_written)} label={copy("share.eq_words")} />
            <Eq value={fmt(e.pages)} label={copy("share.eq_pages")} />
            <Eq value={fmt(e.books)} label={copy("share.eq_books")} />
            <Eq value={fmt(e.earth_laps)} label={copy("share.eq_earth")} />
          </div>

          <div className="mt-4">
            <div className="mb-2 flex items-center gap-2">
              <FileText className="h-4 w-4 opacity-60" aria-hidden />
              <span className="text-sm font-medium">{copy("share.report_title")}</span>
              <div className="ml-auto flex gap-2">
                <button type="button" onClick={() => load(true)} className="rounded-lg border border-oai-gray-200 dark:border-oai-gray-800 px-2.5 py-1 text-xs">{copy("share.markdown")}</button>
                <button type="button" onClick={() => { navigator.clipboard && navigator.clipboard.writeText(report); setCopied(true); setTimeout(() => setCopied(false), 1500); }} className="inline-flex items-center gap-1 rounded-lg bg-violet-600 px-2.5 py-1 text-xs font-medium text-white">
                  <Copy className="h-3 w-3" aria-hidden /> {copied ? copy("share.copied") : copy("share.copy_report")}
                </button>
              </div>
            </div>
            <pre className="max-h-64 overflow-auto rounded-xl bg-oai-gray-50 dark:bg-oai-gray-950 p-3 font-mono text-xs whitespace-pre-wrap">{report || copy("share.empty")}</pre>
          </div>
        </>
      )}
    </section>
  );
}

export default OverviewShareCard;
