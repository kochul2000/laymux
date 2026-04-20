import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
  setBlockPersist: vi.fn(),
}));

vi.mock("@/lib/tauri-api", () => {
  const mockSettings = {
    font: { face: "Fira Code", size: 16 },
    defaultProfile: "WSL",
    profiles: [
      {
        name: "WSL",
        commandLine: "wsl.exe",
        colorScheme: "",
        startingDirectory: "",
        hidden: false,
      },
    ],
    colorSchemes: [],
    keybindings: [],
    layouts: [
      {
        id: "layout-1",
        name: "Saved Layout",
        panes: [
          { x: 0, y: 0, w: 1, h: 0.5, viewType: "TerminalView" },
          { x: 0, y: 0.5, w: 1, h: 0.5, viewType: "TerminalView" },
        ],
      },
    ],
    workspaces: [
      {
        id: "ws-1",
        name: "Saved WS",
        panes: [
          {
            x: 0,
            y: 0,
            w: 1,
            h: 0.5,
            view: { type: "TerminalView", profile: "WSL", syncGroup: "Saved WS" },
          },
          {
            x: 0,
            y: 0.5,
            w: 1,
            h: 0.5,
            view: { type: "TerminalView", profile: "WSL", syncGroup: "Saved WS" },
          },
        ],
      },
    ],
    docks: [
      {
        position: "left",
        activeView: "SettingsView",
        views: ["WorkspaceSelectorView", "SettingsView"],
        visible: false,
      },
      { position: "right", activeView: null, views: [], visible: true },
    ],
  };
  return {
    loadSettings: vi.fn().mockResolvedValue(mockSettings),
    loadSettingsValidated: vi
      .fn()
      .mockResolvedValue({ status: "ok", settings: mockSettings, warnings: [] }),
    cleanTerminalOutputCache: vi.fn().mockResolvedValue(undefined),
    saveSettings: vi.fn().mockResolvedValue(undefined),
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
  };
});

import { useSessionPersistence } from "./useSessionPersistence";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useDockStore } from "@/stores/dock-store";
import { useOverridesStore } from "@/stores/overrides-store";
import { loadSettingsValidated, type SettingsLoadResult } from "@/lib/tauri-api";
import { persistSession } from "@/lib/persist-session";

/** Wrap raw settings into a SettingsLoadResult with status "ok" for test mocks. */
function wrapOk(settings: any): SettingsLoadResult {
  return { status: "ok", settings, warnings: [] };
}

describe("useSessionPersistence", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
    useOverridesStore.setState({ paneOverrides: {}, viewOverrides: {} });
    localStorage.clear();
    vi.clearAllMocks();
  });

  it("loads settings from backend on mount", async () => {
    const { result } = renderHook(() => useSessionPersistence());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(loadSettingsValidated).toHaveBeenCalledTimes(1);
    expect(result.current.loaded).toBe(true);
  });

  it("applies loaded settings to settings store", async () => {
    renderHook(() => useSessionPersistence());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const settingsState = useSettingsStore.getState();
    // Legacy root-level font is migrated to profileDefaults.font
    expect(settingsState.profileDefaults.font.face).toBe("Fira Code");
    expect(settingsState.profileDefaults.font.size).toBe(16);
    expect(settingsState.defaultProfile).toBe("WSL");
  });

  it("applies loaded layouts and workspaces to workspace store", async () => {
    renderHook(() => useSessionPersistence());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const wsState = useWorkspaceStore.getState();
    expect(wsState.layouts).toHaveLength(1);
    expect(wsState.layouts[0].name).toBe("Saved Layout");
    expect(wsState.workspaces).toHaveLength(1);
    expect(wsState.workspaces[0].name).toBe("Saved WS");
  });

  it("provides a save function that persists to backend", async () => {
    const { result } = renderHook(() => useSessionPersistence());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    await act(async () => {
      await result.current.save();
    });

    expect(persistSession).toHaveBeenCalledTimes(1);
  });

  it("loads dock state from settings", async () => {
    renderHook(() => useSessionPersistence());

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const leftDock = useDockStore.getState().getDock("left");
    expect(leftDock?.activeView).toBe("SettingsView");
    expect(leftDock?.visible).toBe(false);
  });

  it("leaves cwdReceive/cwdSend undefined when not set in dock panes (resolved at render time via syncCwdDefaults)", async () => {
    // Override loadSettings to return dock panes without cwdReceive/cwdSend
    vi.mocked(loadSettingsValidated).mockResolvedValueOnce(
      wrapOk({
        defaultProfile: "WSL",
        profiles: [
          {
            name: "WSL",
            commandLine: "wsl.exe",
            colorScheme: "",
            startingDirectory: "",
            hidden: false,
          },
        ],
        colorSchemes: [],
        keybindings: [],
        layouts: [],
        workspaces: [],
        docks: [
          {
            position: "bottom",
            activeView: "TerminalView",
            views: ["TerminalView"],
            visible: true,
            size: 200,
            panes: [
              {
                id: "dp-test1",
                view: { type: "TerminalView", profile: "WSL" }, // no cwdReceive/cwdSend
                x: 0,
                y: 0,
                w: 1,
                h: 1,
              },
            ],
          },
        ],
        convenience: {
          smartPaste: true,
          pasteImageDir: "",
          hoverIdleSeconds: 2,
          notificationDismiss: "workspace",
          copyOnSelect: true,
          pathEllipsis: "start",
          scrollbarStyle: "overlay",
        },
        claude: { syncCwd: "skip" },
      }) as any,
    );

    renderHook(() => useSessionPersistence());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const bottomDock = useDockStore.getState().getDock("bottom");
    const pane = bottomDock?.panes[0];
    // cwdReceive/cwdSend are no longer force-normalized at load time;
    // they remain undefined so ViewRenderer resolves defaults from syncCwdDefaults settings
    expect(pane?.view.cwdReceive).toBeUndefined();
    expect(pane?.view.cwdSend).toBeUndefined();
  });

  it("preserves explicit cwdReceive=false from saved dock panes", async () => {
    vi.mocked(loadSettingsValidated).mockResolvedValueOnce(
      wrapOk({
        defaultProfile: "WSL",
        profiles: [
          {
            name: "WSL",
            commandLine: "wsl.exe",
            colorScheme: "",
            startingDirectory: "",
            hidden: false,
          },
        ],
        colorSchemes: [],
        keybindings: [],
        layouts: [],
        workspaces: [],
        docks: [
          {
            position: "bottom",
            activeView: "TerminalView",
            views: ["TerminalView"],
            visible: true,
            size: 200,
            panes: [
              {
                id: "dp-test1",
                view: { type: "TerminalView", profile: "WSL", cwdReceive: false, cwdSend: false },
                x: 0,
                y: 0,
                w: 1,
                h: 1,
              },
            ],
          },
        ],
        convenience: {
          smartPaste: true,
          pasteImageDir: "",
          hoverIdleSeconds: 2,
          notificationDismiss: "workspace",
          copyOnSelect: true,
          pathEllipsis: "start",
          scrollbarStyle: "overlay",
        },
        claude: { syncCwd: "skip" },
      }) as any,
    );

    renderHook(() => useSessionPersistence());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const bottomDock = useDockStore.getState().getDock("bottom");
    const pane = bottomDock?.panes[0];
    expect(pane?.view.cwdReceive).toBe(false);
    expect(pane?.view.cwdSend).toBe(false);
  });

  it("loads per-profile font override from backend settings", async () => {
    vi.mocked(loadSettingsValidated).mockResolvedValueOnce(
      wrapOk({
        defaultProfile: "WSL",
        profiles: [
          {
            name: "WSL",
            commandLine: "wsl.exe",
            colorScheme: "",
            startingDirectory: "",
            hidden: false,
            font: { face: "JetBrains Mono", size: 16, weight: "bold" },
          },
        ],
        colorSchemes: [],
        keybindings: [],
        layouts: [],
        workspaces: [],
        docks: [],
        convenience: {
          smartPaste: true,
          pasteImageDir: "",
          hoverIdleSeconds: 2,
          notificationDismiss: "workspace",
          copyOnSelect: true,
          pathEllipsis: "start",
          scrollbarStyle: "overlay",
        },
        claude: { syncCwd: "skip" },
      }) as any,
    );

    renderHook(() => useSessionPersistence());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const profile = useSettingsStore.getState().profiles[0];
    expect(profile.font).toBeDefined();
    expect(profile.font!.face).toBe("JetBrains Mono");
    expect(profile.font!.size).toBe(16);
    expect(profile.font!.weight).toBe("bold");
  });

  it("loads profile without font override — font stays undefined", async () => {
    renderHook(() => useSessionPersistence());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const profile = useSettingsStore.getState().profiles[0];
    expect(profile.font).toBeUndefined();
  });

  it("loads convenience settings from backend", async () => {
    vi.mocked(loadSettingsValidated).mockResolvedValueOnce(
      wrapOk({
        defaultProfile: "WSL",
        profiles: [
          {
            name: "WSL",
            commandLine: "wsl.exe",
            colorScheme: "",
            startingDirectory: "",
            hidden: false,
          },
        ],
        colorSchemes: [],
        keybindings: [],
        layouts: [],
        workspaces: [],
        docks: [],
        convenience: {
          smartPaste: false,
          pasteImageDir: "/images",
          hoverIdleSeconds: 5,
          notificationDismiss: "manual",
          copyOnSelect: false,
          pathEllipsis: "end",
          scrollbarStyle: "separate",
        },
        claude: { syncCwd: "skip" },
      }) as any,
    );

    renderHook(() => useSessionPersistence());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const { convenience } = useSettingsStore.getState();
    expect(convenience.smartPaste).toBe(false);
    expect(convenience.pasteImageDir).toBe("/images");
    expect(convenience.hoverIdleSeconds).toBe(5);
    expect(convenience.notificationDismiss).toBe("manual");
    expect(convenience.copyOnSelect).toBe(false);
    expect(convenience.pathEllipsis).toBe("end");
    expect(convenience.scrollbarStyle).toBe("separate");
  });

  it("restores layout viewConfig (overwritten layouts persist across restart)", async () => {
    vi.mocked(loadSettingsValidated).mockResolvedValueOnce(
      wrapOk({
        defaultProfile: "WSL",
        profiles: [
          {
            name: "WSL",
            commandLine: "wsl.exe",
            colorScheme: "",
            startingDirectory: "",
            hidden: false,
          },
        ],
        colorSchemes: [],
        keybindings: [],
        layouts: [
          {
            id: "layout-custom",
            name: "Custom Layout",
            panes: [
              {
                x: 0,
                y: 0,
                w: 0.5,
                h: 1,
                viewType: "TerminalView",
                viewConfig: { type: "TerminalView", profile: "WSL" },
              },
              {
                x: 0.5,
                y: 0,
                w: 0.5,
                h: 1,
                viewType: "MemoView",
                viewConfig: { type: "MemoView" },
              },
            ],
          },
        ],
        workspaces: [
          {
            id: "ws-1",
            name: "WS",
            panes: [{ x: 0, y: 0, w: 1, h: 1, view: { type: "TerminalView" } }],
          },
        ],
        docks: [],
        convenience: {
          smartPaste: true,
          pasteImageDir: "",
          hoverIdleSeconds: 2,
          notificationDismiss: "workspace",
          copyOnSelect: true,
          pathEllipsis: "start",
          scrollbarStyle: "overlay",
        },
        claude: { syncCwd: "skip" },
      }) as any,
    );

    renderHook(() => useSessionPersistence());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const wsState = useWorkspaceStore.getState();
    expect(wsState.layouts).toHaveLength(1);
    expect(wsState.layouts[0].panes[0].viewConfig).toEqual({
      type: "TerminalView",
      profile: "WSL",
    });
    expect(wsState.layouts[0].panes[1].viewConfig).toEqual({
      type: "MemoView",
    });
  });

  it("loads claude settings from backend", async () => {
    vi.mocked(loadSettingsValidated).mockResolvedValueOnce(
      wrapOk({
        defaultProfile: "WSL",
        profiles: [
          {
            name: "WSL",
            commandLine: "wsl.exe",
            colorScheme: "",
            startingDirectory: "",
            hidden: false,
          },
        ],
        colorSchemes: [],
        keybindings: [],
        layouts: [],
        workspaces: [],
        docks: [],
        convenience: {
          smartPaste: true,
          pasteImageDir: "",
          hoverIdleSeconds: 2,
          notificationDismiss: "workspace",
          copyOnSelect: true,
          pathEllipsis: "start",
          scrollbarStyle: "overlay",
        },
        claude: { syncCwd: "command" },
      }) as any,
    );

    renderHook(() => useSessionPersistence());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(useSettingsStore.getState().claude.syncCwd).toBe("command");
  });

  it("prunes overrides for paneIds that no longer exist after load", async () => {
    // Seed overrides for one alive pane and one dead (non-existent) pane.
    useOverridesStore.getState().setPaneOverride("pane-alive", { controlBarMode: "pinned" });
    useOverridesStore.getState().setViewOverride("pane-alive", { fontSize: 20 });
    useOverridesStore.getState().setPaneOverride("pane-dead", { controlBarMode: "minimized" });
    useOverridesStore.getState().setViewOverride("pane-dead", { fontSize: 30 });

    vi.mocked(loadSettingsValidated).mockResolvedValueOnce(
      wrapOk({
        defaultProfile: "WSL",
        profiles: [
          {
            name: "WSL",
            commandLine: "wsl.exe",
            colorScheme: "",
            startingDirectory: "",
            hidden: false,
          },
        ],
        colorSchemes: [],
        keybindings: [],
        layouts: [
          {
            id: "l-test",
            name: "L",
            panes: [{ x: 0, y: 0, w: 1, h: 1, viewType: "TerminalView" }],
          },
        ],
        workspaces: [
          {
            id: "ws-test",
            name: "Test",
            panes: [
              {
                id: "pane-alive",
                x: 0,
                y: 0,
                w: 1,
                h: 1,
                view: { type: "TerminalView", profile: "WSL" },
              },
            ],
          },
        ],
        docks: [],
        convenience: {
          smartPaste: true,
          pasteImageDir: "",
          hoverIdleSeconds: 2,
          notificationDismiss: "workspace",
          copyOnSelect: true,
          pathEllipsis: "start",
          scrollbarStyle: "overlay",
        },
        claude: { syncCwd: "skip" },
      }) as any,
    );

    renderHook(() => useSessionPersistence());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    const overrides = useOverridesStore.getState();
    expect(overrides.getPaneOverride("pane-alive")?.controlBarMode).toBe("pinned");
    expect(overrides.getViewOverride("pane-alive")?.fontSize).toBe(20);
    expect(overrides.getPaneOverride("pane-dead")).toBeUndefined();
    expect(overrides.getViewOverride("pane-dead")).toBeUndefined();
  });
});
