import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { App } from "./App";

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
    saveSettings: vi.fn().mockResolvedValue(undefined),
    getListeningPorts: vi.fn().mockResolvedValue([]),
    getGitBranch: vi.fn().mockResolvedValue(null),
    sendOsNotification: vi.fn().mockResolvedValue(undefined),
    onAutomationRequest: vi.fn().mockResolvedValue(unlisten),
    automationResponse: vi.fn().mockResolvedValue(undefined),
    onClaudeTerminalDetected: vi.fn().mockResolvedValue(unlisten),
    onTerminalCwdChanged: vi.fn().mockResolvedValue(unlisten),
    markClaudeTerminal: vi.fn().mockResolvedValue(true),
  };
});

describe("App", () => {
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
});
