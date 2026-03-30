import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useSyncEvents } from "./useSyncEvents";
import { useTerminalStore } from "@/stores/terminal-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

// Mock tauri-api event listeners
const mockOnSyncCwd = vi.fn();
const mockOnSyncBranch = vi.fn();
const mockOnLxNotify = vi.fn();
const mockOnSetTabTitle = vi.fn();
const mockOnCommandStatus = vi.fn();

const mockSendDesktopNotification = vi.fn().mockResolvedValue(undefined);

vi.mock("@/lib/tauri-api", () => ({
  onSyncCwd: (...args: unknown[]) => mockOnSyncCwd(...args),
  onSyncBranch: (...args: unknown[]) => mockOnSyncBranch(...args),
  onLxNotify: (...args: unknown[]) => mockOnLxNotify(...args),
  onSetTabTitle: (...args: unknown[]) => mockOnSetTabTitle(...args),
  onCommandStatus: (...args: unknown[]) => mockOnCommandStatus(...args),
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

    const instance = useTerminalStore.getState().instances.find(
      (i) => i.id === "t1",
    );
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

    const instance = useTerminalStore.getState().instances.find(
      (i) => i.id === "t1",
    );
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

    const instance = useTerminalStore.getState().instances.find(
      (i) => i.id === "t1",
    );
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
});
