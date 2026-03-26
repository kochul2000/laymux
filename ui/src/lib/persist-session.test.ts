import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/tauri-api", () => ({
  saveSettings: vi.fn().mockResolvedValue(undefined),
  loadSettings: vi.fn().mockResolvedValue({}),
  createTerminalSession: vi.fn().mockResolvedValue({}),
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminalSession: vi.fn().mockResolvedValue(undefined),
  getSyncGroupTerminals: vi.fn().mockResolvedValue([]),
  handleLxMessage: vi.fn().mockResolvedValue({}),
  onTerminalOutput: vi.fn().mockResolvedValue(() => {}),
  onSyncCwd: vi.fn().mockResolvedValue(() => {}),
  onSyncBranch: vi.fn().mockResolvedValue(() => {}),
  onLxNotify: vi.fn().mockResolvedValue(() => {}),
  onSetTabTitle: vi.fn().mockResolvedValue(() => {}),
  getListeningPorts: vi.fn().mockResolvedValue([]),
  getGitBranch: vi.fn().mockResolvedValue(null),
  sendOsNotification: vi.fn().mockResolvedValue(undefined),
}));

import { persistSession } from "./persist-session";
import { saveSettings } from "@/lib/tauri-api";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useDockStore } from "@/stores/dock-store";

describe("persistSession", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
    vi.clearAllMocks();
  });

  it("calls saveSettings with current state from all stores", async () => {
    await persistSession();

    expect(saveSettings).toHaveBeenCalledTimes(1);
    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedArg).toHaveProperty("font");
    expect(savedArg).toHaveProperty("layouts");
    expect(savedArg).toHaveProperty("workspaces");
    expect(savedArg).toHaveProperty("docks");
  });

  it("includes dock state in saved settings", async () => {
    useDockStore.getState().setDockActiveView("left", "SettingsView");

    await persistSession();

    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedArg.docks).toHaveLength(4);
    const leftDock = savedArg.docks.find((d: { position: string }) => d.position === "left");
    expect(leftDock.activeView).toBe("SettingsView");
    expect(leftDock.visible).toBe(true);
  });

  it("includes workspace and layout data", async () => {
    useWorkspaceStore.getState().addWorkspace("TestWS", "default-layout");

    await persistSession();

    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedArg.workspaces).toHaveLength(2);
    expect(savedArg.layouts).toHaveLength(1);
  });

  it("includes settings store data", async () => {
    useSettingsStore.getState().setFont({ face: "Fira Code", size: 18, weight: "normal" });

    await persistSession();

    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedArg.font.face).toBe("Fira Code");
    expect(savedArg.font.size).toBe(18);
  });

  it("preserves startupCommand in profiles", async () => {
    useSettingsStore.getState().updateProfile(0, { startupCommand: "/home/user/init.sh" });

    await persistSession();

    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedArg.profiles[0].startupCommand).toBe("/home/user/init.sh");
  });

  it("preserves dock panes with view config through save", async () => {
    // Set up a dock pane with a profile (TerminalView with WSL)
    useDockStore.getState().setDockPaneView("left", useDockStore.getState().getDock("left")!.panes[0].id, {
      type: "TerminalView",
      profile: "WSL",
    });

    await persistSession();

    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const leftDock = savedArg.docks.find((d: { position: string }) => d.position === "left");
    expect(leftDock).toBeDefined();
    expect(leftDock.panes).toBeDefined();
    expect(leftDock.panes.length).toBeGreaterThan(0);
    expect(leftDock.panes[0].view.type).toBe("TerminalView");
    expect(leftDock.panes[0].view.profile).toBe("WSL");
    expect(leftDock.panes[0].x).toBe(0);
    expect(leftDock.panes[0].y).toBe(0);
    expect(leftDock.panes[0].w).toBe(1);
    expect(leftDock.panes[0].h).toBe(1);
  });
});
