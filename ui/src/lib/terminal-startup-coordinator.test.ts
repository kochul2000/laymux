import { describe, expect, it } from "vitest";
import {
  collectTerminalStartupCandidates,
  createTerminalStartupState,
  settleTerminalStartup,
  syncTerminalStartupCandidates,
} from "./terminal-startup-coordinator";

const members = (value: ReadonlySet<string>) => [...value].sort();

describe("terminal startup coordinator", () => {
  it("grants exactly one global startup slot and advances only after settlement", () => {
    const first = syncTerminalStartupCandidates(createTerminalStartupState(), {
      knownPaneIds: ["p1", "p2", "p3"],
      eligiblePaneIds: ["p2", "p1", "p3"],
    });

    expect(first.activePaneId).toBe("p2");
    expect(members(first.revealedPaneIds)).toEqual(["p2"]);

    const whileBusy = syncTerminalStartupCandidates(first, {
      knownPaneIds: ["p1", "p2", "p3", "dock-1"],
      eligiblePaneIds: ["dock-1", "p2", "p1", "p3"],
    });
    expect(whileBusy.activePaneId).toBe("p2");
    expect(members(whileBusy.revealedPaneIds)).toEqual(["p2"]);

    const second = settleTerminalStartup(whileBusy, "p2");
    expect(second.activePaneId).toBe("dock-1");
    expect(members(second.revealedPaneIds)).toEqual(["dock-1", "p2"]);
  });

  it("does not grant inactive candidates until they become eligible", () => {
    const paused = syncTerminalStartupCandidates(createTerminalStartupState(), {
      knownPaneIds: ["background-1", "background-2"],
      eligiblePaneIds: [],
    });
    expect(paused.activePaneId).toBeNull();
    expect(members(paused.revealedPaneIds)).toEqual([]);

    const resumed = syncTerminalStartupCandidates(paused, {
      knownPaneIds: ["background-1", "background-2"],
      eligiblePaneIds: ["background-2", "background-1"],
    });
    expect(resumed.activePaneId).toBe("background-2");
  });

  it("prunes a removed active pane and immediately grants the next candidate", () => {
    const first = syncTerminalStartupCandidates(createTerminalStartupState(), {
      knownPaneIds: ["gone", "next"],
      eligiblePaneIds: ["gone", "next"],
    });
    expect(first.activePaneId).toBe("gone");

    const pruned = syncTerminalStartupCandidates(first, {
      knownPaneIds: ["next"],
      eligiblePaneIds: ["next"],
    });
    expect(pruned.activePaneId).toBe("next");
    expect(members(pruned.revealedPaneIds)).toEqual(["next"]);
  });

  it("adopts already-ready terminals without consuming the startup slot", () => {
    const state = syncTerminalStartupCandidates(createTerminalStartupState(), {
      knownPaneIds: ["ready-1", "ready-2", "pending"],
      eligiblePaneIds: ["ready-1", "ready-2", "pending"],
      readyPaneIds: ["ready-1", "ready-2"],
    });

    expect(state.activePaneId).toBe("pending");
    expect(members(state.revealedPaneIds)).toEqual(["pending", "ready-1", "ready-2"]);
  });
});

describe("collectTerminalStartupCandidates", () => {
  it("orders Automation then focus, spans workspace+docks, and pauses hidden surfaces", () => {
    const result = collectTerminalStartupCandidates({
      workspaces: [
        {
          id: "active",
          panes: [
            { id: "ws-1", view: { type: "TerminalView" } },
            { id: "memo", view: { type: "MemoView" } },
            { id: "ws-2", view: { type: "TerminalView" } },
          ],
        },
        {
          id: "inactive",
          panes: [{ id: "ws-bg", view: { type: "TerminalView" } }],
        },
      ],
      activeWorkspaceId: "active",
      focusedPaneIndex: 2,
      docks: [
        {
          position: "left",
          visible: true,
          panes: [{ id: "dock-live", view: { type: "TerminalView" } }],
        },
        {
          position: "bottom",
          visible: false,
          panes: [{ id: "dock-hidden", view: { type: "TerminalView" } }],
        },
      ],
      focusedDock: null,
      focusedDockPaneId: null,
      persistHiddenDocks: true,
      evictedPaneIds: new Set(),
      requestedPaneIds: ["dock-live"],
      foregroundTerminalIds: ["file-viewer"],
    });

    expect(result.knownPaneIds).toEqual([
      "ws-1",
      "ws-2",
      "ws-bg",
      "dock-live",
      "dock-hidden",
      "file-viewer",
    ]);
    expect(result.eligiblePaneIds).toEqual(["dock-live", "file-viewer", "ws-2", "ws-1"]);
  });

  it("drops evicted background panes and hidden non-persistent docks", () => {
    const result = collectTerminalStartupCandidates({
      workspaces: [
        {
          id: "active",
          panes: [{ id: "active-pane", view: { type: "TerminalView" } }],
        },
        {
          id: "inactive",
          panes: [{ id: "evicted", view: { type: "TerminalView" } }],
        },
      ],
      activeWorkspaceId: "active",
      focusedPaneIndex: 0,
      docks: [
        {
          position: "right",
          visible: false,
          panes: [{ id: "hidden-dock", view: { type: "TerminalView" } }],
        },
      ],
      focusedDock: null,
      focusedDockPaneId: null,
      persistHiddenDocks: false,
      evictedPaneIds: new Set(["evicted"]),
      requestedPaneIds: [],
    });

    expect(result.knownPaneIds).toEqual(["active-pane"]);
    expect(result.eligiblePaneIds).toEqual(["active-pane"]);
  });
});
