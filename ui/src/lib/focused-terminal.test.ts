import { describe, expect, it } from "vitest";
import type { DockPane, Workspace } from "@/stores/types";
import { getPaneInstanceId } from "./view-instance-id";
import { resolveFocusedTerminalCwd, resolveFocusedTerminalPane } from "./focused-terminal";

function workspace(id: string, paneId: string, type: "TerminalView" | "MemoView"): Workspace {
  return {
    id,
    name: id,
    panes: [{ id: paneId, x: 0, y: 0, w: 1, h: 1, view: { type } }],
  };
}

function dockPane(id: string, type: "TerminalView" | "MemoView"): DockPane {
  return { id, x: 0, y: 0, w: 1, h: 1, view: { type } };
}

describe("focused terminal resolution", () => {
  it("resolves the active workspace's focused pane", () => {
    const pane = resolveFocusedTerminalPane({
      workspaces: [
        workspace("stale", "stale-pane", "TerminalView"),
        workspace("active", "active-pane", "TerminalView"),
      ],
      activeWorkspaceId: "active",
      focusedPaneIndex: 0,
      docks: [],
      focusedDock: null,
      focusedDockPaneId: null,
    });

    expect(pane?.id).toBe("active-pane");
  });

  it("lets dock focus outrank the workspace grid", () => {
    const focusedDockPane = dockPane("dock-pane", "TerminalView");
    const cwd = resolveFocusedTerminalCwd({
      terminals: [
        { id: "terminal-workspace-pane", cwd: "/workspace" },
        { id: getPaneInstanceId(focusedDockPane)!, cwd: "/dock" },
      ],
      workspaces: [workspace("active", "workspace-pane", "TerminalView")],
      activeWorkspaceId: "active",
      focusedPaneIndex: 0,
      docks: [{ position: "left", panes: [focusedDockPane] }],
      focusedDock: "left",
      focusedDockPaneId: "dock-pane",
    });

    expect(cwd).toBe("/dock");
  });

  it("returns no CWD when the focused pane is not a terminal", () => {
    const cwd = resolveFocusedTerminalCwd({
      terminals: [{ id: "terminal-old", cwd: "/old" }],
      workspaces: [workspace("active", "memo", "MemoView")],
      activeWorkspaceId: "active",
      focusedPaneIndex: 0,
      docks: [],
      focusedDock: null,
      focusedDockPaneId: null,
    });

    expect(cwd).toBeUndefined();
  });
});
