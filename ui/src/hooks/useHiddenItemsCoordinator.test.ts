import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useHiddenItemsCoordinator } from "./useHiddenItemsCoordinator";
import { useUiStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import type { Workspace } from "@/stores/types";

const workspaces: Workspace[] = [
  {
    id: "ws-a",
    name: "A",
    panes: [{ id: "pane-a", x: 0, y: 0, w: 1, h: 1, view: { type: "EmptyView" } }],
  },
  {
    id: "ws-b",
    name: "B",
    panes: [{ id: "pane-b", x: 0, y: 0, w: 1, h: 1, view: { type: "EmptyView" } }],
  },
];

describe("useHiddenItemsCoordinator", () => {
  beforeEach(() => {
    useUiStore.setState(useUiStore.getInitialState());
    useWorkspaceStore.setState({
      workspaces,
      activeWorkspaceId: "ws-a",
      workspaceDisplayOrder: ["ws-a", "ws-b"],
    });
  });

  it("prunes stale hidden and eviction IDs on mount", () => {
    useUiStore.setState({
      hiddenWorkspaceIds: new Set(["ws-a", "ws-stale"]),
      hiddenPaneIds: new Set(["pane-a", "pane-stale"]),
      evictedPaneIds: new Set(["pane-a", "pane-stale"]),
    });
    renderHook(() => useHiddenItemsCoordinator());

    expect(useUiStore.getState().hiddenWorkspaceIds).toEqual(new Set(["ws-a"]));
    expect(useUiStore.getState().hiddenPaneIds).toEqual(new Set(["pane-a"]));
    expect(useUiStore.getState().evictedPaneIds).toEqual(new Set(["pane-a"]));
  });

  it("moves to a visible fallback when external state hides the active workspace", () => {
    renderHook(() => useHiddenItemsCoordinator());
    act(() => useUiStore.getState().setWorkspaceHidden("ws-a", true));
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-b");
  });

  it("restores the active workspace when it is the last visible workspace", () => {
    useUiStore.getState().setWorkspaceHidden("ws-b", true);
    renderHook(() => useHiddenItemsCoordinator());
    act(() => useUiStore.getState().setWorkspaceHidden("ws-a", true));
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-a");
    expect(useUiStore.getState().hiddenWorkspaceIds.has("ws-a")).toBe(false);
  });

  it("prunes IDs immediately after a workspace structure change", () => {
    useUiStore.getState().setWorkspaceHidden("ws-b", true);
    useUiStore.getState().setPaneHidden("pane-b", true);
    renderHook(() => useHiddenItemsCoordinator());

    act(() => {
      useWorkspaceStore.setState({ workspaces: [workspaces[0]], workspaceDisplayOrder: ["ws-a"] });
    });
    expect(useUiStore.getState().hiddenWorkspaceIds.size).toBe(0);
    expect(useUiStore.getState().hiddenPaneIds.size).toBe(0);
  });

  it("prunes a stale pane ID written outside the coordinated action path", () => {
    renderHook(() => useHiddenItemsCoordinator());
    act(() => useUiStore.getState().setPaneHidden("pane-stale", true));
    expect(useUiStore.getState().hiddenPaneIds.size).toBe(0);
  });
});
