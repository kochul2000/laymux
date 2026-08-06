import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./tauri-api", () => ({
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
}));

import { writeToTerminal } from "./tauri-api";
import {
  CTRL_L,
  clearWorkspace,
  isNoOpClearResult,
  summarizeClearResult,
  terminalPaneIdsForWorkspace,
} from "./workspace-clear";
import { useTerminalStore } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

function seedWorkspace() {
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: "ws-1",
        name: "Clear",
        panes: [
          { id: "pane-a", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
          { id: "pane-b", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
          { id: "pane-m", x: 0, y: 1, w: 1, h: 0, view: { type: "MemoView" } },
        ],
      },
    ],
    activeWorkspaceId: "ws-1",
    workspaceDisplayOrder: [],
  });
}

describe("terminalPaneIdsForWorkspace", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
  });

  it("lists only TerminalView panes, in layout order", () => {
    seedWorkspace();
    expect(terminalPaneIdsForWorkspace("ws-1")).toEqual(["pane-a", "pane-b"]);
  });

  it("returns nothing for an unknown workspace", () => {
    expect(terminalPaneIdsForWorkspace("ws-missing")).toEqual([]);
  });
});

describe("clearWorkspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(writeToTerminal).mockResolvedValue(undefined);
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
  });

  function registerReady(paneId: string) {
    useTerminalStore.getState().registerInstance({
      id: `terminal-${paneId}`,
      profile: "PowerShell",
      syncGroup: "ws-1",
      workspaceId: "ws-1",
    });
    useTerminalStore.getState().updateInstanceInfo(`terminal-${paneId}`, { sessionReady: true });
  }

  it("broadcasts Ctrl+L to every ready terminal pane", async () => {
    seedWorkspace();
    registerReady("pane-a");
    registerReady("pane-b");

    const result = await clearWorkspace("ws-1");

    expect(vi.mocked(writeToTerminal).mock.calls).toEqual([
      ["terminal-pane-a", CTRL_L],
      ["terminal-pane-b", CTRL_L],
    ]);
    expect(result.cleared).toEqual(["terminal-pane-a", "terminal-pane-b"]);
  });

  it("still clears a busy pane — Ctrl+L is safe to send anytime", async () => {
    seedWorkspace();
    registerReady("pane-a");
    useTerminalStore.getState().updateInstanceInfo("terminal-pane-a", {
      activity: { type: "running" },
    });

    const result = await clearWorkspace("ws-1");

    expect(vi.mocked(writeToTerminal)).toHaveBeenCalledWith("terminal-pane-a", CTRL_L);
    expect(result.cleared).toEqual(["terminal-pane-a"]);
  });

  it("skips a pane with no PTY session yet", async () => {
    seedWorkspace();
    useTerminalStore.getState().registerInstance({
      id: "terminal-pane-a",
      profile: "PowerShell",
      syncGroup: "ws-1",
      workspaceId: "ws-1",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-pane-a", { sessionReady: false });
    registerReady("pane-b");

    const result = await clearWorkspace("ws-1");

    expect(vi.mocked(writeToTerminal)).toHaveBeenCalledExactlyOnceWith("terminal-pane-b", CTRL_L);
    expect(result.skipped).toEqual([{ terminalId: "terminal-pane-a", reason: "notReady" }]);
  });

  it("reports a pane with no registered terminal as not ready", async () => {
    seedWorkspace();
    registerReady("pane-a");
    // pane-b never registered.

    const result = await clearWorkspace("ws-1");

    expect(result.skipped).toEqual([{ terminalId: "terminal-pane-b", reason: "notReady" }]);
  });

  it("keeps clearing other panes when one write fails", async () => {
    seedWorkspace();
    registerReady("pane-a");
    registerReady("pane-b");
    vi.mocked(writeToTerminal).mockImplementation(async (id) => {
      if (id === "terminal-pane-a") throw new Error("terminal is gone");
    });

    const result = await clearWorkspace("ws-1");

    expect(result.cleared).toEqual(["terminal-pane-b"]);
    expect(result.failed).toEqual([{ terminalId: "terminal-pane-a", error: "terminal is gone" }]);
  });

  it("reports an unknown workspace as an empty run rather than throwing", async () => {
    const result = await clearWorkspace("ws-missing");
    expect(result.cleared).toEqual([]);
    expect(vi.mocked(writeToTerminal)).not.toHaveBeenCalled();
  });
});

describe("isNoOpClearResult / summarizeClearResult", () => {
  it("is a no-op only when nothing was cleared", () => {
    expect(isNoOpClearResult({ cleared: [], skipped: [], failed: [] })).toBe(true);
    expect(isNoOpClearResult({ cleared: ["a"], skipped: [], failed: [] })).toBe(false);
  });

  it("names the skip and failure counts", () => {
    expect(
      summarizeClearResult({
        cleared: ["a"],
        skipped: [{ terminalId: "b", reason: "notReady" }],
        failed: [{ terminalId: "c", error: "boom" }],
      }),
    ).toBe("cleared 1, skipped 1, failed 1");
  });

  it("stays short when everything worked", () => {
    expect(summarizeClearResult({ cleared: ["a", "b"], skipped: [], failed: [] })).toBe(
      "cleared 2",
    );
  });
});
