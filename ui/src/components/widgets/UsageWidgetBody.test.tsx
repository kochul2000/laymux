import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UsageWidgetBody } from "./UsageWidgetBody";
import { estimateUsageWidgetWidth, readDisplay } from "./widget-options";
import type { UsageDisplayRow } from "@/lib/usage-rows";

const rows: UsageDisplayRow[] = [
  {
    key: "session",
    label: "Current session",
    statuslineLabel: "Session",
    percent: 42,
    reset: "7pm",
    elapsed: 30,
  },
  {
    key: "week-all",
    label: "Current week (all models)",
    statuslineLabel: "Week",
    percent: 71,
    reset: "Mar 6",
    elapsed: 50,
  },
  {
    key: "week-model",
    label: "Current week (Fable)",
    statuslineLabel: "Fable",
    percent: 18,
    reset: "Mar 6",
    elapsed: 50,
  },
];

const colors = { used: "#d97757", pace: "#f9e2af", track: "#585858" };

function renderBody(overrides: Partial<Parameters<typeof UsageWidgetBody>[0]> = {}) {
  return render(
    <UsageWidgetBody
      testId="w"
      label="Claude"
      rows={rows}
      display="both"
      message={null}
      capturedAtMs={null}
      colors={colors}
      usedHeight={4}
      elapsedHeight={2}
      barWidth={26}
      {...overrides}
    />,
  );
}

describe("UsageWidgetBody", () => {
  it("draws one bar and one number per visible row in `both`", () => {
    renderBody();
    expect(screen.getByTestId("w-bar-session")).toBeInTheDocument();
    expect(screen.getByTestId("w-number-session")).toHaveTextContent("Session 42%");
    expect(screen.getByTestId("w-number-week-all")).toHaveTextContent("Week 71%");
    expect(screen.getByTestId("w-number-week-model")).toHaveTextContent("Fable 18%");
  });

  it("separates rows with vertical rules and keeps each number before its bar", () => {
    renderBody();
    expect(screen.getAllByTestId(/^w-separator-/)).toHaveLength(2);

    const number = screen.getByTestId("w-number-session");
    const bar = screen.getByTestId("w-bar-session");
    expect(number.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("stacks an elapsed bar under the consumed one", () => {
    // Consumption alone is ambiguous: 42% means one thing early in a window and
    // another thing late, so the clock has to be visible beside it.
    renderBody({ display: "bar" });
    expect(screen.getByTestId("w-bar-session")).toBeInTheDocument();
    expect(screen.getByTestId("w-pace-session")).toBeInTheDocument();
  });

  it("applies the configured width to both usage tracks", () => {
    renderBody({ display: "bar", barWidth: 64 });
    expect(screen.getByTestId("w-bar-session")).toHaveStyle({ width: "64px" });
    expect(screen.getByTestId("w-pace-session")).toHaveStyle({ width: "64px" });
  });

  it("omits the elapsed bar when the provider gave no window to derive it", () => {
    renderBody({ rows: [{ ...rows[0], elapsed: null }] });
    expect(screen.getByTestId("w-bar-session")).toBeInTheDocument();
    expect(screen.queryByTestId("w-pace-session")).not.toBeInTheDocument();
  });

  it("puts both numbers in the tooltip, since the bars are too small to read", () => {
    renderBody();
    const title = screen.getByTestId("w").getAttribute("title") ?? "";
    expect(title).toContain("42%");
    expect(title).toContain("30% elapsed");
  });

  it("draws bars only in `bar`", () => {
    renderBody({ display: "bar" });
    expect(screen.getByTestId("w-bar-session")).toBeInTheDocument();
    expect(screen.queryByTestId("w-number-session")).not.toBeInTheDocument();
  });

  it("draws numbers only in `number`", () => {
    renderBody({ display: "number" });
    expect(screen.queryByTestId("w-bar-session")).not.toBeInTheDocument();
    expect(screen.getByTestId("w-number-session")).toHaveTextContent("Session 42%");
  });

  it("replaces the numbers when the probe has nothing usable", () => {
    // The rows still carry the last good percentages; showing them as current
    // is exactly the silent-wrong-number failure ADR-0102 forbids.
    renderBody({ message: "`claude` not found in this profile's shell" });
    expect(screen.getByTestId("w-unavailable")).toBeInTheDocument();
    expect(screen.queryByTestId("w-number-session")).not.toBeInTheDocument();
    expect(screen.queryByTestId("w-bar-session")).not.toBeInTheDocument();
  });

  it("puts the reason and the capture time in the tooltip", () => {
    renderBody({ message: "Starting Claude Code…" });
    const title = screen.getByTestId("w").getAttribute("title") ?? "";
    expect(title).toContain("Starting Claude Code…");
    expect(title).toContain("Updated never");
  });

  it("shows a placeholder for a row the probe could not read", () => {
    renderBody({ rows: [{ ...rows[0], percent: null }] });
    expect(screen.getByTestId("w-number-session")).toHaveTextContent("Session --");
  });
});

describe("usage widget option reading", () => {
  it("falls back to `both` for a missing or unknown display", () => {
    expect(readDisplay({})).toBe("both");
    expect(readDisplay({ display: "sparkline" })).toBe("both");
    expect(readDisplay({ display: "bar" })).toBe("bar");
  });

  it("budgets more width for more rows and for `both`", () => {
    expect(estimateUsageWidgetWidth("both", 3)).toBeGreaterThan(
      estimateUsageWidgetWidth("both", 1),
    );
    expect(estimateUsageWidgetWidth("both", 2)).toBeGreaterThan(estimateUsageWidgetWidth("bar", 2));
  });

  it("uses the configured bar width in the slot budget", () => {
    expect(estimateUsageWidgetWidth("bar", 2, 64)).toBeGreaterThan(
      estimateUsageWidgetWidth("bar", 2, 26),
    );
  });
});
