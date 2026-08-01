import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexUsageView } from "./CodexUsageView";
import { DEFAULT_CODEX_USAGE_VISIBLE_ROWS, useSettingsStore } from "@/stores/settings-store";

const { useCodexUsageSnapshot } = vi.hoisted(() => ({
  useCodexUsageSnapshot: vi.fn(),
}));

vi.mock("@/hooks/useCodexUsageSnapshot", () => ({
  useCodexUsageSnapshot,
}));

describe("CodexUsageView", () => {
  beforeEach(() => {
    useSettingsStore.getState().setCodexUsage({
      profile: "",
      refreshSeconds: 600,
      visibleRows: [...DEFAULT_CODEX_USAGE_VISIBLE_ROWS],
    });
    class FixedResizeObserver {
      constructor(private callback: ResizeObserverCallback) {}
      observe() {
        this.callback(
          [{ contentRect: { width: 400, height: 600 } } as ResizeObserverEntry],
          this as unknown as ResizeObserver,
        );
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", FixedResizeObserver);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("adapts Codex windows into the shared usage presentation", () => {
    useCodexUsageSnapshot.mockReturnValue({
      snapshot: {
        status: { type: "ready" },
        limits: [
          {
            key: "codex-primary",
            label: "Codex",
            kind: "primary",
            usedPercent: 42,
            windowDurationMins: 300,
            resetsAtSecs: Math.floor(Date.now() / 1000) + 120_000,
          },
        ],
        plan: "pro",
        capturedAtMs: Date.now(),
      },
      refresh: vi.fn(),
    });

    render(<CodexUsageView paneId="codex-pane" />);

    expect(screen.getByTestId("usage-row-codex-primary")).toHaveTextContent("Weekly limit");
    expect(screen.getByTestId("usage-percent-codex-primary")).toHaveTextContent("42%");
    expect(screen.getByTestId("usage-plan")).toHaveTextContent("pro");
    const meter = screen.getByTestId("usage-meter-used-codex-primary");
    expect(meter).toHaveStyle({
      height: "16px",
    });
    // Codex's own brand green, not Claude's colour: the two agents are told
    // apart by the meter fill.
    expect(meter.firstElementChild).toHaveStyle({ background: "rgb(16, 163, 127)" });
  });

  it("excludes secondary windows by kind even when a key ends in -primary", () => {
    useCodexUsageSnapshot.mockReturnValue({
      snapshot: {
        status: { type: "ready" },
        limits: [
          {
            key: "weird-primary-primary",
            label: "Weird",
            kind: "primary",
            usedPercent: 5,
            windowDurationMins: 300,
            resetsAtSecs: 1_800_000_000,
          },
          {
            key: "weird-primary",
            label: "Weird",
            kind: "secondary",
            usedPercent: 6,
            windowDurationMins: 10_080,
            resetsAtSecs: 1_800_000_000,
          },
        ],
        plan: null,
        capturedAtMs: null,
      },
      refresh: vi.fn(),
    });

    render(<CodexUsageView />);

    expect(screen.getByTestId("usage-row-weird-primary-primary")).toBeInTheDocument();
    expect(screen.queryByTestId("usage-row-weird-primary")).not.toBeInTheDocument();
  });

  it("shows the shared surface's status area for an unauthenticated CLI", () => {
    useCodexUsageSnapshot.mockReturnValue({
      snapshot: {
        status: { type: "unauthorized" },
        limits: [],
        plan: null,
        capturedAtMs: null,
      },
      refresh: vi.fn(),
    });

    render(<CodexUsageView />);

    expect(screen.getByTestId("usage-status")).toHaveTextContent("Sign in to Codex CLI");
  });

  it("uses the weekly names and removes their long suffixes only in narrow rows", () => {
    useCodexUsageSnapshot.mockReturnValue({
      snapshot: {
        status: { type: "ready" },
        limits: [
          {
            key: "codex-primary",
            label: "Codex",
            kind: "primary",
            usedPercent: 8,
            windowDurationMins: 300,
            resetsAtSecs: 1_800_000_000,
          },
          {
            key: "gpt-5.3-codex-spark-primary",
            label: "GPT-5.3-Codex-Spark",
            kind: "primary",
            usedPercent: 17,
            windowDurationMins: 300,
            resetsAtSecs: 1_800_000_000,
          },
          {
            key: "codex-secondary",
            label: "Codex",
            kind: "secondary",
            usedPercent: 2,
            windowDurationMins: 10_080,
            resetsAtSecs: 1_800_000_000,
          },
        ],
        plan: null,
        capturedAtMs: null,
      },
      refresh: vi.fn(),
    });

    render(<CodexUsageView />);

    expect(screen.getByTestId("usage-row-codex-primary")).toHaveTextContent("Weekly");
    expect(screen.getByTestId("usage-row-gpt-5.3-codex-spark-primary")).toHaveTextContent("Spark");
    expect(screen.queryByTestId("usage-row-codex-secondary")).not.toBeInTheDocument();
  });
});
