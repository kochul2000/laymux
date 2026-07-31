import { act, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageView } from "./UsageView";
import {
  onUsageSnapshotChanged,
  refreshUsageProbe,
  subscribeUsageProbe,
  unsubscribeUsageProbe,
  type UsageSnapshot,
} from "@/lib/tauri-api";
import { useOverridesStore } from "@/stores/overrides-store";
import {
  DEFAULT_USAGE_COLORS,
  DEFAULT_USAGE_VISIBLE_ROWS,
  useSettingsStore,
} from "@/stores/settings-store";

vi.mock("@/lib/tauri-api", () => ({
  subscribeUsageProbe: vi.fn(),
  unsubscribeUsageProbe: vi.fn().mockResolvedValue(undefined),
  getUsageSnapshot: vi.fn(),
  refreshUsageProbe: vi.fn().mockResolvedValue(true),
  onUsageSnapshotChanged: vi.fn(),
}));

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    configDir: "",
    status: { type: "ready" },
    session: { percent: 30, reset: "7pm (Asia/Seoul)" },
    weekAll: { percent: 11, reset: "Mar 6, 12pm (Asia/Seoul)" },
    weekModel: { percent: 7, reset: "Aug 7, 12pm (Asia/Seoul)" },
    weekModelLabel: "Fable",
    plan: "Claude Max",
    model: "Opus 4.6",
    capturedAtMs: Date.now(),
    nextQueryAtMs: Date.now() + 600_000,
    rawScreen: null,
    ...overrides,
  };
}

/** Emitter captured from `onUsageSnapshotChanged` so tests can push updates. */
let emit: ((next: UsageSnapshot) => void) | null = null;
const unlisten = vi.fn();

/**
 * Fix the measured box so layout assertions are deterministic. jsdom reports
 * zero-sized elements and never fires ResizeObserver, which would otherwise pin
 * every case to the unmeasured default.
 */
function mockBox(width: number, height: number) {
  class FixedResizeObserver {
    constructor(private callback: ResizeObserverCallback) {}
    observe() {
      this.callback(
        [{ contentRect: { width, height } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    }
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal("ResizeObserver", FixedResizeObserver);
}

describe("UsageView", () => {
  beforeEach(() => {
    emit = null;
    unlisten.mockClear();
    vi.mocked(subscribeUsageProbe).mockReset().mockResolvedValue(snapshot());
    vi.mocked(unsubscribeUsageProbe).mockReset().mockResolvedValue(undefined);
    vi.mocked(refreshUsageProbe).mockReset().mockResolvedValue(true);
    vi.mocked(onUsageSnapshotChanged)
      .mockReset()
      .mockImplementation((callback) => {
        emit = callback;
        return Promise.resolve(unlisten);
      });
    useOverridesStore.setState({ viewOverrides: {} });
    useSettingsStore
      .getState()
      .setUsageAgent("claude", { visibleRows: [...DEFAULT_USAGE_VISIBLE_ROWS] });
    useSettingsStore.getState().setUsageColors({ ...DEFAULT_USAGE_COLORS });
    mockBox(400, 600);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function renderView(props: Parameters<typeof UsageView>[0] = {}) {
    const result = render(<UsageView {...props} />);
    await act(async () => {});
    return result;
  }

  /** Claim id of the Nth `subscribeUsageProbe` call. */
  function claimId(callIndex = 0): string {
    return vi.mocked(subscribeUsageProbe).mock.calls[callIndex][0];
  }

  it("subscribes on mount with a pane-scoped id and releases exactly that claim", async () => {
    const { unmount } = await renderView({ paneId: "pane-7", configDir: "" });
    expect(claimId()).toMatch(/^usage-pane-7#/);
    expect(subscribeUsageProbe).toHaveBeenCalledWith(claimId(), "");

    unmount();
    expect(unsubscribeUsageProbe).toHaveBeenCalledWith(claimId());
    expect(unlisten).toHaveBeenCalled();
  });

  it("gives every effect run its own claim id", async () => {
    // The live failure this prevents: a stale cleanup releasing the live claim,
    // which drops demand to zero and retires the probe under a mounted view.
    const { rerender } = await renderView({ paneId: "pane-1", configDir: "" });
    rerender(<UsageView paneId="pane-1" configDir="/a" />);
    await act(async () => {});

    const first = claimId(0);
    const second = claimId(1);
    expect(second).not.toBe(first);
    // The cleanup released the first claim, not the second.
    expect(unsubscribeUsageProbe).toHaveBeenCalledWith(first);
    expect(unsubscribeUsageProbe).not.toHaveBeenCalledWith(second);
  });

  it("re-subscribes when the config dir changes", async () => {
    const { rerender } = await renderView({ paneId: "pane-1", configDir: "" });
    rerender(<UsageView paneId="pane-1" configDir="/home/me/.claude-personal" />);
    await act(async () => {});

    const lastCall = vi.mocked(subscribeUsageProbe).mock.calls.at(-1);
    expect(lastCall?.[0]).toMatch(/^usage-pane-1#/);
    expect(lastCall?.[1]).toBe("/home/me/.claude-personal");
  });

  it("renders the cached percentages and plan", async () => {
    await renderView({ paneId: "pane-1" });
    expect(screen.getByTestId("usage-percent-session")).toHaveTextContent("30%");
    expect(screen.getByTestId("usage-percent-week-all")).toHaveTextContent("11%");
    expect(screen.getByTestId("usage-percent-week-model")).toHaveTextContent("7%");
    // The per-model row is titled from the panel, not from a hard-coded model.
    expect(screen.getByTestId("usage-row-week-model")).toHaveTextContent("Current week (Fable)");
    expect(screen.getByTestId("usage-plan")).toHaveTextContent("Claude Max");
  });

  it("matches the heading and quota percentage size while emphasizing only the percentage", async () => {
    await renderView({ paneId: "pane-1" });

    const row = screen.getByTestId("usage-row-week-all");
    const label = row.firstElementChild?.firstElementChild;
    expect(label).toHaveStyle({ fontSize: "13px", fontWeight: "400" });
    expect(screen.getByTestId("usage-percent-week-all")).toHaveStyle({
      fontSize: "13px",
      fontWeight: "600",
      color: "var(--text-secondary)",
    });
  });

  it("shrinks the heading and quota percentage together", async () => {
    mockBox(200, 100);
    await renderView({ paneId: "pane-1" });

    const row = screen.getByTestId("usage-row-week-all");
    const label = row.firstElementChild?.firstElementChild as HTMLElement;
    const percent = screen.getByTestId("usage-percent-week-all");
    expect(percent.style.fontSize).toBe(label.style.fontSize);
  });

  it("shows Claude's reset text on the left and elapsed pace on the right", async () => {
    await renderView({ paneId: "pane-1" });

    const detail = screen.getByTestId("usage-detail-week-all");
    expect(detail.firstElementChild).toHaveTextContent("Resets Mar 6, 12pm (Asia/Seoul)");
    expect(detail.firstElementChild).toHaveStyle({ color: "var(--text-secondary)" });
    expect(detail.lastElementChild).toHaveTextContent("0% elapsed");
    expect(detail).not.toHaveTextContent("resets in");
    expect(detail.lastElementChild).toHaveStyle({ color: "rgb(253, 151, 31)" });
  });

  it("uses the configured usage profile's terminal font", async () => {
    useSettingsStore.getState().setUsageAgent("claude", { profile: "PowerShell" });
    useSettingsStore
      .getState()
      .updateProfile(0, { font: { face: "JetBrains Mono", size: 14, weight: "normal" } });

    await renderView({ paneId: "pane-1" });

    expect(screen.getByTestId("usage-view")).toHaveStyle({
      fontFamily: "'JetBrains Mono', 'Cascadia Mono', 'Consolas', monospace",
    });
  });

  it("uses a square, prominent quota meter with a thin elapsed-time meter", async () => {
    await renderView({ paneId: "pane-1" });

    expect(screen.getByTestId("usage-meter-used-session")).toHaveStyle({
      height: "16px",
      borderRadius: "",
    });
    expect(screen.getByTestId("usage-meter-pace-session")).toHaveStyle({
      height: "3px",
      borderRadius: "",
      background: "rgb(88, 88, 88)",
    });
  });

  it("uses the shared configured colors for Claude and Codex-compatible meters", async () => {
    useSettingsStore
      .getState()
      .setUsageColors({ used: "#112233", pace: "#445566", track: "#778899" });
    await renderView({ paneId: "pane-1" });

    expect(screen.getByTestId("usage-meter-used-session")).toHaveStyle({
      background: "rgb(119, 136, 153)",
    });
    expect(screen.getByTestId("usage-meter-used-session").firstElementChild).toHaveStyle({
      background: "rgb(17, 34, 51)",
    });
    expect(screen.getByTestId("usage-meter-pace-session").firstElementChild).toHaveStyle({
      background: "rgb(68, 85, 102)",
    });
  });

  it("centers the body content with 8px padding", async () => {
    await renderView({ paneId: "pane-1" });

    expect(screen.getByTestId("usage-content")).toHaveClass(
      "p-2",
      "flex-1",
      "min-h-0",
      "justify-center",
    );
    expect(screen.getByTestId("usage-content")).not.toHaveClass("mx-auto", "my-auto");
    expect(screen.getByTestId("usage-content").style.maxWidth).toBe("");
    expect(screen.getByTestId("usage-footer")).toHaveClass("px-2", "pb-2");
  });

  it("hides the Ready and Last capture footer before dropping limit detail", async () => {
    mockBox(200, 200);
    await renderView({ paneId: "pane-1" });

    expect(screen.getByTestId("usage-detail-session")).toBeInTheDocument();
    expect(screen.queryByTestId("usage-footer")).not.toBeInTheDocument();
  });

  it("filters the rendered limits to the configured visible rows", async () => {
    useSettingsStore.getState().setUsageAgent("claude", { visibleRows: ["weekAll"] });
    await renderView({ paneId: "pane-1" });

    expect(screen.queryByTestId("usage-row-session")).not.toBeInTheDocument();
    expect(screen.getByTestId("usage-row-week-all")).toBeInTheDocument();
    expect(screen.queryByTestId("usage-row-week-model")).not.toBeInTheDocument();
  });

  it("abbreviates labels and detail words only when the row becomes narrow", async () => {
    mockBox(230, 600);
    await renderView({ paneId: "pane-1" });

    expect(screen.getByTestId("usage-row-session")).toHaveTextContent("session");
    expect(screen.getByTestId("usage-row-week-all")).toHaveTextContent("week (all)");
    expect(screen.getByTestId("usage-row-week-model")).toHaveTextContent("week (Fable)");
    expect(screen.getByTestId("usage-detail-session")).not.toHaveTextContent("Resets");
    expect(screen.getByTestId("usage-detail-session")).not.toHaveTextContent("elapsed");
  });

  it("shows -- rather than a number when a row has no data", async () => {
    vi.mocked(subscribeUsageProbe).mockResolvedValue(
      snapshot({ status: { type: "starting" }, session: { percent: null, reset: null } }),
    );
    await renderView({ paneId: "pane-1" });
    expect(screen.getByTestId("usage-percent-session")).toHaveTextContent("--");
  });

  it("applies a pushed snapshot for its own config dir", async () => {
    await renderView({ paneId: "pane-1", configDir: "/a" });
    await act(async () => {
      emit?.(snapshot({ configDir: "/a", session: { percent: 77, reset: "7pm" } }));
    });
    expect(screen.getByTestId("usage-percent-session")).toHaveTextContent("77%");
  });

  it("ignores a snapshot for a different config dir", async () => {
    // Snapshots are broadcast to every view, so filtering is what keeps two
    // panes on different profiles from cross-contaminating.
    vi.mocked(subscribeUsageProbe).mockResolvedValue(snapshot({ configDir: "/a" }));
    await renderView({ paneId: "pane-1", configDir: "/a" });
    await act(async () => {
      emit?.(snapshot({ configDir: "/b", session: { percent: 99, reset: "7pm" } }));
    });
    expect(screen.getByTestId("usage-percent-session")).toHaveTextContent("30%");
  });

  it("stacks in a tall pane and uses columns in a wide one", async () => {
    const tall = await renderView({ paneId: "pane-1" });
    expect(screen.getByTestId("usage-body")).toHaveAttribute("data-layout", "stacked");
    tall.unmount();

    mockBox(1000, 300);
    await renderView({ paneId: "pane-2" });
    expect(screen.getByTestId("usage-body")).toHaveAttribute("data-layout", "columns");
  });

  it("goes compact in a thin horizontal strip", async () => {
    mockBox(1200, 40);
    await renderView({ paneId: "pane-1" });
    expect(screen.getByTestId("usage-body")).toHaveAttribute("data-layout", "compact");
    // Compact drops every text label and leaves only the paired meters.
    expect(screen.queryByTestId("usage-footer")).not.toBeInTheDocument();
    expect(screen.queryByTestId("usage-percent-session")).not.toBeInTheDocument();
    expect(screen.getByTestId("usage-meter-used-session")).toHaveStyle({ height: "3px" });
    expect(screen.getByTestId("usage-meter-pace-session")).toHaveStyle({ height: "3px" });
    const barsOnly = screen.getByTestId("usage-row-session").parentElement;
    expect(barsOnly).toHaveClass("flex-row");
    expect(barsOnly).toHaveClass("p-2");
  });

  it("honors a pinned layout override over the measured box", async () => {
    useOverridesStore.setState({ viewOverrides: { "pane-1": { usageLayout: "columns" } } });
    mockBox(400, 600);
    await renderView({ paneId: "pane-1" });
    expect(screen.getByTestId("usage-body")).toHaveAttribute("data-layout", "columns");
  });

  it("cycles the layout override from the header toggle", async () => {
    await renderView({ paneId: "pane-1" });
    fireEvent.click(screen.getByTestId("usage-layout-toggle"));
    expect(useOverridesStore.getState().viewOverrides["pane-1"]?.usageLayout).toBe("stacked");
  });

  it("requests a refresh for its own config dir", async () => {
    await renderView({ paneId: "pane-1", configDir: "/a" });
    fireEvent.click(screen.getByTestId("usage-refresh"));
    expect(refreshUsageProbe).toHaveBeenCalledWith("/a");
  });

  it("surfaces a probe failure instead of showing stale numbers as ready", async () => {
    vi.mocked(subscribeUsageProbe).mockResolvedValue(
      snapshot({ status: { type: "claudeMissing" } }),
    );
    await renderView({ paneId: "pane-1" });
    expect(screen.getByTestId("usage-status")).toHaveTextContent("not found");
  });

  it("surfaces an upstream error message verbatim", async () => {
    vi.mocked(subscribeUsageProbe).mockResolvedValue(
      snapshot({ status: { type: "upstreamError", message: "Error: rate limited" } }),
    );
    await renderView({ paneId: "pane-1" });
    expect(screen.getByTestId("usage-status")).toHaveTextContent("Error: rate limited");
  });

  it("surfaces a subscribe rejection", async () => {
    vi.mocked(subscribeUsageProbe).mockRejectedValue("profile 'WSL' does not exist");
    await renderView({ paneId: "pane-1" });
    expect(screen.getByTestId("usage-status")).toHaveTextContent("does not exist");
  });
});
