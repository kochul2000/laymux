import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSyncEvents } from "./useSyncEvents";
import { useTerminalStore } from "@/stores/terminal-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));
import { persistSession } from "@/lib/persist-session";

// Mock tauri-api event listeners
const mockOnSyncCwd = vi.fn();
const mockOnSyncBranch = vi.fn();
const mockOnLxNotify = vi.fn();
const mockOnSetTabTitle = vi.fn();
const mockOnCommandStatus = vi.fn();
const mockOnClaudeTerminalDetected = vi.fn();
const mockOnClaudeMessageChanged = vi.fn();
const mockOnTerminalCwdChanged = vi.fn();
const mockOnTerminalTitleChanged = vi.fn();
const mockMarkClaudeTerminal = vi.fn().mockResolvedValue(true);

const mockSendDesktopNotification = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/tauri-api", () => ({
  onSyncCwd: (...args: unknown[]) => mockOnSyncCwd(...args),
  onSyncBranch: (...args: unknown[]) => mockOnSyncBranch(...args),
  onLxNotify: (...args: unknown[]) => mockOnLxNotify(...args),
  onSetTabTitle: (...args: unknown[]) => mockOnSetTabTitle(...args),
  onCommandStatus: (...args: unknown[]) => mockOnCommandStatus(...args),
  onClaudeTerminalDetected: (...args: unknown[]) => mockOnClaudeTerminalDetected(...args),
  onClaudeMessageChanged: (...args: unknown[]) => mockOnClaudeMessageChanged(...args),
  onTerminalCwdChanged: (...args: unknown[]) => mockOnTerminalCwdChanged(...args),
  onTerminalTitleChanged: (...args: unknown[]) => mockOnTerminalTitleChanged(...args),
  markClaudeTerminal: (...args: unknown[]) => mockMarkClaudeTerminal(...args),
  sendOsNotification: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./useOsNotification", () => ({
  sendDesktopNotification: (...args: unknown[]) => mockSendDesktopNotification(...args),
}));

describe("useSyncEvents", () => {
  beforeEach(() => {
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useNotificationStore.setState(useNotificationStore.getInitialState());
    vi.clearAllMocks();

    // Set up mock return values (unlisten functions)
    const unlisten = vi.fn();
    mockOnSyncCwd.mockResolvedValue(unlisten);
    mockOnSyncBranch.mockResolvedValue(unlisten);
    mockOnLxNotify.mockResolvedValue(unlisten);
    mockOnSetTabTitle.mockResolvedValue(unlisten);
    mockOnCommandStatus.mockResolvedValue(unlisten);
    mockOnClaudeTerminalDetected.mockResolvedValue(unlisten);
    mockOnClaudeMessageChanged.mockResolvedValue(unlisten);
    mockOnTerminalCwdChanged.mockResolvedValue(unlisten);
    mockOnTerminalTitleChanged.mockResolvedValue(unlisten);
  });

  it("registers sync-cwd listener on mount", () => {
    renderHook(() => useSyncEvents());
    expect(mockOnSyncCwd).toHaveBeenCalledWith(expect.any(Function));
  });

  it("registers sync-branch listener on mount", () => {
    renderHook(() => useSyncEvents());
    expect(mockOnSyncBranch).toHaveBeenCalledWith(expect.any(Function));
  });

  it("registers lx-notify listener on mount", () => {
    renderHook(() => useSyncEvents());
    expect(mockOnLxNotify).toHaveBeenCalledWith(expect.any(Function));
  });

  it("registers set-tab-title listener on mount", () => {
    renderHook(() => useSyncEvents());
    expect(mockOnSetTabTitle).toHaveBeenCalledWith(expect.any(Function));
  });

  it("updates terminal cwd on sync-cwd event", () => {
    // Register a terminal first
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "PowerShell",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });

    renderHook(() => useSyncEvents());

    // Get the callback that was registered
    const callback = mockOnSyncCwd.mock.calls[0][0];
    callback({
      path: "/home/user/project",
      terminalId: "t1",
      groupId: "g1",
      targets: ["t1"],
    });

    const instance = useTerminalStore.getState().instances.find((i) => i.id === "t1");
    expect(instance?.cwd).toBe("/home/user/project");
  });

  it("updates terminal branch on sync-branch event", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "PowerShell",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });

    renderHook(() => useSyncEvents());

    const callback = mockOnSyncBranch.mock.calls[0][0];
    callback({
      branch: "feature/login",
      terminalId: "t1",
      groupId: "g1",
    });

    const instance = useTerminalStore.getState().instances.find((i) => i.id === "t1");
    expect(instance?.branch).toBe("feature/login");
  });

  it("adds notification on lx-notify event with terminalId", () => {
    renderHook(() => useSyncEvents());

    const callback = mockOnLxNotify.mock.calls[0][0];
    callback({ message: "Build complete", terminalId: "t1" });

    const notifs = useNotificationStore.getState().notifications;
    expect(notifs).toHaveLength(1);
    expect(notifs[0].message).toBe("Build complete");
    expect(notifs[0].terminalId).toBe("t1");
  });

  it("adds notification with level on lx-notify event", () => {
    renderHook(() => useSyncEvents());

    const callback = mockOnLxNotify.mock.calls[0][0];
    callback({ message: "Build failed", terminalId: "t1", level: "error" });

    const notifs = useNotificationStore.getState().notifications;
    expect(notifs).toHaveLength(1);
    expect(notifs[0].message).toBe("Build failed");
    expect(notifs[0].level).toBe("error");
  });

  it("defaults notification level to info when not provided", () => {
    renderHook(() => useSyncEvents());

    const callback = mockOnLxNotify.mock.calls[0][0];
    callback({ message: "Hello", terminalId: "t1" });

    const notifs = useNotificationStore.getState().notifications;
    expect(notifs).toHaveLength(1);
    expect(notifs[0].level).toBe("info");
  });

  it("updates terminal title on set-tab-title event", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "PowerShell",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });

    renderHook(() => useSyncEvents());

    const callback = mockOnSetTabTitle.mock.calls[0][0];
    callback({ title: "~/project", terminalId: "t1" });

    const instance = useTerminalStore.getState().instances.find((i) => i.id === "t1");
    expect(instance?.title).toBe("~/project");
  });

  it("sends OS notification when IDE has no focus", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);

    renderHook(() => useSyncEvents());

    const callback = mockOnLxNotify.mock.calls[0][0];
    callback({ message: "Build done", terminalId: "t1" });

    expect(mockSendDesktopNotification).toHaveBeenCalledWith("Laymux", "Build done");
  });

  it("sends OS notification when notification workspace is not active", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);

    // Terminal belongs to ws-other, but active workspace is the default one
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "PowerShell",
      syncGroup: "ws-other",
      workspaceId: "ws-other",
    });
    // Create workspace with matching name for syncGroup lookup
    const { workspaces } = useWorkspaceStore.getState();
    useWorkspaceStore.setState({
      workspaces: [...workspaces, { id: "ws-other", name: "ws-other", panes: [] }],
    });

    renderHook(() => useSyncEvents());

    const callback = mockOnLxNotify.mock.calls[0][0];
    callback({ message: "Build done", terminalId: "t1" });

    expect(mockSendDesktopNotification).toHaveBeenCalledWith("Laymux", "Build done");
  });

  it("registers command-status listener on mount", () => {
    renderHook(() => useSyncEvents());
    expect(mockOnCommandStatus).toHaveBeenCalledWith(expect.any(Function));
  });

  it("updates terminal lastCommand on command-status event with command", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "PowerShell",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });

    renderHook(() => useSyncEvents());

    const callback = mockOnCommandStatus.mock.calls[0][0];
    callback({ terminalId: "t1", command: "npm test" });

    const instance = useTerminalStore.getState().instances.find((i) => i.id === "t1");
    expect(instance?.lastCommand).toBe("npm test");
    expect(instance?.lastCommandAt).toBeDefined();
    expect(instance?.lastExitCode).toBeUndefined();
  });

  it("updates terminal lastExitCode on command-status event with exitCode", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "PowerShell",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });

    renderHook(() => useSyncEvents());

    const callback = mockOnCommandStatus.mock.calls[0][0];
    callback({ terminalId: "t1", exitCode: 0 });

    const instance = useTerminalStore.getState().instances.find((i) => i.id === "t1");
    expect(instance?.lastExitCode).toBe(0);
    expect(instance?.lastCommandAt).toBeDefined();
  });

  it("does NOT send OS notification when IDE focused and notification workspace is active", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);

    // Active workspace is the default one, and notification goes to it
    renderHook(() => useSyncEvents());

    const callback = mockOnLxNotify.mock.calls[0][0];
    callback({ message: "Build done", terminalId: "t1" });

    expect(mockSendDesktopNotification).not.toHaveBeenCalled();
  });

  it("registers claude-terminal-detected listener on mount", () => {
    renderHook(() => useSyncEvents());
    expect(mockOnClaudeTerminalDetected).toHaveBeenCalledWith(expect.any(Function));
  });

  it("sets activity to Claude on claude-terminal-detected event", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });

    renderHook(() => useSyncEvents());

    const callback = mockOnClaudeTerminalDetected.mock.calls[0][0];
    callback("t1");

    const instance = useTerminalStore.getState().instances.find((i) => i.id === "t1");
    expect(instance?.activity).toEqual({ type: "interactiveApp", name: "Claude" });
  });

  it("calls markClaudeTerminal when command text detects Claude", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });

    renderHook(() => useSyncEvents());

    const callback = mockOnCommandStatus.mock.calls[0][0];
    callback({ terminalId: "t1", command: "claude" });

    expect(mockMarkClaudeTerminal).toHaveBeenCalledWith("t1");
    const instance = useTerminalStore.getState().instances.find((i) => i.id === "t1");
    expect(instance?.activity).toEqual({ type: "interactiveApp", name: "Claude" });
  });

  it("preserves interactiveApp activity when sub-command starts (OSC 133 E)", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });
    // Set terminal as Claude interactiveApp
    useTerminalStore.getState().updateInstanceInfo("t1", {
      activity: { type: "interactiveApp", name: "Claude" },
    });

    renderHook(() => useSyncEvents());

    const callback = mockOnCommandStatus.mock.calls[0][0];
    // Claude runs a sub-command like "gh pr view 3237"
    callback({ terminalId: "t1", command: "gh pr view 3237" });

    const instance = useTerminalStore.getState().instances.find((i) => i.id === "t1");
    // Activity should remain interactiveApp, NOT "running"
    expect(instance?.activity).toEqual({ type: "interactiveApp", name: "Claude" });
    // But lastCommand should still be recorded
    expect(instance?.lastCommand).toBe("gh pr view 3237");
  });

  it("preserves interactiveApp activity when sub-command exits with error (OSC 133 D)", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });
    // Set terminal as Claude interactiveApp
    useTerminalStore.getState().updateInstanceInfo("t1", {
      activity: { type: "interactiveApp", name: "Claude" },
    });

    renderHook(() => useSyncEvents());

    const callback = mockOnCommandStatus.mock.calls[0][0];
    // Claude's sub-command exits with error
    callback({ terminalId: "t1", exitCode: 1 });

    const instance = useTerminalStore.getState().instances.find((i) => i.id === "t1");
    // Activity should remain interactiveApp, NOT "shell"
    expect(instance?.activity).toEqual({ type: "interactiveApp", name: "Claude" });
    // But exitCode should still be recorded
    expect(instance?.lastExitCode).toBe(1);
  });

  it("transitions to shell when non-interactiveApp terminal receives exitCode", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "PowerShell",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });
    // Normal terminal with "running" activity
    useTerminalStore.getState().updateInstanceInfo("t1", {
      activity: { type: "running" },
    });

    renderHook(() => useSyncEvents());

    const callback = mockOnCommandStatus.mock.calls[0][0];
    callback({ terminalId: "t1", exitCode: 0 });

    const instance = useTerminalStore.getState().instances.find((i) => i.id === "t1");
    // Normal terminal should transition to shell as before
    expect(instance?.activity).toEqual({ type: "shell" });
  });

  it("calls persistSession (debounced) on terminal-cwd-changed event", async () => {
    vi.useFakeTimers();
    vi.mocked(persistSession).mockClear();

    renderHook(() => useSyncEvents());

    const callback = mockOnTerminalCwdChanged.mock.calls[0][0];
    callback({ terminalId: "t1", cwd: "/home/user/a" });
    callback({ terminalId: "t1", cwd: "/home/user/b" });

    // Not called yet (debounced)
    expect(persistSession).not.toHaveBeenCalled();

    // Advance past debounce window
    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    // Called exactly once (debounced)
    expect(persistSession).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("calls persistSession (debounced) on sync-cwd event", async () => {
    vi.useFakeTimers();
    vi.mocked(persistSession).mockClear();

    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "PowerShell",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });

    renderHook(() => useSyncEvents());

    const callback = mockOnSyncCwd.mock.calls[0][0];
    callback({
      path: "/home/user/project",
      terminalId: "t1",
      groupId: "g1",
      targets: ["t1"],
    });

    expect(persistSession).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    expect(persistSession).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does NOT call markClaudeTerminal for non-Claude commands", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });

    renderHook(() => useSyncEvents());

    const callback = mockOnCommandStatus.mock.calls[0][0];
    callback({ terminalId: "t1", command: "vim file.txt" });

    expect(mockMarkClaudeTerminal).not.toHaveBeenCalled();
  });
});
