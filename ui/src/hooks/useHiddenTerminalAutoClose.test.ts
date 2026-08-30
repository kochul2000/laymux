import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useHiddenTerminalAutoClose } from "./useHiddenTerminalAutoClose";
import { useUiStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import type { Workspace } from "@/stores/types";

vi.mock("@/lib/tauri-api", () => ({
  checkpointAndCloseHiddenTerminals: vi.fn(),
}));

import { checkpointAndCloseHiddenTerminals } from "@/lib/tauri-api";

const wsA: Workspace = {
  id: "wsA",
  name: "A",
  panes: [{ id: "p1", x: 0, y: 0, w: 1, h: 1, view: { type: "TerminalView" } }],
};
const wsB: Workspace = {
  id: "wsB",
  name: "B",
  panes: [{ id: "p2", x: 0, y: 0, w: 1, h: 1, view: { type: "TerminalView" } }],
};

describe("useHiddenTerminalAutoClose", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    vi.clearAllMocks();
    useUiStore.setState(useUiStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    // Active workspace is wsA; wsB is in the background and eligible for eviction.
    useWorkspaceStore.setState({ workspaces: [wsA, wsB], activeWorkspaceId: "wsA" });
    vi.mocked(checkpointAndCloseHiddenTerminals).mockImplementation(async (terminalIds) => ({
      closedTerminalIds: [...terminalIds],
      failedTerminalIds: [],
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing when the timeout is disabled (0)", () => {
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 0 });
    useUiStore.getState().toggleWorkspaceHidden("wsB");
    renderHook(() => useHiddenTerminalAutoClose());
    act(() => vi.advanceTimersByTime(60_000));
    expect(useUiStore.getState().evictedPaneIds.size).toBe(0);
  });

  it("evicts a hidden background pane after the timeout", async () => {
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 10 });
    useUiStore.getState().toggleWorkspaceHidden("wsB");
    renderHook(() => useHiddenTerminalAutoClose());

    // Before the timeout: no eviction.
    act(() => vi.advanceTimersByTime(5_000));
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(false);

    // After the timeout: p2 is evicted, p1 (active workspace) never is.
    await act(async () => {
      vi.advanceTimersByTime(6_000);
      await Promise.resolve();
    });
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(true);
    expect(useUiStore.getState().evictedPaneIds.has("p1")).toBe(false);
  });

  it("never evicts panes in the active workspace even when flagged hidden", () => {
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 10 });
    useUiStore.getState().togglePaneHidden("p1"); // p1 is in active wsA
    renderHook(() => useHiddenTerminalAutoClose());
    act(() => vi.advanceTimersByTime(30_000));
    expect(useUiStore.getState().evictedPaneIds.has("p1")).toBe(false);
  });

  it("clears eviction when the pane is un-hidden", async () => {
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 10 });
    useUiStore.getState().toggleWorkspaceHidden("wsB");
    renderHook(() => useHiddenTerminalAutoClose());
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(true);

    // Un-hide wsB -> the store subscription drops the eviction immediately.
    act(() => {
      useUiStore.getState().toggleWorkspaceHidden("wsB");
    });
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(false);
  });

  it("resets the timestamp across hide → unhide → immediate re-hide", async () => {
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 10 });
    const { unmount } = renderHook(() => useHiddenTerminalAutoClose());

    act(() => useUiStore.getState().setWorkspaceHidden("wsB", true));
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(true);

    act(() => {
      useUiStore.getState().setWorkspaceHidden("wsB", false, ["p2"]);
      useUiStore.getState().setWorkspaceHidden("wsB", true);
    });
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(false);

    act(() => vi.advanceTimersByTime(5_000));
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(false);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(true);
    unmount();
  });

  it("re-evaluates immediately when the active workspace changes", async () => {
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 10 });
    useUiStore.getState().setWorkspaceHidden("wsB", true);
    renderHook(() => useHiddenTerminalAutoClose());
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(true);

    act(() => useWorkspaceStore.getState().setActiveWorkspace("wsB"));
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(false);
  });

  it("clears prior evictions when the feature is disabled at runtime", async () => {
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 10 });
    useUiStore.getState().toggleWorkspaceHidden("wsB");
    renderHook(() => useHiddenTerminalAutoClose());
    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(true);

    act(() => {
      useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 0 });
      vi.advanceTimersByTime(5_000);
    });
    expect(useUiStore.getState().evictedPaneIds.size).toBe(0);
  });

  it("does not evict after a pending barrier when the feature was disabled", async () => {
    let finishCheckpoint: (() => void) | undefined;
    vi.mocked(checkpointAndCloseHiddenTerminals).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCheckpoint = () =>
            resolve({ closedTerminalIds: ["terminal-p2"], failedTerminalIds: [] });
        }),
    );
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 10 });
    useUiStore.getState().toggleWorkspaceHidden("wsB");
    renderHook(() => useHiddenTerminalAutoClose());
    act(() => vi.advanceTimersByTime(10_000));
    expect(checkpointAndCloseHiddenTerminals).toHaveBeenCalledWith(["terminal-p2"]);

    act(() => useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 0 }));
    await act(async () => {
      finishCheckpoint?.();
      await Promise.resolve();
      vi.advanceTimersByTime(0);
    });

    expect(useUiStore.getState().evictedPaneIds.size).toBe(0);
  });

  it("evicts only PTYs that the backend closed after its checkpoint transaction", async () => {
    vi.mocked(checkpointAndCloseHiddenTerminals).mockResolvedValueOnce({
      closedTerminalIds: [],
      failedTerminalIds: ["terminal-p2"],
    });
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 10 });
    useUiStore.getState().toggleWorkspaceHidden("wsB");
    renderHook(() => useHiddenTerminalAutoClose());

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(false);
  });

  it("records a backend close even if the hook unmounted while the transaction was pending", async () => {
    let finishEviction: (() => void) | undefined;
    vi.mocked(checkpointAndCloseHiddenTerminals).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishEviction = () =>
            resolve({ closedTerminalIds: ["terminal-p2"], failedTerminalIds: [] });
        }),
    );
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 10 });
    useUiStore.getState().toggleWorkspaceHidden("wsB");
    const { unmount } = renderHook(() => useHiddenTerminalAutoClose());
    act(() => vi.advanceTimersByTime(10_000));
    unmount();

    await act(async () => {
      finishEviction?.();
      await Promise.resolve();
    });

    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(true);
  });
});
