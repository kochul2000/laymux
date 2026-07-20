import { render, screen } from "@testing-library/react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { App } from "./App";
import { loadSettingsValidated } from "@/lib/tauri-api";
import { useLocalMobileModeStore } from "@/stores/local-mobile-mode-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";

// Mock @tauri-apps/api/window for useWindowGeometry hook
vi.mock("@tauri-apps/api/window", () => {
  const unlisten = vi.fn();
  const mockWindow = {
    onMoved: vi.fn().mockResolvedValue(unlisten),
    onResized: vi.fn().mockResolvedValue(unlisten),
    onCloseRequested: vi.fn().mockResolvedValue(unlisten),
    setSize: vi.fn().mockResolvedValue(undefined),
    setPosition: vi.fn().mockResolvedValue(undefined),
    maximize: vi.fn().mockResolvedValue(undefined),
    minimize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    isMaximized: vi.fn().mockResolvedValue(false),
    isMinimized: vi.fn().mockResolvedValue(false),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    outerPosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
    innerSize: vi.fn().mockResolvedValue({ width: 1200, height: 770 }),
    outerSize: vi.fn().mockResolvedValue({ width: 1200, height: 800 }),
  };
  return {
    getCurrentWindow: vi.fn().mockReturnValue(mockWindow),
    availableMonitors: vi.fn().mockResolvedValue([]),
    PhysicalSize: class {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
      }
    },
    PhysicalPosition: class {
      x: number;
      y: number;
      constructor(x: number, y: number) {
        this.x = x;
        this.y = y;
      }
    },
  };
});

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
  saveBeforeClose: vi.fn().mockResolvedValue(undefined),
  setBlockPersist: vi.fn(),
}));

// Mock tauri-api to prevent unhandled errors in test environment
vi.mock("@/lib/tauri-api", () => {
  const unlisten = vi.fn();
  return {
    onSyncCwd: vi.fn().mockResolvedValue(unlisten),
    onSyncBranch: vi.fn().mockResolvedValue(unlisten),
    onLxNotify: vi.fn().mockResolvedValue(unlisten),
    onSetTabTitle: vi.fn().mockResolvedValue(unlisten),
    onCommandStatus: vi.fn().mockResolvedValue(unlisten),
    createTerminalSession: vi.fn().mockResolvedValue({}),
    writeToTerminal: vi.fn().mockResolvedValue(undefined),
    resizeTerminal: vi.fn().mockResolvedValue(undefined),
    closeTerminalSession: vi.fn().mockResolvedValue(undefined),
    onTerminalOutput: vi.fn().mockResolvedValue(unlisten),
    loadSettings: vi.fn().mockResolvedValue({
      defaultProfile: "PowerShell",
      profiles: [],
      colorSchemes: [],
      keybindings: [],
      layouts: [],
      workspaces: [],
      docks: [],
    }),
    loadSettingsValidated: vi.fn().mockResolvedValue({
      status: "ok",
      settings: {
        defaultProfile: "PowerShell",
        profiles: [],
        colorSchemes: [],
        keybindings: [],
        layouts: [],
        workspaces: [],
        docks: [],
      },
      warnings: [],
    }),
    saveSettings: vi.fn().mockResolvedValue(undefined),
    getListeningPorts: vi.fn().mockResolvedValue([]),
    getGitBranch: vi.fn().mockResolvedValue(null),
    sendOsNotification: vi.fn().mockResolvedValue(undefined),
    onAutomationRequest: vi.fn().mockResolvedValue(unlisten),
    automationResponse: vi.fn().mockResolvedValue(undefined),
    onClaudeTerminalDetected: vi.fn().mockResolvedValue(unlisten),
    onClaudeMessageChanged: vi.fn().mockResolvedValue(unlisten),
    onTerminalCwdChanged: vi.fn().mockResolvedValue(unlisten),
    onTerminalTitleChanged: vi.fn().mockResolvedValue(unlisten),
    markClaudeTerminal: vi.fn().mockResolvedValue(true),
    onTerminalOutputActivity: vi.fn().mockResolvedValue(unlisten),
    getRemoteControlStatus: vi.fn().mockResolvedValue({
      active: false,
      leaseId: null,
      remoteAddr: null,
      clientName: null,
      heartbeatTimeoutSeconds: 15,
    }),
    onRemoteControlChanged: vi.fn().mockResolvedValue(unlisten),
    getRemoteSessionActive: vi.fn().mockResolvedValue(false),
    onRemoteSessionChanged: vi.fn().mockResolvedValue(unlisten),
    reclaimRemoteControl: vi.fn().mockResolvedValue({
      active: false,
      leaseId: null,
      remoteAddr: null,
      clientName: null,
      heartbeatTimeoutSeconds: 15,
    }),
    getTerminalStates: vi.fn().mockResolvedValue({}),
    cleanTerminalOutputCache: vi.fn().mockResolvedValue(undefined),
    loadWindowGeometry: vi.fn().mockResolvedValue(null),
    saveWindowGeometry: vi.fn().mockResolvedValue(undefined),
    // The right dock now defaults to MemoView on first launch, which mounts
    // MemoView and loads/saves memo content — stub these so it doesn't throw.
    loadMemo: vi.fn().mockResolvedValue(""),
    saveMemo: vi.fn().mockResolvedValue(undefined),
    clipboardWriteText: vi.fn().mockResolvedValue(undefined),
  };
});

function loadedSettings(remote?: Partial<ReturnType<typeof useSettingsStore.getState>["remote"]>) {
  return {
    defaultProfile: "PowerShell",
    profiles: [],
    colorSchemes: [],
    keybindings: [],
    layouts: [],
    workspaces: [],
    docks: [],
    remote: {
      ...useSettingsStore.getInitialState().remote,
      ...remote,
    },
  };
}

describe("App", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    useLocalMobileModeStore.setState(useLocalMobileModeStore.getInitialState());
    vi.mocked(loadSettingsValidated).mockResolvedValue({
      status: "ok",
      settings: loadedSettings(),
      warnings: [],
    });
    Object.defineProperty(window, "innerWidth", {
      value: 1200,
      configurable: true,
    });
  });

  it("renders the app root", () => {
    render(<App />);
    expect(screen.getByTestId("app-root")).toBeInTheDocument();
  });

  it("shows loading screen then renders workspace area after settings load", async () => {
    render(<App />);
    // Initially shows loading screen
    expect(screen.getByTestId("app-root")).toBeInTheDocument();

    // After settings load (async), workspace area appears
    await screen.findByTestId("workspace-area", {}, { timeout: 3000 });
    expect(screen.getByTestId("workspace-area")).toBeInTheDocument();
  });

  it("does not auto-open Remote Access before disabled loaded settings hydrate", async () => {
    vi.mocked(loadSettingsValidated).mockResolvedValueOnce({
      status: "ok",
      settings: loadedSettings({ autoMobileModeMinWidth: 0 }),
      warnings: [],
    });
    Object.defineProperty(window, "innerWidth", {
      value: 320,
      configurable: true,
    });

    render(<App />);

    expect(useUiStore.getState().remoteAccessModalOpen).toBe(false);
    await screen.findByTestId("workspace-area", {}, { timeout: 3000 });
    expect(useUiStore.getState().remoteAccessModalOpen).toBe(false);
  });
});
