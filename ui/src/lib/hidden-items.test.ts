import { describe, expect, it } from "vitest";
import type { Workspace } from "@/stores/types";
import { deriveHiddenItems, findNextVisibleWorkspaceId } from "./hidden-items";

const workspaces: Workspace[] = [
  {
    id: "ws-1",
    name: "Main",
    panes: [
      { id: "p-1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
      { id: "p-2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "MemoView" } },
    ],
  },
  {
    id: "ws-2",
    name: "Experiments",
    panes: [{ id: "p-3", x: 0, y: 0, w: 1, h: 1, view: { type: "TerminalView" } }],
  },
  {
    id: "ws-3",
    name: "Docs",
    panes: [{ id: "p-4", x: 0, y: 0, w: 1, h: 1, view: { type: "EmptyView" } }],
  },
];

describe("deriveHiddenItems", () => {
  it("counts only valid hidden IDs and reports stale IDs", () => {
    const result = deriveHiddenItems({
      workspaces,
      hiddenWorkspaceIds: new Set(["ws-2", "ws-stale"]),
      hiddenPaneIds: new Set(["p-1", "p-3", "p-stale"]),
    });

    expect(result.count).toBe(3);
    expect(result.validHiddenWorkspaceIds).toEqual(new Set(["ws-2"]));
    expect(result.validHiddenPaneIds).toEqual(new Set(["p-1", "p-3"]));
    expect(result.staleWorkspaceIds).toEqual(new Set(["ws-stale"]));
    expect(result.stalePaneIds).toEqual(new Set(["p-stale"]));
  });

  it("groups a hidden workspace's hidden panes beneath it without a top-level duplicate", () => {
    const result = deriveHiddenItems({
      workspaces,
      hiddenWorkspaceIds: new Set(["ws-2"]),
      hiddenPaneIds: new Set(["p-1", "p-3"]),
    });

    expect(result.hiddenWorkspaces).toHaveLength(1);
    expect(result.hiddenWorkspaces[0].workspace.id).toBe("ws-2");
    expect(result.hiddenWorkspaces[0].hiddenPanes.map((item) => item.pane.id)).toEqual(["p-3"]);
    expect(result.hiddenPanes.map((item) => item.pane.id)).toEqual(["p-1"]);
    expect(result.visibleWorkspaces.map((workspace) => workspace.id)).toEqual(["ws-1", "ws-3"]);
  });

  it("keeps a pane hidden when only its parent workspace is restored", () => {
    const result = deriveHiddenItems({
      workspaces,
      hiddenWorkspaceIds: new Set(),
      hiddenPaneIds: new Set(["p-3"]),
    });

    expect(result.hiddenWorkspaces).toHaveLength(0);
    expect(result.hiddenPanes.map((item) => item.pane.id)).toEqual(["p-3"]);
  });

  it("preserves each pane's original index and layout-derived pane number", () => {
    const result = deriveHiddenItems({
      workspaces,
      hiddenWorkspaceIds: new Set(),
      hiddenPaneIds: new Set(["p-2"]),
    });

    expect(result.hiddenPanes[0]).toMatchObject({ paneIndex: 1, paneNumber: 2 });
  });
});

describe("findNextVisibleWorkspaceId", () => {
  it("selects the next visible workspace in manual order", () => {
    expect(
      findNextVisibleWorkspaceId({
        orderedWorkspaces: workspaces,
        activeWorkspaceId: "ws-1",
        hiddenWorkspaceIds: new Set(["ws-2"]),
      }),
    ).toBe("ws-3");
  });

  it("wraps at the end of the current sorted order", () => {
    expect(
      findNextVisibleWorkspaceId({
        orderedWorkspaces: workspaces,
        activeWorkspaceId: "ws-3",
        hiddenWorkspaceIds: new Set(["ws-2"]),
      }),
    ).toBe("ws-1");
  });

  it("uses notification order supplied by the shared sorter", () => {
    expect(
      findNextVisibleWorkspaceId({
        orderedWorkspaces: [workspaces[2], workspaces[0], workspaces[1]],
        activeWorkspaceId: "ws-3",
        hiddenWorkspaceIds: new Set(["ws-2"]),
      }),
    ).toBe("ws-1");
  });

  it("refuses to hide the last visible workspace", () => {
    expect(
      findNextVisibleWorkspaceId({
        orderedWorkspaces: workspaces,
        activeWorkspaceId: "ws-1",
        hiddenWorkspaceIds: new Set(["ws-2", "ws-3"]),
      }),
    ).toBeNull();
  });
});
