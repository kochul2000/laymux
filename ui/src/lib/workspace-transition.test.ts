import { beforeEach, describe, expect, it } from "vitest";

import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import type { Workspace } from "@/stores/types";
import { useWorkspaceStore } from "@/stores/workspace-store";

import { focusDockPane, focusWorkspacePane } from "./workspace-transition";

const workspaces: Workspace[] = [
  {
    id: "ws-a",
    name: "A",
    panes: [{ id: "pane-a", view: { type: "TerminalView" }, x: 0, y: 0, w: 1, h: 1 }],
  },
  {
    id: "ws-b",
    name: "B",
    panes: [{ id: "pane-b", view: { type: "TerminalView" }, x: 0, y: 0, w: 1, h: 1 }],
  },
];

describe("workspace-transition", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
    useGridStore.setState(useGridStore.getInitialState());
    useWorkspaceStore.setState({ workspaces, activeWorkspaceId: "ws-a" });
  });

  it("focuses a workspace pane and clears dock focus as one transition", () => {
    useDockStore.getState().setFocusedDock("left");
    useGridStore.getState().setFocusedPane(null);

    expect(focusWorkspacePane("ws-b", 0)).toBe(true);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-b");
    expect(useDockStore.getState().focusedDock).toBeNull();
    expect(useDockStore.getState().focusedDockPaneId).toBeNull();
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
  });

  it("focuses a dock pane and clears workspace-grid focus as one transition", () => {
    const paneId = useDockStore.getState().getDock("left")?.panes[0]?.id;
    expect(paneId).toBeTruthy();

    expect(focusDockPane("left", paneId)).toBe(true);
    expect(useDockStore.getState().focusedDock).toBe("left");
    expect(useDockStore.getState().focusedDockPaneId).toBe(paneId);
    expect(useGridStore.getState().focusedPaneIndex).toBeNull();
  });

  it("does not mutate any focus store for an invalid workspace pane", () => {
    useDockStore.getState().setFocusedDock("left");
    useGridStore.getState().setFocusedPane(null);

    expect(focusWorkspacePane("ws-b", 9)).toBe(false);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-a");
    expect(useDockStore.getState().focusedDock).toBe("left");
    expect(useGridStore.getState().focusedPaneIndex).toBeNull();
  });
});
