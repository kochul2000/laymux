import { describe, expect, it } from "vitest";

import type { WorkspacePane } from "@/stores/types";

import { resolveWorkspaceLandingPane, resolveWorkspaceLandingPaneIndex } from "./workspace-switch";

function term(id: string, x: number, y: number, w = 0.5, h = 0.5): WorkspacePane {
  return { id, x, y, w, h, view: { type: "TerminalView" } };
}

function memo(id: string, x: number, y: number, w = 0.5, h = 0.5): WorkspacePane {
  return { id, x, y, w, h, view: { type: "MemoView" } };
}

describe("resolveWorkspaceLandingPaneIndex", () => {
  it("keeps the current position when it exists in the target workspace", () => {
    expect(
      resolveWorkspaceLandingPaneIndex({
        wasDockFocused: false,
        focusedPaneIndex: 2,
        paneCount: 4,
      }),
    ).toBe(2);
  });

  it("clamps an index that falls past the target workspace's last pane (#311)", () => {
    expect(
      resolveWorkspaceLandingPaneIndex({
        wasDockFocused: false,
        focusedPaneIndex: 5,
        paneCount: 3,
      }),
    ).toBe(2);
  });

  it("lands on the first pane when the dock held focus", () => {
    expect(
      resolveWorkspaceLandingPaneIndex({ wasDockFocused: true, focusedPaneIndex: 2, paneCount: 4 }),
    ).toBe(0);
  });

  it("lands on the first pane when nothing was focused", () => {
    expect(
      resolveWorkspaceLandingPaneIndex({
        wasDockFocused: false,
        focusedPaneIndex: null,
        paneCount: 4,
      }),
    ).toBe(0);
  });

  it("has nothing to focus in an empty workspace", () => {
    expect(
      resolveWorkspaceLandingPaneIndex({
        wasDockFocused: false,
        focusedPaneIndex: 1,
        paneCount: 0,
      }),
    ).toBeNull();
  });
});

describe("resolveWorkspaceLandingPane", () => {
  it("reports the landing pane's spatial number and terminal id", () => {
    // Reading order: b(top-left)=1, a(top-right)=2 — array order is reversed.
    const panes = [term("a", 0.5, 0), term("b", 0, 0)];

    expect(
      resolveWorkspaceLandingPane(panes, { wasDockFocused: false, focusedPaneIndex: 0 }),
    ).toEqual({
      paneIndex: 0,
      paneId: "a",
      paneNumber: 2,
      terminalId: "terminal-a",
    });
  });

  it("clamps a stale index instead of resolving an out-of-range pane (#578)", () => {
    const panes = [term("only", 0, 0, 1, 1)];

    expect(
      resolveWorkspaceLandingPane(panes, { wasDockFocused: false, focusedPaneIndex: 3 }),
    ).toEqual({
      paneIndex: 0,
      paneId: "only",
      paneNumber: 1,
      terminalId: "terminal-only",
    });
  });

  it("reports no terminal for a non-terminal landing pane", () => {
    const panes = [memo("note", 0, 0, 1, 1)];

    expect(
      resolveWorkspaceLandingPane(panes, { wasDockFocused: false, focusedPaneIndex: 0 }),
    ).toEqual({
      paneIndex: 0,
      paneId: "note",
      paneNumber: 1,
      terminalId: null,
    });
  });

  it("returns null for an empty workspace", () => {
    expect(
      resolveWorkspaceLandingPane([], { wasDockFocused: false, focusedPaneIndex: 0 }),
    ).toBeNull();
  });
});
