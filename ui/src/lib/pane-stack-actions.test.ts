import { beforeEach, describe, expect, it } from "vitest";

import { makeSlot } from "@/lib/pane-layers";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

import {
  cycleFocusedLayer,
  layerStepForDirection,
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
