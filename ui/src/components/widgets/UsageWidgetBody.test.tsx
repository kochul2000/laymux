import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UsageWidgetBody } from "./UsageWidgetBody";
import { estimateUsageWidgetWidth, readDisplay } from "./widget-options";
import type { UsageDisplayRow } from "@/lib/usage-rows";

const rows: UsageDisplayRow[] = [
  { key: "session", label: "Current session", percent: 42, reset: "7pm", elapsed: 30 },
  { key: "week-all", label: "Current week (all models)", percent: 71, reset: "Mar 6", elapsed: 50 },
];

function renderBody(overrides: Partial<Parameters<typeof UsageWidgetBody>[0]> = {}) {
  return render(
    <UsageWidgetBody
      testId="w"
      label="Claude"
      rows={rows}
      display="both"
      message={null}
      capturedAtMs={null}
      {...overrides}
    />,
  );
}

describe("UsageWidgetBody", () => {
  it("draws one bar and one number per visible row in `both`", () => {
    renderBody();
    expect(screen.getByTestId("w-bar-session")).toBeInTheDocument();
    expect(screen.getByTestId("w-number-session")).toHaveTextContent("42%");
    expect(screen.getByTestId("w-number-week-all")).toHaveTextContent("71%");
  });

  it("draws bars only in `bar`", () => {
    renderBody({ display: "bar" });
    expect(screen.getByTestId("w-bar-session")).toBeInTheDocument();
    expect(screen.queryByTestId("w-number-session")).not.toBeInTheDocument();
  });

  it("draws numbers only in `number`", () => {
    renderBody({ display: "number" });
    expect(screen.queryByTestId("w-bar-session")).not.toBeInTheDocument();
    expect(screen.getByTestId("w-number-session")).toBeInTheDocument();
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
    expect(screen.getByTestId("w-number-session")).toHaveTextContent("--");
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
});
