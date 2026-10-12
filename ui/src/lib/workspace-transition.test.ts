import { beforeEach, describe, expect, it } from "vitest";

import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import type { Workspace } from "@/stores/types";
import { useWorkspaceStore } from "@/stores/workspace-store";

import { activatePaneLayer, focusDockPane, focusWorkspacePane } from "./workspace-transition";

const workspaces: Workspace[] = [
  {
    id: "ws-a",
    name: "A",
    panes: [
      {
        id: "pane-a",
        layers: [{ id: "pane-a", view: { type: "TerminalView" } }],
        activeLayerId: "pane-a",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      },
    ],
  },
  {
    id: "ws-b",
    name: "B",
    panes: [
      {
        id: "pane-b",
        layers: [{ id: "pane-b", view: { type: "TerminalView" } }],
        activeLayerId: "pane-b",
        x: 0,
        y: 0,
        w: 1,
        h: 1,
      },
    ],
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

describe("activatePaneLayer (ADR-0297)", () => {
  const stacked: Workspace[] = [
    {
      id: "ws-a",
      name: "A",
      panes: [
        {
          id: "slot",
          x: 0,
          y: 0,
          w: 1,
          h: 1,
          layers: [
            { id: "slot", view: { type: "TerminalView" } },
            { id: "under", view: { type: "MemoView" } },
          ],
          activeLayerId: "slot",
        },
      ],
    },
    { id: "ws-b", name: "B", panes: workspaces[1].panes },
  ];

  beforeEach(() => {
    useWorkspaceStore.setState({ workspaces: stacked, activeWorkspaceId: "ws-b" });
    useDockStore.getState().setFocusedDock("left");
    useGridStore.getState().setFocusedPane(null);
  });

  it("shows the layer and focuses its slot in one transition", () => {
    expect(activatePaneLayer("ws-a", "under")).toBe(true);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-a");
    expect(useWorkspaceStore.getState().workspaces[0].panes[0].activeLayerId).toBe("under");
    expect(useDockStore.getState().focusedDock).toBeNull();
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
  });

  it("can switch the layer without moving focus", () => {
    expect(activatePaneLayer("ws-a", "under", { focus: false })).toBe(true);
    expect(useWorkspaceStore.getState().workspaces[0].panes[0].activeLayerId).toBe("under");
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-b");
    expect(useDockStore.getState().focusedDock).toBe("left");
  });

  it("touches no store for an unknown layer or workspace", () => {
    expect(activatePaneLayer("ws-a", "nope")).toBe(false);
    expect(activatePaneLayer("ws-x", "under")).toBe(false);
    expect(useWorkspaceStore.getState().workspaces[0].panes[0].activeLayerId).toBe("slot");
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-b");
    expect(useDockStore.getState().focusedDock).toBe("left");
  });
});
