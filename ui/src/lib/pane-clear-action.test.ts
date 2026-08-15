import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./tauri-api", () => ({
  writeTerminalInput: vi.fn().mockResolvedValue(undefined),
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
}));

import { writeTerminalInput } from "./tauri-api";
import { runPaneClearFromUi } from "./pane-clear-action";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

function seedTerminal() {
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

describe("runPaneClearFromUi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(writeTerminalInput).mockResolvedValue(undefined);
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
  });

  it("uses the configured shell command for the named pane", async () => {
    seedTerminal();
    useSettingsStore.getState().setPaneClear({ shellCommand: "cls" });

    const result = await runPaneClearFromUi("pane-a");

    expect(result?.cleared).toEqual(["terminal-pane-a"]);
    expect(vi.mocked(writeTerminalInput)).toHaveBeenCalledExactlyOnceWith(
      "terminal-pane-a",
      "cls",
      true,
    );
  });

  it("reports a policy-driven no-op so the shortcut is not silently broken", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedTerminal();
    useTerminalStore.getState().updateInstanceInfo("terminal-pane-a", {
      activity: { type: "running" },
    });

    const result = await runPaneClearFromUi("pane-a");

    expect(result?.skipped).toEqual([{ terminalId: "terminal-pane-a", reason: "busy" }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("nothing cleared"));
    warn.mockRestore();
  });

  it("returns null and logs an invalid pane instead of rejecting fire-and-forget callers", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(runPaneClearFromUi("missing")).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("[pane clear] missing failed:"),
      expect.any(Error),
    );
    warn.mockRestore();
  });
});
