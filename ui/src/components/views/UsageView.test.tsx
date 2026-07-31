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
    mockBox(1200, 80);
    await renderView({ paneId: "pane-1" });
    expect(screen.getByTestId("usage-body")).toHaveAttribute("data-layout", "compact");
    // Compact drops the footer detail; the numbers must still be there.
    expect(screen.queryByTestId("usage-footer")).not.toBeInTheDocument();
    expect(screen.getByTestId("usage-percent-session")).toHaveTextContent("30%");
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
