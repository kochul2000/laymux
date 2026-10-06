import { beforeEach, describe, expect, it } from "vitest";

import { makeSlot } from "@/lib/pane-layers";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

import {
  cycleFocusedLayer,
  extractLayerToSplit,
  layerStepForDirection,
  mergeSlotIntoStack,
  moveLayerTo,
  stackFocusedPane,
  stackPaneAt,
} from "./pane-stack-actions";

describe("pane-stack-actions (ADR-0295)", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
    useGridStore.setState(useGridStore.getInitialState());
    useWorkspaceStore.setState({
      activeWorkspaceId: "ws",
      workspaces: [
        {
          id: "ws",
          name: "WS",
          panes: [
            makeSlot("a", { x: 0, y: 0, w: 0.5, h: 1 }, { type: "TerminalView" }),
            makeSlot("b", { x: 0.5, y: 0, w: 0.5, h: 1 }, { type: "TerminalView" }),
          ],
        },
      ],
    });
  });

  it("stackPaneAt stacks, shows and focuses the new layer", () => {
    useDockStore.getState().setFocusedDock("left");
    const id = stackPaneAt(1)!;
    const slot = useWorkspaceStore.getState().workspaces[0].panes[1];
    expect(slot.activeLayerId).toBe(id);
    expect(useGridStore.getState().focusedPaneIndex).toBe(1);
    expect(useDockStore.getState().focusedDock).toBeNull();
  });

  it("stackFocusedPane targets the focused slot and ignores dock focus", () => {
    useGridStore.setState({ focusedPaneIndex: 0 });
    expect(stackFocusedPane()).not.toBeNull();
    expect(useWorkspaceStore.getState().workspaces[0].panes[0].layers).toHaveLength(2);

    useDockStore.getState().setFocusedDock("left");
    expect(stackFocusedPane()).toBeNull();
  });

  it("cycleFocusedLayer walks the ring and refuses unstacked slots", () => {
    useGridStore.setState({ focusedPaneIndex: 0 });
    expect(cycleFocusedLayer(1)).toBe(false);
    const second = stackPaneAt(0)!;
    const third = stackPaneAt(0)!;
    const ids = () => useWorkspaceStore.getState().workspaces[0].panes[0];
    expect(ids().activeLayerId).toBe(third);
    expect(cycleFocusedLayer(1)).toBe(true);
    expect(ids().activeLayerId).toBe("a");
    expect(cycleFocusedLayer(-1)).toBe(true);
    expect(ids().activeLayerId).toBe(third);
    cycleFocusedLayer(-1);
    expect(ids().activeLayerId).toBe(second);
  });

  it("maps arrow directions to ring steps", () => {
    expect(layerStepForDirection("right")).toBe(1);
    expect(layerStepForDirection("down")).toBe(1);
    expect(layerStepForDirection("left")).toBe(-1);
    expect(layerStepForDirection("up")).toBe(-1);
  });
});

describe("pane-stack-actions rearrangement (ADR-0295)", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
    useGridStore.setState(useGridStore.getInitialState());
    useWorkspaceStore.setState({
      activeWorkspaceId: "ws",
      workspaces: [
        {
          id: "ws",
          name: "WS",
          panes: [
            {
              id: "a",
              x: 0,
              y: 0,
              w: 0.5,
              h: 1,
              layers: [
                { id: "a", view: { type: "MemoView" } },
                { id: "a2", view: { type: "MemoView" } },
              ],
              activeLayerId: "a",
            },
            makeSlot("b", { x: 0.5, y: 0, w: 0.5, h: 1 }, { type: "MemoView" }),
          ],
        },
      ],
    });
    useGridStore.setState({ focusedPaneIndex: 0 });
  });

  const panes = () => useWorkspaceStore.getState().workspaces[0].panes;

  it("moveLayerTo focuses the destination slot for cross-slot moves only", () => {
    expect(moveLayerTo("a2", "a", 0)).toBe(true);
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
    expect(panes()[0].activeLayerId).toBe("a");

    expect(moveLayerTo("a2", "b")).toBe(true);
    expect(panes()[1].activeLayerId).toBe("a2");
    expect(useGridStore.getState().focusedPaneIndex).toBe(1);
  });

  it("extractLayerToSplit focuses the new slot", () => {
    const newSlotId = extractLayerToSplit("a2", "vertical");
    expect(newSlotId).toBe("a2");
    expect(useGridStore.getState().focusedPaneIndex).toBe(1);
    expect(panes().map((p) => p.id)).toEqual(["a", "a2", "b"]);
  });

  it("mergeSlotIntoStack shows the visible layer of the dragged slot", () => {
    expect(mergeSlotIntoStack("a", "b")).toBe(true);
    expect(panes()).toHaveLength(1);
    expect(panes()[0].activeLayerId).toBe("a");
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
  });
});
