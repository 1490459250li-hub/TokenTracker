import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RoiPage from "./RoiPage.jsx";

function okResponse(body) {
  return { ok: true, json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const payload = {
  totals: {
    sessions: 4,
    total_cost_usd: 13,
    by_status: {
      productive: { sessions: 1, cost_usd: 2 },
      reverted: { sessions: 1, cost_usd: 4 },
      abandoned: { sessions: 1, cost_usd: 6 },
      ambiguous: { sessions: 1, cost_usd: 1 },
    },
  },
  roi: { realized_pct: 15.4, value_at_risk_usd: 10, productive_usd: 2, reverted_usd: 4, abandoned_usd: 6, ambiguous_usd: 1 },
  by_model: [{ model: "claude-opus-4-1", total_cost_usd: 6, roi: 0 }, { model: "claude-sonnet-4-5", total_cost_usd: 7, roi: 28.6 }],
  worst_sessions: [{ model: "claude-opus-4-1", status: "abandoned", cost_usd: 6, session_started_at: "2026-09-03T10:00:00Z" }],
  provenance: { coverage: { attributable_cost_pct: 46.2 } },
};

describe("RoiPage", () => {
  it("renders ROI data from /api/p5/yield", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url) => (String(url).includes("/api/p5/yield") ? okResponse(payload) : okResponse({}))));
    render(<RoiPage />);
    const models = await screen.findAllByText("claude-opus-4-1");
    expect(models.length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("$13.00")).toBeTruthy(); // total spend KPI
    expect(screen.getByText("15.4%")).toBeTruthy(); // realized ROI
  });

  it("surfaces a fetch error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    render(<RoiPage />);
    expect(await screen.findByText(/boom/)).toBeTruthy();
  });
});
