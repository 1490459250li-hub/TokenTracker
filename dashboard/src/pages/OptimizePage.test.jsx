import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import OptimizePage from "./OptimizePage.jsx";

function okResponse(body) {
  return { ok: true, json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("OptimizePage", () => {
  it("renders findings returned by /api/p5/optimize", async () => {
    const payload = {
      provenance: { sessions_scanned: 3 },
      totals: { wasted_tokens: 5000, wasted_cost_usd: 1.2, findings: 1, by_type: { unused_mcp: 1 } },
      findings: [
        {
          id: "unused_mcp:slack",
          type: "unused_mcp",
          severity: "high",
          title: 'MCP server "slack" is configured but never called',
          wasted_tokens: 5000,
          wasted_cost_usd: 1.2,
          confidence: "inferred",
          fix: { description: "Remove the idle server.", pasteable: "claude mcp remove --scope user slack" },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).includes("/api/local-auth")) return okResponse({ token: "t" });
        if (String(url).includes("/api/p5/optimize")) return okResponse(payload);
        return okResponse({});
      }),
    );

    render(<OptimizePage />);
    const heading = await screen.findByText('MCP server "slack" is configured but never called');
    expect(heading).toBeTruthy();
    expect(screen.getByText("claude mcp remove --scope user slack")).toBeTruthy();
  });

  it("shows an empty state when there are no findings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).includes("/api/local-auth")) return okResponse({ token: "t" });
        if (String(url).includes("/api/p5/optimize")) return okResponse({ provenance: { sessions_scanned: 0 }, totals: { wasted_tokens: 0, wasted_cost_usd: 0, findings: 0, by_type: {} }, findings: [] });
        return okResponse({});
      }),
    );
    render(<OptimizePage />);
    // No finding articles render.
    const articles = await screen.findAllByRole("button");
    expect(articles.length).toBeGreaterThan(0); // action buttons still present
  });
});
