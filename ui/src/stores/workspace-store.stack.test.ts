import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

import { useWorkspaceStore } from "./workspace-store";
import { useOverridesStore } from "./overrides-store";
import { useTerminalRestartStore } from "./terminal-restart-store";
import { useTerminalStore } from "./terminal-store";
import { makeSlot } from "@/lib/pane-layers";
import type { WorkspacePane } from "./types";

/** Pane stack store actions (ADR-0295). */
describe("WorkspaceStore pane stacks", () => {
  const term = { type: "TerminalView" as const, profile: "WSL" };

  function active() {
    return useWorkspaceStore.getState().getActiveWorkspace()!;
  }

  function setPanes(panes: WorkspacePane[]) {
    const st = useWorkspaceStore.getState();
    useWorkspaceStore.setState({
      workspaces: st.workspaces.map((w) => (w.id === st.activeWorkspaceId ? { ...w, panes } : w)),
    });
  }

  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    setPanes([makeSlot("p0", { x: 0, y: 0, w: 1, h: 1 }, term)]);
    useOverridesStore.setState({ paneOverrides: {}, viewOverrides: {} });
    useTerminalRestartStore.setState({ requests: {} });
    useTerminalStore.setState(useTerminalStore.getInitialState());
    localStorage.clear();
  });

  it("stackPane adds an EmptyView layer after the active one and activates it", () => {
    const layerId = useWorkspaceStore.getState().stackPane(0)!;
    const slot = active().panes[0];
    expect(slot.id).toBe("p0");
    expect(slot.layers.map((l) => l.id)).toEqual(["p0", layerId]);
    expect(slot.layers[1].view).toEqual({ type: "EmptyView" });
    expect(slot.activeLayerId).toBe(layerId);
    // geometry is untouched — stacking never resizes
    expect([slot.x, slot.y, slot.w, slot.h]).toEqual([0, 0, 1, 1]);
  });

  it("stackPane returns null for an invalid slot", () => {
    expect(useWorkspaceStore.getState().stackPane(5)).toBeNull();
  });

  it("stackPane seeds the new layer with the active layer's live CWD", () => {
    useTerminalStore.getState().registerInstance({
      id: "terminal-p0",
      profile: "WSL",
      syncGroup: "g",
      workspaceId: "ws-default",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-p0", { cwd: "/repo" });
    const layerId = useWorkspaceStore.getState().stackPane(0)!;
    expect(useTerminalRestartStore.getState().requests[layerId]?.cwd).toBe("/repo");
  });

  it("splitPane seeds from the slot's active layer, not the slot id", () => {
    const layerId = useWorkspaceStore.getState().stackPane(0, term)!;
    useTerminalStore.getState().registerInstance({
      id: `terminal-${layerId}`,
      profile: "WSL",
      syncGroup: "g",
      workspaceId: "ws-default",
    });
    useTerminalStore.getState().updateInstanceInfo(`terminal-${layerId}`, { cwd: "/stacked" });
    useWorkspaceStore.getState().splitPane(0, "vertical");
    const newSlot = active().panes[1];
    expect(newSlot.layers).toHaveLength(1);
    expect(useTerminalRestartStore.getState().requests[newSlot.id]?.cwd).toBe("/stacked");
  });

  it("setActiveLayer switches the visible layer and validates ids", () => {
    const layerId = useWorkspaceStore.getState().stackPane(0)!;
    const ws = active();
    expect(useWorkspaceStore.getState().setActiveLayer(ws.id, "p0")).toBe(true);
    expect(active().panes[0].activeLayerId).toBe("p0");
    expect(useWorkspaceStore.getState().setActiveLayer(ws.id, "nope")).toBe(false);
    expect(useWorkspaceStore.getState().setActiveLayer("ws-nope", layerId)).toBe(false);
    expect(active().panes[0].activeLayerId).toBe("p0");
  });

  it("removePane on a stack closes only the active layer and keeps the slot", () => {
    const layerId = useWorkspaceStore.getState().stackPane(0)!;
    useWorkspaceStore.getState().removePane(0);
    const slot = active().panes[0];
    expect(slot.layers.map((l) => l.id)).toEqual(["p0"]);
    expect(slot.activeLayerId).toBe("p0");
    expect(slot.layers.some((l) => l.id === layerId)).toBe(false);
  });

  it("removePane with a layerId closes that layer", () => {
    useWorkspaceStore.getState().stackPane(0);
    useWorkspaceStore.getState().removePane(0, "p0");
    const slot = active().panes[0];
    expect(slot.id).toBe("p0");
    expect(slot.layers).toHaveLength(1);
    expect(slot.layers[0].id).not.toBe("p0");
  });

  it("closing the slot-id layer keeps the slot's pane override but drops its view override", () => {
    useWorkspaceStore.getState().stackPane(0);
    useOverridesStore.getState().setPaneOverride("p0", { controlBarMode: "pinned" });
    useOverridesStore.getState().setViewOverride("p0", { fontSize: 20 });
    useWorkspaceStore.getState().removePane(0, "p0");
    expect(useOverridesStore.getState().paneOverrides.p0?.controlBarMode).toBe("pinned");
    expect(useOverridesStore.getState().viewOverrides.p0).toBeUndefined();
  });

  it("removePane on the only layer of the only slot is a no-op", () => {
    useWorkspaceStore.getState().removePane(0);
    expect(active().panes).toHaveLength(1);
    expect(active().panes[0].layers).toHaveLength(1);
  });

  it("removeSlot drops a whole stack and redistributes its space", () => {
    useWorkspaceStore.getState().splitPane(0, "vertical");
    useWorkspaceStore.getState().stackPane(1);
    useWorkspaceStore.getState().removeSlot(1);
    const panes = active().panes;
    expect(panes).toHaveLength(1);
    expect(panes[0].w).toBeCloseTo(1);
  });

  it("setPaneView changes the active layer by default, or a named layer", () => {
    const layerId = useWorkspaceStore.getState().stackPane(0)!;
    useWorkspaceStore.getState().setPaneView(0, { type: "MemoView" });
    expect(active().panes[0].layers[1]).toEqual({ id: layerId, view: { type: "MemoView" } });
    useWorkspaceStore.getState().setPaneView(0, { type: "GitHubView" }, "p0");
    expect(active().panes[0].layers[0].view).toEqual({ type: "GitHubView" });
  });

  it("swapPanes and movePaneToWorkspace carry every layer", () => {
    useWorkspaceStore.getState().splitPane(0, "vertical");
    const layerId = useWorkspaceStore.getState().stackPane(0)!;
    useWorkspaceStore.getState().swapPanes(0, 1);
    expect(active().panes[0].layers.map((l) => l.id)).toEqual(["p0", layerId]);
    expect(active().panes[0].x).toBeCloseTo(0.5);

    useWorkspaceStore.getState().addWorkspace("Other", useWorkspaceStore.getState().layouts[0].id);
    const other = useWorkspaceStore.getState().workspaces.at(-1)!;
    // a layer id resolves to its slot
    useWorkspaceStore.getState().movePaneToWorkspace(layerId, other.id);
    const moved = useWorkspaceStore
      .getState()
      .workspaces.find((w) => w.id === other.id)!
      .panes.find((p) => p.id === "p0")!;
    expect(moved.layers.map((l) => l.id)).toEqual(["p0", layerId]);
    expect(moved.activeLayerId).toBe(layerId);
  });

  it("duplicateWorkspace maps slot and layer ids and preserves the active layer", () => {
    const layerId = useWorkspaceStore.getState().stackPane(0, { type: "MemoView" })!;
    const result = useWorkspaceStore.getState().duplicateWorkspace(active().id)!;
    const copy = useWorkspaceStore
      .getState()
      .workspaces.find((w) => w.id === result.newWorkspaceId)!;
    const slot = copy.panes[0];
    expect(result.paneIdMap.p0).toBe(slot.id);
    expect(slot.layers[0].id).toBe(slot.id);
    expect(result.paneIdMap[layerId]).toBe(slot.layers[1].id);
    expect(slot.activeLayerId).toBe(slot.layers[1].id);
    expect(slot.layers[1].view).toEqual({ type: "MemoView" });
  });

  it("exports stacks to layouts and recreates them in new workspaces", () => {
    useWorkspaceStore.getState().stackPane(0, { type: "MemoView" });
    useWorkspaceStore.getState().exportAsNewLayout("Stacked");
    const layout = useWorkspaceStore.getState().layouts.at(-1)!;
    expect(layout.panes[0].layers?.map((l) => l.viewType)).toEqual(["TerminalView", "MemoView"]);
    expect(layout.panes[0].activeLayerIndex).toBe(1);
    expect(layout.panes[0].viewType).toBe("MemoView");

    useWorkspaceStore.getState().addWorkspace("FromStack", layout.id);
    const created = useWorkspaceStore.getState().workspaces.at(-1)!;
    const slot = created.panes[0];
    expect(slot.layers.map((l) => l.view.type)).toEqual(["TerminalView", "MemoView"]);
    expect(slot.layers[0].id).toBe(slot.id);
    expect(slot.activeLayerId).toBe(slot.layers[1].id);
  });

  it("removeWorkspace forgets restart requests of every layer", () => {
    const layerId = useWorkspaceStore.getState().stackPane(0)!;
    useTerminalRestartStore.getState().requestRestart(layerId, "/x");
    useWorkspaceStore.getState().addWorkspace("Keep", useWorkspaceStore.getState().layouts[0].id);
    useWorkspaceStore.getState().removeWorkspace(active().id);
    expect(useTerminalRestartStore.getState().requests[layerId]).toBeUndefined();
  });
});
