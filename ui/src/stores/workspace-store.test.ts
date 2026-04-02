import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

import { useWorkspaceStore } from "./workspace-store";
import { persistSession } from "@/lib/persist-session";

describe("WorkspaceStore", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    vi.clearAllMocks();
  });

  it("starts with default layout and workspace", () => {
    const state = useWorkspaceStore.getState();
    expect(state.layouts).toHaveLength(1);
    expect(state.workspaces).toHaveLength(1);
    expect(state.activeWorkspaceId).toBe(state.workspaces[0].id);
  });

  it("returns active workspace", () => {
    const state = useWorkspaceStore.getState();
    const active = state.getActiveWorkspace();
    expect(active).toBeDefined();
    expect(active!.id).toBe(state.activeWorkspaceId);
  });

  it("switches active workspace", () => {
    const { addWorkspace } = useWorkspaceStore.getState();
    addWorkspace("Second", useWorkspaceStore.getState().layouts[0].id);
    const ws2 = useWorkspaceStore.getState().workspaces[1];

    useWorkspaceStore.getState().setActiveWorkspace(ws2.id);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(ws2.id);
  });

  it("adds a new workspace", () => {
    const { addWorkspace, layouts } = useWorkspaceStore.getState();
    addWorkspace("New WS", layouts[0].id);
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(2);
  });

  it("addWorkspace does not include profile in pane view (uses defaults from ViewRenderer)", () => {
    // Layout only stores viewType, not profile. ViewRenderer resolves the actual profile.
    const { layouts } = useWorkspaceStore.getState();
    useWorkspaceStore.getState().addWorkspace("New", layouts[0].id);
    const ws = useWorkspaceStore.getState().workspaces[1];
    // Pane view should have type only — profile resolution is ViewRenderer's job
    expect(ws.panes[0].view.type).toBe("EmptyView");
  });

  it("removes a workspace", () => {
    const { addWorkspace, layouts } = useWorkspaceStore.getState();
    addWorkspace("ToRemove", layouts[0].id);
    const wsId = useWorkspaceStore.getState().workspaces[1].id;

    useWorkspaceStore.getState().removeWorkspace(wsId);
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
  });

  it("does not remove last workspace", () => {
    const { removeWorkspace, workspaces } = useWorkspaceStore.getState();
    removeWorkspace(workspaces[0].id);
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
  });

  it("renames a workspace", () => {
    const { renameWorkspace, workspaces } = useWorkspaceStore.getState();
    renameWorkspace(workspaces[0].id, "Renamed");
    expect(useWorkspaceStore.getState().workspaces[0].name).toBe("Renamed");
  });

  // Pane manipulation tests
  describe("splitPane", () => {
    it("splits a pane horizontally", () => {
      useWorkspaceStore.getState().splitPane(0, "horizontal");
      const active = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(active.panes).toHaveLength(2);
      // Original pane takes top half
      expect(active.panes[0].h).toBeCloseTo(0.5);
      // New pane takes bottom half
      expect(active.panes[1].h).toBeCloseTo(0.5);
      expect(active.panes[1].y).toBeCloseTo(0.5);
    });

    it("splits a pane vertically", () => {
      useWorkspaceStore.getState().splitPane(0, "vertical");
      const active = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(active.panes).toHaveLength(2);
      // Original pane takes left half
      expect(active.panes[0].w).toBeCloseTo(0.5);
      // New pane takes right half
      expect(active.panes[1].w).toBeCloseTo(0.5);
      expect(active.panes[1].x).toBeCloseTo(0.5);
    });

    it("does nothing for invalid pane index", () => {
      useWorkspaceStore.getState().splitPane(5, "horizontal");
      const active = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(active.panes).toHaveLength(1);
    });
  });

  describe("removePane", () => {
    it("removes a pane and expands the adjacent one", () => {
      // First split, then remove
      useWorkspaceStore.getState().splitPane(0, "horizontal");
      expect(useWorkspaceStore.getState().getActiveWorkspace()!.panes).toHaveLength(2);

      useWorkspaceStore.getState().removePane(1);
      const active = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(active.panes).toHaveLength(1);
      // The remaining pane should expand back to full size
      expect(active.panes[0].h).toBeCloseTo(1.0);
    });

    it("does not remove last pane", () => {
      useWorkspaceStore.getState().removePane(0);
      const active = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(active.panes).toHaveLength(1);
    });
  });

  describe("setPaneView", () => {
    it("changes the view type of a pane", () => {
      useWorkspaceStore.getState().setPaneView(0, { type: "TerminalView", profile: "WSL" });
      const active = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(active.panes[0].view.type).toBe("TerminalView");
      expect(active.panes[0].view.profile).toBe("WSL");
    });

    it("does nothing for invalid pane index", () => {
      useWorkspaceStore.getState().setPaneView(5, { type: "TerminalView" });
      const active = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(active.panes[0].view.type).toBe("EmptyView");
    });
  });

  describe("resizePane", () => {
    it("resizes a pane within bounds", () => {
      useWorkspaceStore.getState().splitPane(0, "vertical");
      useWorkspaceStore.getState().resizePane(0, { w: 0.7 });
      const active = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(active.panes[0].w).toBeCloseTo(0.7);
    });
  });

  // Layout actions
  describe("exportAsNewLayout", () => {
    it("creates a new layout from current workspace panes", () => {
      useWorkspaceStore.getState().splitPane(0, "horizontal");
      useWorkspaceStore.getState().exportAsNewLayout("My Layout");

      const { layouts } = useWorkspaceStore.getState();
      expect(layouts).toHaveLength(2);
      expect(layouts[1].name).toBe("My Layout");
      expect(layouts[1].panes).toHaveLength(2);
    });

    it("does not link workspace to the new layout", () => {
      useWorkspaceStore.getState().exportAsNewLayout("New");
      const active = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(active).not.toHaveProperty("layoutId");
    });

    it("triggers persistence to settings.json", () => {
      useWorkspaceStore.getState().exportAsNewLayout("New");
      expect(persistSession).toHaveBeenCalledTimes(1);
    });
  });

  describe("exportToLayout", () => {
    it("overwrites existing layout with current workspace panes", () => {
      useWorkspaceStore.getState().splitPane(0, "vertical");
      const layoutId = useWorkspaceStore.getState().layouts[0].id;
      useWorkspaceStore.getState().exportToLayout(layoutId);

      const layout = useWorkspaceStore.getState().layouts[0];
      expect(layout.panes).toHaveLength(2);
    });

    it("triggers persistence to settings.json", () => {
      const layoutId = useWorkspaceStore.getState().layouts[0].id;
      useWorkspaceStore.getState().exportToLayout(layoutId);
      expect(persistSession).toHaveBeenCalledTimes(1);
    });
  });

  describe("Workspace operations do not disrupt pane identity", () => {
    it("renameWorkspace preserves all pane IDs of the renamed workspace", () => {
      // Set up a workspace with multiple panes
      useWorkspaceStore.getState().splitPane(0, "vertical");
      const before = useWorkspaceStore.getState().getActiveWorkspace()!;
      const paneIdsBefore = before.panes.map((p) => p.id);

      useWorkspaceStore.getState().renameWorkspace(before.id, "NewName");

      const after = useWorkspaceStore.getState().getActiveWorkspace()!;
      const paneIdsAfter = after.panes.map((p) => p.id);
      expect(paneIdsAfter).toEqual(paneIdsBefore);
    });

    it("renameWorkspace does not change pane structure (x/y/w/h/view)", () => {
      useWorkspaceStore.getState().splitPane(0, "horizontal");
      useWorkspaceStore.getState().setPaneView(0, { type: "TerminalView", profile: "WSL" });
      const before = useWorkspaceStore.getState().getActiveWorkspace()!;
      const structureBefore = before.panes.map(({ x, y, w, h, view }) => ({ x, y, w, h, view }));

      useWorkspaceStore.getState().renameWorkspace(before.id, "Renamed");

      const after = useWorkspaceStore.getState().getActiveWorkspace()!;
      const structureAfter = after.panes.map(({ x, y, w, h, view }) => ({ x, y, w, h, view }));
      expect(structureAfter).toEqual(structureBefore);
    });

    it("addWorkspace does not change existing workspace pane IDs", () => {
      useWorkspaceStore.getState().splitPane(0, "vertical");
      const before = useWorkspaceStore.getState().getActiveWorkspace()!;
      const paneIdsBefore = before.panes.map((p) => p.id);

      useWorkspaceStore
        .getState()
        .addWorkspace("Second", useWorkspaceStore.getState().layouts[0].id);

      const after = useWorkspaceStore.getState().workspaces.find((ws) => ws.id === before.id)!;
      expect(after.panes.map((p) => p.id)).toEqual(paneIdsBefore);
    });

    it("removeWorkspace (non-active) does not change active workspace pane IDs", () => {
      const { layouts } = useWorkspaceStore.getState();
      useWorkspaceStore.getState().addWorkspace("ToRemove", layouts[0].id);
      useWorkspaceStore.getState().splitPane(0, "horizontal");
      const active = useWorkspaceStore.getState().getActiveWorkspace()!;
      const paneIdsBefore = active.panes.map((p) => p.id);

      const toRemove = useWorkspaceStore.getState().workspaces.find((ws) => ws.id !== active.id)!;
      useWorkspaceStore.getState().removeWorkspace(toRemove.id);

      const after = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(after.panes.map((p) => p.id)).toEqual(paneIdsBefore);
    });

    it("duplicateWorkspace does not change source workspace pane IDs", () => {
      useWorkspaceStore.getState().splitPane(0, "vertical");
      const source = useWorkspaceStore.getState().getActiveWorkspace()!;
      const paneIdsBefore = source.panes.map((p) => p.id);

      useWorkspaceStore.getState().duplicateWorkspace(source.id);

      const after = useWorkspaceStore.getState().workspaces.find((ws) => ws.id === source.id)!;
      expect(after.panes.map((p) => p.id)).toEqual(paneIdsBefore);
    });

    it("renaming a non-active workspace does not change active workspace pane IDs", () => {
      const { layouts } = useWorkspaceStore.getState();
      useWorkspaceStore.getState().addWorkspace("Other", layouts[0].id);
      useWorkspaceStore.getState().splitPane(0, "horizontal");
      const active = useWorkspaceStore.getState().getActiveWorkspace()!;
      const paneIdsBefore = active.panes.map((p) => p.id);

      const other = useWorkspaceStore.getState().workspaces.find((ws) => ws.id !== active.id)!;
      useWorkspaceStore.getState().renameWorkspace(other.id, "RenamedOther");

      const after = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(after.panes.map((p) => p.id)).toEqual(paneIdsBefore);
    });
  });

  describe("ID uniqueness after session restore", () => {
    it("new workspace IDs never collide with restored workspace IDs", () => {
      // Simulate session restoration: setState with workspaces that have specific IDs
      useWorkspaceStore.setState({
        layouts: [
          { id: "layout-1", name: "L", panes: [{ x: 0, y: 0, w: 1, h: 1, viewType: "EmptyView" }] },
        ],
        workspaces: [
          {
            id: "ws-99",
            name: "Restored",
            panes: [{ id: "p-1", x: 0, y: 0, w: 1, h: 1, view: { type: "EmptyView" } }],
          },
        ],
        activeWorkspaceId: "ws-99",
      });

      // Add new workspaces — IDs must not collide with "ws-99"
      useWorkspaceStore.getState().addWorkspace("New1", "layout-1");
      useWorkspaceStore.getState().addWorkspace("New2", "layout-1");

      const ids = useWorkspaceStore.getState().workspaces.map((ws) => ws.id);
      // All workspace IDs must be unique
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("new workspace IDs never collide with each other across many additions", () => {
      for (let i = 0; i < 20; i++) {
        useWorkspaceStore.getState().addWorkspace(`WS${i}`, "default-layout");
      }

      const ids = useWorkspaceStore.getState().workspaces.map((ws) => ws.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("pane IDs never collide with restored pane IDs", () => {
      useWorkspaceStore.setState({
        layouts: [
          { id: "layout-1", name: "L", panes: [{ x: 0, y: 0, w: 1, h: 1, viewType: "EmptyView" }] },
        ],
        workspaces: [
          {
            id: "ws-restored",
            name: "Restored",
            panes: [{ id: "pane-5", x: 0, y: 0, w: 1, h: 1, view: { type: "EmptyView" } }],
          },
        ],
        activeWorkspaceId: "ws-restored",
      });

      // Split creates new pane — its ID must not be "pane-5"
      useWorkspaceStore.getState().splitPane(0, "vertical");
      const panes = useWorkspaceStore.getState().getActiveWorkspace()!.panes;
      const paneIds = panes.map((p) => p.id);
      expect(new Set(paneIds).size).toBe(paneIds.length);
    });
  });

  describe("reorderWorkspaces", () => {
    it("reorders workspaces by moving an item by ID", () => {
      const { addWorkspace, layouts } = useWorkspaceStore.getState();
      addWorkspace("WS2", layouts[0].id);
      addWorkspace("WS3", layouts[0].id);

      const before = useWorkspaceStore.getState().workspaces;
      expect(before).toHaveLength(3);
      const ids = before.map((ws) => ws.id);

      // Move last to first position
      useWorkspaceStore.getState().reorderWorkspaces(ids[2], ids[0]);
      const after = useWorkspaceStore.getState().workspaces;
      expect(after.map((ws) => ws.id)).toEqual([ids[2], ids[0], ids[1]]);
    });

    it("does nothing for same from/to ID", () => {
      const { addWorkspace, layouts } = useWorkspaceStore.getState();
      addWorkspace("WS2", layouts[0].id);

      const before = useWorkspaceStore.getState().workspaces.map((ws) => ws.id);
      useWorkspaceStore.getState().reorderWorkspaces(before[0], before[0]);
      const after = useWorkspaceStore.getState().workspaces.map((ws) => ws.id);
      expect(after).toEqual(before);
    });

    it("does nothing for non-existent IDs", () => {
      const before = useWorkspaceStore.getState().workspaces.map((ws) => ws.id);
      useWorkspaceStore.getState().reorderWorkspaces("nonexistent", before[0]);
      expect(useWorkspaceStore.getState().workspaces.map((ws) => ws.id)).toEqual(before);

      useWorkspaceStore.getState().reorderWorkspaces(before[0], "nonexistent");
      expect(useWorkspaceStore.getState().workspaces.map((ws) => ws.id)).toEqual(before);
    });

    it("inserts after target when position is 'bottom'", () => {
      const { addWorkspace, layouts } = useWorkspaceStore.getState();
      addWorkspace("WS2", layouts[0].id);
      addWorkspace("WS3", layouts[0].id);

      const ids = useWorkspaceStore.getState().workspaces.map((ws) => ws.id);
      // Move first to after second (bottom of ids[1])
      useWorkspaceStore.getState().reorderWorkspaces(ids[0], ids[1], "bottom");
      const after = useWorkspaceStore.getState().workspaces.map((ws) => ws.id);
      expect(after).toEqual([ids[1], ids[0], ids[2]]);
    });

    it("preserves pane IDs after reorder", () => {
      const { addWorkspace, layouts } = useWorkspaceStore.getState();
      addWorkspace("WS2", layouts[0].id);

      const before = useWorkspaceStore.getState().workspaces;
      const paneIds0 = before[0].panes.map((p) => p.id);
      const paneIds1 = before[1].panes.map((p) => p.id);

      useWorkspaceStore.getState().reorderWorkspaces(before[1].id, before[0].id);
      const after = useWorkspaceStore.getState().workspaces;
      expect(after[0].panes.map((p) => p.id)).toEqual(paneIds1);
      expect(after[1].panes.map((p) => p.id)).toEqual(paneIds0);
    });
  });

  describe("Pane ID stability", () => {
    it("default workspace panes have an id", () => {
      const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(ws.panes[0].id).toBeDefined();
      expect(typeof ws.panes[0].id).toBe("string");
    });

    it("split pane keeps original pane id and assigns new id to new pane", () => {
      const originalId = useWorkspaceStore.getState().getActiveWorkspace()!.panes[0].id;
      useWorkspaceStore.getState().splitPane(0, "vertical");
      const panes = useWorkspaceStore.getState().getActiveWorkspace()!.panes;
      expect(panes).toHaveLength(2);
      expect(panes[0].id).toBe(originalId);
      expect(panes[1].id).toBeDefined();
      expect(panes[1].id).not.toBe(originalId);
    });

    it("addWorkspace creates panes with unique ids", () => {
      useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
      const ws = useWorkspaceStore.getState().workspaces;
      const ids1 = ws[0].panes.map((p) => p.id);
      const ids2 = ws[1].panes.map((p) => p.id);
      // All pane ids across workspaces should be unique
      const allIds = [...ids1, ...ids2];
      expect(new Set(allIds).size).toBe(allIds.length);
    });
  });
});
