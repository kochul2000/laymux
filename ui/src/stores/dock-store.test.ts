import { describe, it, expect, beforeEach } from "vitest";
import { useDockStore } from "./dock-store";

describe("DockStore", () => {
  beforeEach(() => {
    useDockStore.setState(useDockStore.getInitialState());
  });

  it("initializes with 4 docks", () => {
    const state = useDockStore.getState();
    expect(state.docks).toHaveLength(4);
    expect(state.docks.map((d) => d.position)).toEqual([
      "top",
      "bottom",
      "left",
      "right",
    ]);
  });

  it("left dock has WorkspaceSelectorView by default", () => {
    const left = useDockStore.getState().getDock("left");
    expect(left?.activeView).toBe("WorkspaceSelectorView");
  });

  it("sets active view on a dock", () => {
    useDockStore.getState().setDockActiveView("right", "SettingsView");
    const right = useDockStore.getState().getDock("right");
    expect(right?.activeView).toBe("SettingsView");
  });

  it("toggles dock visibility", () => {
    const { toggleDockVisible } = useDockStore.getState();
    toggleDockVisible("left");
    expect(useDockStore.getState().getDock("left")?.visible).toBe(false);
    useDockStore.getState().toggleDockVisible("left");
    expect(useDockStore.getState().getDock("left")?.visible).toBe(true);
  });

  it("initializes docks with default sizes", () => {
    const state = useDockStore.getState();
    expect(state.getDock("left")?.size).toBe(240);
    expect(state.getDock("right")?.size).toBe(240);
    expect(state.getDock("top")?.size).toBe(200);
    expect(state.getDock("bottom")?.size).toBe(200);
  });

  it("sets dock size", () => {
    useDockStore.getState().setDockSize("left", 300);
    expect(useDockStore.getState().getDock("left")?.size).toBe(300);
  });

  it("clamps dock size to minimum", () => {
    useDockStore.getState().setDockSize("left", 30);
    expect(useDockStore.getState().getDock("left")?.size).toBe(100);
  });

  it("clamps dock size to maximum", () => {
    useDockStore.getState().setDockSize("left", 999);
    expect(useDockStore.getState().getDock("left")?.size).toBe(600);
  });

  it("has no focused dock initially", () => {
    expect(useDockStore.getState().focusedDock).toBeNull();
  });

  it("sets and clears focused dock", () => {
    useDockStore.getState().setFocusedDock("left");
    expect(useDockStore.getState().focusedDock).toBe("left");
    useDockStore.getState().setFocusedDock(null);
    expect(useDockStore.getState().focusedDock).toBeNull();
  });

  // -- Dock pane split (2D grid) --

  it("left dock initializes with one pane at full size", () => {
    const left = useDockStore.getState().getDock("left");
    expect(left?.panes).toHaveLength(1);
    expect(left?.panes[0].view.type).toBe("WorkspaceSelectorView");
    expect(left?.panes[0]).toMatchObject({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("splitDockPane horizontal creates two panes stacked vertically", () => {
    useDockStore.getState().splitDockPane("left", "horizontal");
    const left = useDockStore.getState().getDock("left")!;
    expect(left.panes).toHaveLength(2);
    expect(left.panes[0]).toMatchObject({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(left.panes[1]).toMatchObject({ x: 0, y: 0.5, w: 1, h: 0.5 });
    expect(left.panes[1].view.type).toBe("EmptyView");
  });

  it("splitDockPane vertical creates two panes side by side", () => {
    useDockStore.getState().splitDockPane("left", "vertical");
    const left = useDockStore.getState().getDock("left")!;
    expect(left.panes).toHaveLength(2);
    expect(left.panes[0]).toMatchObject({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(left.panes[1]).toMatchObject({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  it("removeDockPane removes a pane and absorber expands", () => {
    useDockStore.getState().splitDockPane("left", "horizontal");
    const left = useDockStore.getState().getDock("left")!;
    const secondPaneId = left.panes[1].id;

    useDockStore.getState().removeDockPane("left", secondPaneId);
    const updated = useDockStore.getState().getDock("left")!;
    expect(updated.panes).toHaveLength(1);
    expect(updated.panes[0]).toMatchObject({ x: 0, y: 0, w: 1, h: 1 });
  });

  it("setDockPaneView changes a pane's view", () => {
    const left = useDockStore.getState().getDock("left")!;
    const paneId = left.panes[0].id;

    useDockStore.getState().setDockPaneView("left", paneId, { type: "SettingsView" });
    const updated = useDockStore.getState().getDock("left")!;
    expect(updated.panes[0].view.type).toBe("SettingsView");
  });

  it("setDockActiveView preserves full ViewInstanceConfig when given", () => {
    useDockStore.getState().setDockActiveView("bottom", "TerminalView", { type: "TerminalView", profile: "WSL" });
    const bottom = useDockStore.getState().getDock("bottom")!;
    expect(bottom.activeView).toBe("TerminalView");
    expect(bottom.panes).toHaveLength(1);
    expect(bottom.panes[0].view).toEqual({ type: "TerminalView", profile: "WSL" });
  });

  it("setDockActiveView with viewConfig updates existing pane's full config", () => {
    // First set to TerminalView
    useDockStore.getState().setDockActiveView("bottom", "TerminalView");
    const bottom1 = useDockStore.getState().getDock("bottom")!;
    expect(bottom1.panes[0].view).toEqual({ type: "TerminalView" });

    // Now update with a config including profile
    useDockStore.getState().setDockActiveView("bottom", "TerminalView", { type: "TerminalView", profile: "CMD" });
    const bottom2 = useDockStore.getState().getDock("bottom")!;
    expect(bottom2.panes[0].view).toEqual({ type: "TerminalView", profile: "CMD" });
  });

  it("resizeDockPane updates pane position/size", () => {
    useDockStore.getState().splitDockPane("left", "horizontal");
    const left = useDockStore.getState().getDock("left")!;
    const paneId = left.panes[0].id;

    useDockStore.getState().resizeDockPane("left", paneId, { h: 0.7 });
    const updated = useDockStore.getState().getDock("left")!;
    expect(updated.panes[0].h).toBeCloseTo(0.7);
  });
});
