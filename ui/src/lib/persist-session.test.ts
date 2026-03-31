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
  saveTerminalOutputCache: vi.fn().mockResolvedValue(undefined),
  cleanTerminalOutputCache: vi.fn().mockResolvedValue(0),
}));

vi.mock("@/lib/terminal-serialize-registry", () => ({
  getTerminalSerializeMap: vi.fn().mockReturnValue(new Map()),
  registerTerminalSerializer: vi.fn(),
  unregisterTerminalSerializer: vi.fn(),
}));

import { persistSession, saveBeforeClose } from "./persist-session";
import { saveSettings, saveTerminalOutputCache, cleanTerminalOutputCache } from "@/lib/tauri-api";
import { getTerminalSerializeMap } from "@/lib/terminal-serialize-registry";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useDockStore } from "@/stores/dock-store";
import { useTerminalStore } from "@/stores/terminal-store";

describe("persistSession", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
    useTerminalStore.setState({ instances: [] });
    vi.clearAllMocks();
  });

  it("calls saveSettings with current state from all stores", async () => {
    await persistSession();

    expect(saveSettings).toHaveBeenCalledTimes(1);
    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedArg).toHaveProperty("layouts");
    expect(savedArg).toHaveProperty("workspaces");
    expect(savedArg).toHaveProperty("docks");
    expect(savedArg).toHaveProperty("profiles");
    // font is now at profile level or profileDefaults, not root
    expect(savedArg).toHaveProperty("profileDefaults");
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

  it("includes profileDefaults font in saved settings", async () => {
    useSettingsStore
      .getState()
      .setProfileDefaults({ font: { face: "Fira Code", size: 18, weight: "normal" } });

    await persistSession();

    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedArg.profileDefaults.font.face).toBe("Fira Code");
    expect(savedArg.profileDefaults.font.size).toBe(18);
  });

  it("includes per-profile font override in saved settings", async () => {
    useSettingsStore
      .getState()
      .updateProfile(0, { font: { face: "JetBrains Mono", size: 16, weight: "bold" } });

    await persistSession();

    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedArg.profiles[0].font.face).toBe("JetBrains Mono");
    expect(savedArg.profiles[0].font.size).toBe(16);
  });

  it("does not include font in profile when no override set", async () => {
    await persistSession();

    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedArg.profiles[0].font).toBeUndefined();
  });

  it("preserves startupCommand in profiles", async () => {
    useSettingsStore.getState().updateProfile(0, { startupCommand: "/home/user/init.sh" });

    await persistSession();

    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedArg.profiles[0].startupCommand).toBe("/home/user/init.sh");
  });

  it("MemoView pane does not store content in settings", async () => {
    // MemoView content is stored in memo.json, not in settings.json
    useWorkspaceStore.getState().setPaneView(0, {
      type: "MemoView",
    });

    await persistSession();

    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const pane = savedArg.workspaces[0].panes[0];
    expect(pane.view.type).toBe("MemoView");
    expect(pane.view.content).toBeUndefined();
  });

  // -- Save → Load round-trip tests --

  describe("round-trip: save → loadFromSettings preserves state", () => {
    it("profile fields including font survive round-trip", async () => {
      useSettingsStore.getState().updateProfile(0, {
        font: { face: "JetBrains Mono", size: 18, weight: "bold" },
        startupCommand: "echo hi",
        colorScheme: "One Half Dark",
        startingDirectory: "~/projects",
        hidden: true,
        cursorShape: "filledBox",
        padding: { top: 4, right: 4, bottom: 4, left: 4 },
        scrollbackLines: 5000,
        opacity: 80,
        tabTitle: "Dev",
        bellStyle: "none",
        closeOnExit: "always",
        antialiasingMode: "cleartype",
        suppressApplicationTitle: true,
        snapOnInput: false,
      });

      await persistSession();

      const saved = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];

      // Reset store and reload from saved payload
      useSettingsStore.setState(useSettingsStore.getInitialState());
      useSettingsStore.getState().loadFromSettings(saved);

      const profile = useSettingsStore.getState().profiles[0];
      expect(profile.font).toBeDefined();
      expect(profile.font!.face).toBe("JetBrains Mono");
      expect(profile.font!.size).toBe(18);
      expect(profile.font!.weight).toBe("bold");
      expect(profile.startupCommand).toBe("echo hi");
      expect(profile.colorScheme).toBe("One Half Dark");
      expect(profile.startingDirectory).toBe("~/projects");
      expect(profile.hidden).toBe(true);
      expect(profile.cursorShape).toBe("filledBox");
      expect(profile.padding).toEqual({ top: 4, right: 4, bottom: 4, left: 4 });
      expect(profile.scrollbackLines).toBe(5000);
      expect(profile.opacity).toBe(80);
      expect(profile.tabTitle).toBe("Dev");
      expect(profile.bellStyle).toBe("none");
      expect(profile.closeOnExit).toBe("always");
      expect(profile.antialiasingMode).toBe("cleartype");
      expect(profile.suppressApplicationTitle).toBe(true);
      expect(profile.snapOnInput).toBe(false);
    });

    it("profileDefaults font survives round-trip", async () => {
      useSettingsStore.getState().setProfileDefaults({
        font: { face: "Fira Code", size: 20, weight: "semi-bold" },
      });

      await persistSession();

      const saved = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
      useSettingsStore.setState(useSettingsStore.getInitialState());
      useSettingsStore.getState().loadFromSettings(saved);

      const { font } = useSettingsStore.getState().profileDefaults;
      expect(font.face).toBe("Fira Code");
      expect(font.size).toBe(20);
      expect(font.weight).toBe("semi-bold");
    });

    it("convenience settings survive round-trip", async () => {
      useSettingsStore.getState().setConvenience({
        smartPaste: false,
        pasteImageDir: "/tmp/img",
        hoverIdleSeconds: 5,
        notificationDismiss: "manual",
        copyOnSelect: false,
        pathEllipsis: "end",
        scrollbarStyle: "separate",
      });

      await persistSession();

      const saved = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
      useSettingsStore.setState(useSettingsStore.getInitialState());
      useSettingsStore.getState().loadFromSettings(saved);

      const { convenience } = useSettingsStore.getState();
      expect(convenience.smartPaste).toBe(false);
      expect(convenience.pasteImageDir).toBe("/tmp/img");
      expect(convenience.hoverIdleSeconds).toBe(5);
      expect(convenience.notificationDismiss).toBe("manual");
      expect(convenience.copyOnSelect).toBe(false);
      expect(convenience.pathEllipsis).toBe("end");
      expect(convenience.scrollbarStyle).toBe("separate");
    });

    it("claude settings survive round-trip", async () => {
      useSettingsStore.getState().setClaude({ syncCwd: "command" });

      await persistSession();

      const saved = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
      useSettingsStore.setState(useSettingsStore.getInitialState());
      useSettingsStore.getState().loadFromSettings(saved);

      expect(useSettingsStore.getState().claude.syncCwd).toBe("command");
    });
  });

  it("preserves dock panes with view config through save", async () => {
    // Set up a dock pane with a profile (TerminalView with WSL)
    useDockStore
      .getState()
      .setDockPaneView("left", useDockStore.getState().getDock("left")!.panes[0].id, {
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

  // -- restoreCwd / restoreOutput profile field tests --

  it("preserves restoreCwd and restoreOutput in profiles", async () => {
    useSettingsStore.getState().updateProfile(0, {
      restoreCwd: false,
      restoreOutput: false,
    });

    await persistSession();

    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedArg.profiles[0].restoreCwd).toBe(false);
    expect(savedArg.profiles[0].restoreOutput).toBe(false);
  });

  it("includes default restoreCwd/restoreOutput values (true) from profile defaults", async () => {
    // makeProfile spreads defaultProfileDefaults, so restoreCwd/restoreOutput
    // are true by default (not undefined).
    await persistSession();

    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedArg.profiles[0].restoreCwd).toBe(true);
    expect(savedArg.profiles[0].restoreOutput).toBe(true);
  });

  it("preserves restoreCwd/restoreOutput in profileDefaults", async () => {
    useSettingsStore.getState().setProfileDefaults({
      restoreCwd: false,
      restoreOutput: false,
    });

    await persistSession();

    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedArg.profileDefaults.restoreCwd).toBe(false);
    expect(savedArg.profileDefaults.restoreOutput).toBe(false);
  });

  it("restoreCwd/restoreOutput profile fields survive round-trip", async () => {
    useSettingsStore.getState().updateProfile(0, {
      restoreCwd: false,
      restoreOutput: true,
    });

    await persistSession();

    const saved = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useSettingsStore.getState().loadFromSettings(saved);

    const profile = useSettingsStore.getState().profiles[0];
    expect(profile.restoreCwd).toBe(false);
    expect(profile.restoreOutput).toBe(true);
  });

  // -- lastCwd injection tests --

  it("injects lastCwd into workspace TerminalView panes from terminal store", async () => {
    const wsState = useWorkspaceStore.getState();
    const paneId = wsState.workspaces[0].panes[0].id;
    wsState.setPaneView(0, { type: "TerminalView", profile: "WSL" });

    // Register a terminal instance with CWD
    useTerminalStore.getState().registerInstance({
      id: `terminal-${paneId}`,
      profile: "WSL",
      syncGroup: "default",
      workspaceId: wsState.workspaces[0].id,
    });
    useTerminalStore.getState().updateInstanceInfo(`terminal-${paneId}`, {
      cwd: "/home/user/project",
    });

    await persistSession();

    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedArg.workspaces[0].panes[0].view.lastCwd).toBe("/home/user/project");
  });

  it("injects lastCwd into dock TerminalView panes from terminal store", async () => {
    const dockState = useDockStore.getState();
    const dockPaneId = dockState.getDock("left")!.panes[0].id;
    dockState.setDockPaneView("left", dockPaneId, {
      type: "TerminalView",
      profile: "WSL",
    });

    useTerminalStore.getState().registerInstance({
      id: `terminal-${dockPaneId}`,
      profile: "WSL",
      syncGroup: "default",
      workspaceId: "",
    });
    useTerminalStore.getState().updateInstanceInfo(`terminal-${dockPaneId}`, {
      cwd: "/tmp/dock-cwd",
    });

    await persistSession();

    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const leftDock = savedArg.docks.find((d: { position: string }) => d.position === "left");
    expect(leftDock.panes[0].view.lastCwd).toBe("/tmp/dock-cwd");
  });

  it("does not inject lastCwd for non-TerminalView panes", async () => {
    useWorkspaceStore.getState().setPaneView(0, { type: "MemoView" });

    await persistSession();

    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedArg.workspaces[0].panes[0].view.lastCwd).toBeUndefined();
  });

  it("includes stable pane id in saved workspace panes", async () => {
    await persistSession();

    const savedArg = (saveSettings as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(savedArg.workspaces[0].panes[0].id).toBeDefined();
    expect(savedArg.workspaces[0].panes[0].id).not.toBe("");
  });
});

// -- saveBeforeClose tests --

describe("saveBeforeClose", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
    useTerminalStore.setState({ instances: [] });
    vi.clearAllMocks();
  });

  it("serializes terminal outputs and saves to cache", async () => {
    const mockSerialize = vi.fn().mockReturnValue("serialized-output");
    const mockMap = new Map([["pane-abc", mockSerialize]]);
    vi.mocked(getTerminalSerializeMap).mockReturnValue(mockMap);

    await saveBeforeClose();

    expect(mockSerialize).toHaveBeenCalledTimes(1);
    expect(saveTerminalOutputCache).toHaveBeenCalledWith("pane-abc", "serialized-output");
  });

  it("skips empty serializations", async () => {
    const mockMap = new Map([["pane-abc", () => ""]]);
    vi.mocked(getTerminalSerializeMap).mockReturnValue(mockMap);

    await saveBeforeClose();

    expect(saveTerminalOutputCache).not.toHaveBeenCalled();
  });

  it("calls persistSession (saveSettings) during close", async () => {
    vi.mocked(getTerminalSerializeMap).mockReturnValue(new Map());

    await saveBeforeClose();

    expect(saveSettings).toHaveBeenCalledTimes(1);
  });

  it("cleans orphaned cache files after save completes", async () => {
    vi.mocked(getTerminalSerializeMap).mockReturnValue(new Map());

    await saveBeforeClose();

    expect(cleanTerminalOutputCache).toHaveBeenCalledTimes(1);
  });

  it("awaits saves before cleaning orphans (ordering)", async () => {
    const callOrder: string[] = [];
    vi.mocked(saveSettings).mockImplementation(async () => {
      callOrder.push("saveSettings");
    });
    vi.mocked(cleanTerminalOutputCache).mockImplementation(async () => {
      callOrder.push("cleanCache");
      return 0;
    });
    vi.mocked(getTerminalSerializeMap).mockReturnValue(new Map());

    await saveBeforeClose();

    const saveIdx = callOrder.indexOf("saveSettings");
    const cleanIdx = callOrder.indexOf("cleanCache");
    expect(saveIdx).toBeLessThan(cleanIdx);
  });

  it("handles serialization errors gracefully", async () => {
    const mockMap = new Map<string, () => string>([
      [
        "pane-err",
        () => {
          throw new Error("serialize failed");
        },
      ],
      ["pane-ok", () => "good-data"],
    ]);
    vi.mocked(getTerminalSerializeMap).mockReturnValue(mockMap);

    await saveBeforeClose();

    expect(saveTerminalOutputCache).toHaveBeenCalledWith("pane-ok", "good-data");
    expect(saveTerminalOutputCache).toHaveBeenCalledTimes(1);
  });
});
