import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./tauri-api", () => ({
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
}));

import { writeToTerminal } from "./tauri-api";
import { runWorkspaceClearFromUi } from "./workspace-clear-action";
import { useTerminalStore } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

function seedWorkspace() {
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: "ws-clear",
        name: "Clear",
        panes: [{ id: "pane-a", x: 0, y: 0, w: 1, h: 1, view: { type: "TerminalView" } }],
      },
    ],
    activeWorkspaceId: "ws-clear",
    workspaceDisplayOrder: [],
  });
  useTerminalStore.getState().registerInstance({
    id: "terminal-pane-a",
    profile: "PowerShell",
    syncGroup: "ws-clear",
    workspaceId: "ws-clear",
  });
  useTerminalStore.getState().updateInstanceInfo("terminal-pane-a", { sessionReady: true });
}

describe("runWorkspaceClearFromUi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(writeToTerminal).mockResolvedValue(undefined);
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
  });

  it("stays quiet on a clean run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedWorkspace();

    const result = await runWorkspaceClearFromUi("ws-clear");

    expect(result?.cleared).toEqual(["terminal-pane-a"]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // A silent no-op is indistinguishable from a broken shortcut.
  it("warns when the run touched nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    useWorkspaceStore.setState({
      workspaces: [{ id: "ws-empty", name: "Empty", panes: [] }],
      activeWorkspaceId: "ws-empty",
      workspaceDisplayOrder: [],
    });

    const result = await runWorkspaceClearFromUi("ws-empty");

    expect(result?.cleared).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("nothing cleared"));
    warn.mockRestore();
  });

  it("names each rejected terminal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedWorkspace();
    vi.mocked(writeToTerminal).mockRejectedValue(new Error("controlled by a remote client"));

    const result = await runWorkspaceClearFromUi("ws-clear");

    expect(result?.failed.map((entry) => entry.terminalId)).toEqual(["terminal-pane-a"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("terminal-pane-a: controlled by a remote client"),
    );
    warn.mockRestore();
  });
});
