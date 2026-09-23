import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OverviewShareCard } from "./OverviewShareCard.jsx";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OverviewShareCard", () => {
  it("renders cache-hit, fun-equivalents and the report from /api/p5", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).includes("/api/p5/snapshot")) {
          return { ok: true, json: async () => ({ sessions: 5, cache_hit_rate: 82, share_headline: "wrote ~120k lines", equivalents: { code_lines: 120000, words_written: 900150, pages: 12594, books: 63, earth_laps: 1.68 } }) };
        }
        return { ok: true, text: async () => "TokenTracker overview\nsessions 5 | $12.34" };
      }),
    );
    render(<OverviewShareCard />);
    expect(await screen.findByText("wrote ~120k lines")).toBeTruthy();
    expect(screen.getByText("82%")).toBeTruthy();
    expect(screen.getByText(/TokenTracker overview/)).toBeTruthy();
  });
});
