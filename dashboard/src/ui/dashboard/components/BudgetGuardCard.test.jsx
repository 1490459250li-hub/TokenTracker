import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetGuardCard } from "./BudgetGuardCard.jsx";

function okResponse(body) {
  return { ok: true, json: async () => body };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("BudgetGuardCard", () => {
  it("renders guard status and controls from /api/p5/guard/status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        if (String(url).includes("/api/local-auth")) return okResponse({ token: "t" });
        if (String(url).includes("/api/p5/guard/status")) return okResponse({ enabled: true, config: { soft: 5, hard: 15, checkpoint: 3 }, hooksPresent: true });
        return okResponse({});
      }),
    );
    render(<BudgetGuardCard />);
    expect(await screen.findByText("Active")).toBeTruthy();
    expect(screen.getByText("Hooks installed")).toBeTruthy();
    // soft/hard/checkpoint inputs render with the fetched config
    expect(screen.getByDisplayValue("5")).toBeTruthy();
    expect(screen.getByDisplayValue("15")).toBeTruthy();
  });
});
