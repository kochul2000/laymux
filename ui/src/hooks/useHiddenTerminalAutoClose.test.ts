import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useHiddenTerminalAutoClose } from "./useHiddenTerminalAutoClose";
import { useUiStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import type { Workspace } from "@/stores/types";

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
    useUiStore.setState(useUiStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    // Active workspace is wsA; wsB is in the background and eligible for eviction.
    useWorkspaceStore.setState({ workspaces: [wsA, wsB], activeWorkspaceId: "wsA" });
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

  it("evicts a hidden background pane after the timeout", () => {
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 10 });
    useUiStore.getState().toggleWorkspaceHidden("wsB");
    renderHook(() => useHiddenTerminalAutoClose());

    // Before the timeout: no eviction.
    act(() => vi.advanceTimersByTime(5_000));
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(false);

    // After the timeout: p2 is evicted, p1 (active workspace) never is.
    act(() => vi.advanceTimersByTime(6_000));
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

  it("clears eviction when the pane is un-hidden", () => {
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 10 });
    useUiStore.getState().toggleWorkspaceHidden("wsB");
    renderHook(() => useHiddenTerminalAutoClose());
    act(() => vi.advanceTimersByTime(15_000));
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(true);

    // Un-hide wsB -> the store subscription drops the eviction immediately.
    act(() => {
      useUiStore.getState().toggleWorkspaceHidden("wsB");
    });
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(false);
  });

  it("resets the timestamp across hide → unhide → immediate re-hide", () => {
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 10 });
    const { unmount } = renderHook(() => useHiddenTerminalAutoClose());

    act(() => useUiStore.getState().setWorkspaceHidden("wsB", true));
    act(() => vi.advanceTimersByTime(10_000));
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(true);

    act(() => {
      useUiStore.getState().setWorkspaceHidden("wsB", false, ["p2"]);
      useUiStore.getState().setWorkspaceHidden("wsB", true);
    });
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(false);

    act(() => vi.advanceTimersByTime(5_000));
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(false);
    act(() => vi.advanceTimersByTime(5_000));
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(true);
    unmount();
  });

  it("re-evaluates immediately when the active workspace changes", () => {
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 10 });
    useUiStore.getState().setWorkspaceHidden("wsB", true);
    renderHook(() => useHiddenTerminalAutoClose());
    act(() => vi.advanceTimersByTime(10_000));
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(true);

    act(() => useWorkspaceStore.getState().setActiveWorkspace("wsB"));
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(false);
  });

  it("clears prior evictions when the feature is disabled at runtime", () => {
    useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 10 });
    useUiStore.getState().toggleWorkspaceHidden("wsB");
    renderHook(() => useHiddenTerminalAutoClose());
    act(() => vi.advanceTimersByTime(15_000));
    expect(useUiStore.getState().evictedPaneIds.has("p2")).toBe(true);

    act(() => {
      useSettingsStore.getState().setWorkspaceSelector({ hiddenAutoCloseSeconds: 0 });
      vi.advanceTimersByTime(5_000);
    });
    expect(useUiStore.getState().evictedPaneIds.size).toBe(0);
  });
});
