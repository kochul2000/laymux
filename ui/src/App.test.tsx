import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { App } from "./App";

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
      font: { face: "Consolas", size: 14 },
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
  };
});

describe("App", () => {
  it("renders the app root", () => {
    render(<App />);
    expect(screen.getByTestId("app-root")).toBeInTheDocument();
  });

  it("renders the workspace area", () => {
    render(<App />);
    expect(screen.getByTestId("workspace-area")).toBeInTheDocument();
  });
});
