import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/tauri-api", () => ({
  writeTerminalInput: vi.fn().mockResolvedValue(undefined),
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
}));

import { writeTerminalInput, writeToTerminal } from "@/lib/tauri-api";
import { clearPane } from "./pane-clear";
import { useDockStore } from "@/stores/dock-store";
import { useTerminalRestartStore } from "@/stores/terminal-restart-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

const CTRL_C = "\x03";

function resetStores() {
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
  useDockStore.setState(useDockStore.getInitialState());
  useTerminalStore.setState(useTerminalStore.getInitialState());
  useTerminalRestartStore.setState({ requests: {} });
}

function registerTerminal(paneId: string, workspaceId = "ws-clear") {
  useTerminalStore.getState().registerInstance({
    id: `terminal-${paneId}`,
    profile: "PowerShell",
    syncGroup: workspaceId,
    workspaceId,
  });
  useTerminalStore.getState().updateInstanceInfo(`terminal-${paneId}`, { sessionReady: true });
}

function seedWorkspace() {
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: "ws-clear",
        name: "Clear",
        panes: [
          { id: "pane-a", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
          {
            id: "pane-b",
            x: 0.5,
            y: 0,
            w: 0.5,
            h: 1,
            view: { type: "TerminalView", lastCwd: "/saved/cwd" },
          },
          { id: "pane-m", x: 0, y: 1, w: 1, h: 0, view: { type: "MemoView" } },
        ],
      },
    ],
    activeWorkspaceId: "ws-clear",
    workspaceDisplayOrder: [],
  });
  registerTerminal("pane-a");
  registerTerminal("pane-b");
}

function seedDockTerminal(paneId: string) {
  useDockStore.setState({
    docks: [
      {
        position: "left",
        activeView: "TerminalView",
        views: ["TerminalView"],
        visible: true,
        size: 300,
        panes: [{ id: paneId, x: 0, y: 0, w: 1, h: 1, view: { type: "TerminalView" } }],
      },
    ],
  });
  registerTerminal(paneId, "dock");
}

function makeBusy(paneId: string) {
  useTerminalStore.getState().updateInstanceInfo(`terminal-${paneId}`, {
    activity: { type: "interactiveApp", name: "Claude" },
    title: "✻ Working",
  });
}

describe("clearPane against live stores", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(writeTerminalInput).mockResolvedValue(undefined);
    vi.mocked(writeToTerminal).mockResolvedValue(undefined);
    resetStores();
  });

  it("clears only the named grid pane through structured human input", async () => {
    seedWorkspace();
    const result = await clearPane("pane-b");
    expect(vi.mocked(writeTerminalInput).mock.calls).toEqual([["terminal-pane-b", "clear", true]]);
    expect(result.cleared).toEqual(["terminal-pane-b"]);
  });

  it.each(["Codex", "Grok"])("submits /clear to a %s pane", async (name) => {
    seedWorkspace();
    useTerminalStore.getState().updateInstanceInfo("terminal-pane-a", {
      activity: { type: "interactiveApp", name },
    });
    await clearPane("pane-a");
    expect(vi.mocked(writeTerminalInput)).toHaveBeenCalledWith("terminal-pane-a", "/clear", true);
  });

  it("clears a dock pane that workspace clear does not own", async () => {
    seedDockTerminal("dock-pane-1");
    const result = await clearPane("dock-pane-1");
    expect(vi.mocked(writeTerminalInput)).toHaveBeenCalledWith(
      "terminal-dock-pane-1",
      "clear",
      true,
    );
    expect(result.cleared).toEqual(["terminal-dock-pane-1"]);
  });

  it("sends Ctrl+C as raw bytes before submitting /clear", async () => {
    seedWorkspace();
    makeBusy("pane-a");
    await clearPane("pane-a", { busyPolicy: "interrupt", interruptRounds: 2, settleMs: 0 });
    expect(vi.mocked(writeToTerminal).mock.calls).toEqual([
      ["terminal-pane-a", CTRL_C],
      ["terminal-pane-a", CTRL_C],
    ]);
    expect(vi.mocked(writeTerminalInput)).toHaveBeenCalledWith("terminal-pane-a", "/clear", true);
  });

  it("restarts a busy dock pane with its live cwd", async () => {
    seedDockTerminal("dock-pane-1");
    makeBusy("dock-pane-1");
    useTerminalStore
      .getState()
      .updateInstanceInfo("terminal-dock-pane-1", { cwd: "/dock/live/cwd" });
    const result = await clearPane("dock-pane-1", { busyPolicy: "restart" });
    expect(useTerminalRestartStore.getState().requests["dock-pane-1"]).toEqual({
      epoch: 1,
      cwd: "/dock/live/cwd",
      fresh: true,
    });
    expect(result.restarted).toEqual(["terminal-dock-pane-1"]);
    expect(vi.mocked(writeTerminalInput)).not.toHaveBeenCalled();
  });

  it("uses the saved cwd when a busy grid pane has no live cwd", async () => {
    seedWorkspace();
    makeBusy("pane-b");
    await clearPane("pane-b", { busyPolicy: "restart" });
    expect(useTerminalRestartStore.getState().requests["pane-b"].cwd).toBe("/saved/cwd");
  });

  it("rejects non-terminal and unknown panes", async () => {
    seedWorkspace();
    await expect(clearPane("pane-m")).rejects.toThrow("not a terminal pane");
    await expect(clearPane("pane-nope")).rejects.toThrow("not a terminal pane");
    expect(vi.mocked(writeTerminalInput)).not.toHaveBeenCalled();
  });
});
