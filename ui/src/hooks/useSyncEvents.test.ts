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
const mockOnTerminalOutputActivity = vi.fn();
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
  onTerminalOutputActivity: (...args: unknown[]) => mockOnTerminalOutputActivity(...args),
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
    mockOnTerminalOutputActivity.mockResolvedValue(unlisten);
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

  it("registers claude-message-changed listener on mount", () => {
    renderHook(() => useSyncEvents());
    expect(mockOnClaudeMessageChanged).toHaveBeenCalledWith(expect.any(Function));
  });

  it("updates terminal activityMessage on claude-message-changed event", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });

    renderHook(() => useSyncEvents());

    const callback = mockOnClaudeMessageChanged.mock.calls[0][0];
    callback({ terminalId: "t1", message: "모든 테스트 통과했습니다." });

    const instance = useTerminalStore.getState().instances.find((i) => i.id === "t1");
    expect(instance?.activityMessage).toBe("모든 테스트 통과했습니다.");
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

  it("detects Codex from command text without calling Claude marker", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });

    renderHook(() => useSyncEvents());

    const callback = mockOnCommandStatus.mock.calls[0][0];
    callback({ terminalId: "t1", command: "codex" });

    const instance = useTerminalStore.getState().instances.find((i) => i.id === "t1");
    expect(instance?.activity).toEqual({ type: "interactiveApp", name: "Codex" });
    expect(mockMarkClaudeTerminal).not.toHaveBeenCalled();
  });

  it("preserves Codex activity when title no longer contains app name", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });
    useTerminalStore.getState().updateInstanceInfo("t1", {
      activity: { type: "interactiveApp", name: "Codex" },
    });

    renderHook(() => useSyncEvents());

    const callback = mockOnTerminalTitleChanged.mock.calls[0][0];
    callback({
      terminalId: "t1",
      title: "⠋ laymux",
      interactiveApp: null,
      notifyGateArmed: false,
    });

    const instance = useTerminalStore.getState().instances.find((i) => i.id === "t1");
    expect(instance?.activity).toEqual({ type: "interactiveApp", name: "Codex" });
    expect(instance?.outputActive).toBe(true);
  });

  it("returns Codex terminal to shell on exitCode", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });
    useTerminalStore.getState().updateInstanceInfo("t1", {
      activity: { type: "interactiveApp", name: "Codex" },
      lastCommand: "codex",
    });

    renderHook(() => useSyncEvents());

    const callback = mockOnCommandStatus.mock.calls[0][0];
    callback({ terminalId: "t1", exitCode: 0 });

    const instance = useTerminalStore.getState().instances.find((i) => i.id === "t1");
    expect(instance?.activity).toEqual({ type: "shell" });
    expect(instance?.lastExitCode).toBe(0);
  });

  it("clears outputActive immediately on active:false event (app-agnostic)", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });
    useTerminalStore.getState().updateInstanceInfo("t1", {
      outputActive: true,
    });

    renderHook(() => useSyncEvents());

    const callback = mockOnTerminalOutputActivity.mock.calls[0][0];
    // Backend sends active:false on TUI working→idle transition
    callback({ terminalId: "t1", active: false });

    const inst = useTerminalStore.getState().instances.find((i) => i.id === "t1");
    expect(inst?.outputActive).toBe(false);
  });

  it("cleans up outputActive timer when terminal is removed from store", () => {
    vi.useFakeTimers();
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });

    renderHook(() => useSyncEvents());

    // Trigger outputActive so a timer is created
    const callback = mockOnTerminalOutputActivity.mock.calls[0][0];
    callback({ terminalId: "t1" });

    const inst = useTerminalStore.getState().instances.find((i) => i.id === "t1");
    expect(inst?.outputActive).toBe(true);

    // Remove terminal — timer should be cleaned up
    useTerminalStore.getState().unregisterInstance("t1");

    // Timer was cleared (no stale entries). Advancing time should not cause errors.
    vi.advanceTimersByTime(3000);
    vi.useRealTimers();
  });

  // ── Claude state transition: full event sequence tests ──
  // These simulate the exact event sequence that Rust PTY callback emits
  // during Claude lifecycle transitions, verifying frontend state at each step.

  describe("Claude lifecycle event sequences", () => {
    function setupClaudeTerminal() {
      useTerminalStore.getState().registerInstance({
        id: "t1",
        profile: "WSL",
        syncGroup: "g1",
        workspaceId: "ws-1",
      });
      // Simulate: user typed "claude" → OSC 133 E detected → command recorded
      useTerminalStore.getState().updateInstanceInfo("t1", {
        lastCommand: "claude",
        activity: { type: "interactiveApp", name: "Claude" },
      });
    }

    function getInst() {
      return useTerminalStore.getState().instances.find((i) => i.id === "t1");
    }

    it("task_completed event sequence: active:false → exitCode=0 preserves interactiveApp", () => {
      setupClaudeTerminal();
      useTerminalStore.getState().updateInstanceInfo("t1", {
        outputActive: true, // was working (DEC 2026 burst)
      });

      renderHook(() => useSyncEvents());

      const activityCb = mockOnTerminalOutputActivity.mock.calls[0][0];
      const cmdStatusCb = mockOnCommandStatus.mock.calls[0][0];

      // Step 1: Rust emits active:false (task_completed)
      activityCb({ terminalId: "t1", active: false });
      expect(getInst()?.outputActive).toBe(false);
      expect(getInst()?.lastExitCode).toBe(0);

      // Step 2: Rust emits command-status with exitCode=0 (synthetic)
      cmdStatusCb({ terminalId: "t1", exitCode: 0 });
      expect(getInst()?.lastExitCode).toBe(0);
      // Activity MUST remain interactiveApp
      expect(getInst()?.activity).toEqual({ type: "interactiveApp", name: "Claude" });
    });

    it("after task_completed, DEC 2026 burst re-enables outputActive", () => {
      vi.useFakeTimers();
      setupClaudeTerminal();

      renderHook(() => useSyncEvents());

      const activityCb = mockOnTerminalOutputActivity.mock.calls[0][0];
      const cmdStatusCb = mockOnCommandStatus.mock.calls[0][0];

      // Phase 1: task_completed
      activityCb({ terminalId: "t1", active: false });
      cmdStatusCb({ terminalId: "t1", exitCode: 0 });
      expect(getInst()?.outputActive).toBe(false);
      expect(getInst()?.lastExitCode).toBe(0);

      // Phase 2: Claude starts new task → DEC 2026 burst fires
      activityCb({ terminalId: "t1" }); // active: undefined = true (default)
      expect(getInst()?.outputActive).toBe(true);

      // Verify: outputActive=true + exitCode=0 → computeCommandStatus should give ⏳
      // (outputActive priority 1 > exitCode priority 2)

      vi.useRealTimers();
    });

    it("DEC 2026 burst auto-resets after 2s timeout", () => {
      vi.useFakeTimers();
      setupClaudeTerminal();

      renderHook(() => useSyncEvents());

      const activityCb = mockOnTerminalOutputActivity.mock.calls[0][0];

      // DEC 2026 burst fires
      activityCb({ terminalId: "t1" });
      expect(getInst()?.outputActive).toBe(true);

      // 2s passes with no new events → auto-reset
      vi.advanceTimersByTime(2100);
      expect(getInst()?.outputActive).toBe(false);
      expect(getInst()?.lastExitCode).toBe(0);

      vi.useRealTimers();
    });

    it("rapid DEC 2026 bursts keep outputActive=true (timer resets)", () => {
      vi.useFakeTimers();
      setupClaudeTerminal();

      renderHook(() => useSyncEvents());

      const activityCb = mockOnTerminalOutputActivity.mock.calls[0][0];

      // Burst 1
      activityCb({ terminalId: "t1" });
      expect(getInst()?.outputActive).toBe(true);

      // 1.5s later: another burst (resets timer)
      vi.advanceTimersByTime(1500);
      activityCb({ terminalId: "t1" });
      expect(getInst()?.outputActive).toBe(true);

      // 1.5s later: still active (only 1.5s since last burst, < 2s timeout)
      vi.advanceTimersByTime(1500);
      expect(getInst()?.outputActive).toBe(true);

      // 0.6s later: timer expires (2.1s since last burst)
      vi.advanceTimersByTime(600);
      expect(getInst()?.outputActive).toBe(false);
      expect(getInst()?.lastExitCode).toBe(0);

      vi.useRealTimers();
    });

    it("active:false cancels pending DEC 2026 timer", () => {
      vi.useFakeTimers();
      setupClaudeTerminal();

      renderHook(() => useSyncEvents());

      const activityCb = mockOnTerminalOutputActivity.mock.calls[0][0];

      // DEC 2026 burst fires → outputActive=true + timer started
      activityCb({ terminalId: "t1" });
      expect(getInst()?.outputActive).toBe(true);

      // active:false arrives → immediate deactivation + timer cancelled
      activityCb({ terminalId: "t1", active: false });
      expect(getInst()?.outputActive).toBe(false);
      expect(getInst()?.lastExitCode).toBe(0);

      // Original timer would have fired here, but was cancelled
      vi.advanceTimersByTime(3000);
      expect(getInst()?.outputActive).toBe(false);

      vi.useRealTimers();
    });

    it("full cycle: idle → working → task_completed → working again → task_completed", () => {
      vi.useFakeTimers();
      setupClaudeTerminal();

      renderHook(() => useSyncEvents());

      const activityCb = mockOnTerminalOutputActivity.mock.calls[0][0];
      const cmdStatusCb = mockOnCommandStatus.mock.calls[0][0];

      // ── Cycle 1: first task ──

      // Claude starts working (DEC 2026 burst)
      activityCb({ terminalId: "t1" });
      expect(getInst()?.outputActive).toBe(true);
      // State: outputActive=true, exitCode=undefined → ⏳

      // Claude completes task (task_completed events)
      activityCb({ terminalId: "t1", active: false });
      cmdStatusCb({ terminalId: "t1", exitCode: 0 });
      expect(getInst()?.outputActive).toBe(false);
      expect(getInst()?.lastExitCode).toBe(0);
      // State: outputActive=false, exitCode=0 → ✓

      // ── Cycle 2: second task ──

      // Claude starts working again (DEC 2026 burst)
      activityCb({ terminalId: "t1" });
      expect(getInst()?.outputActive).toBe(true);
      // State: outputActive=true, exitCode=0 → ⏳ (outputActive takes priority)

      // Claude completes second task
      activityCb({ terminalId: "t1", active: false });
      cmdStatusCb({ terminalId: "t1", exitCode: 0 });
      expect(getInst()?.outputActive).toBe(false);
      expect(getInst()?.lastExitCode).toBe(0);
      expect(getInst()?.activity).toEqual({ type: "interactiveApp", name: "Claude" });
      // State: outputActive=false, exitCode=0 → ✓

      vi.useRealTimers();
    });

    it("exitCode=0 from task_completed does NOT change activity to shell", () => {
      setupClaudeTerminal();

      renderHook(() => useSyncEvents());

      const cmdStatusCb = mockOnCommandStatus.mock.calls[0][0];

      // Synthetic exitCode=0 from task_completed (command=undefined)
      cmdStatusCb({ terminalId: "t1", exitCode: 0 });

      // Activity MUST remain interactiveApp, NOT shell
      expect(getInst()?.activity).toEqual({ type: "interactiveApp", name: "Claude" });
      expect(getInst()?.lastExitCode).toBe(0);
    });

    it("marks Codex success when outputActive transitions to false", () => {
      useTerminalStore.getState().registerInstance({
        id: "t1",
        profile: "PowerShell",
        syncGroup: "g1",
        workspaceId: "ws-1",
      });
      useTerminalStore.getState().updateInstanceInfo("t1", {
        activity: { type: "interactiveApp", name: "Codex" },
        outputActive: true,
      });

      renderHook(() => useSyncEvents());

      const activityCb = mockOnTerminalOutputActivity.mock.calls[0][0];
      activityCb({ terminalId: "t1", active: false });

      const instance = useTerminalStore.getState().instances.find((i) => i.id === "t1");
      expect(instance?.outputActive).toBe(false);
      expect(instance?.lastExitCode).toBe(0);
      expect(instance?.activity).toEqual({ type: "interactiveApp", name: "Codex" });
    });

    it("marks Codex success when outputActive times out", () => {
      vi.useFakeTimers();
      useTerminalStore.getState().registerInstance({
        id: "t1",
        profile: "PowerShell",
        syncGroup: "g1",
        workspaceId: "ws-1",
      });
      useTerminalStore.getState().updateInstanceInfo("t1", {
        activity: { type: "interactiveApp", name: "Codex" },
      });

      renderHook(() => useSyncEvents());

      const activityCb = mockOnTerminalOutputActivity.mock.calls[0][0];
      activityCb({ terminalId: "t1" });
      expect(useTerminalStore.getState().instances.find((i) => i.id === "t1")?.outputActive).toBe(
        true,
      );

      vi.advanceTimersByTime(2100);
      const instance = useTerminalStore.getState().instances.find((i) => i.id === "t1");
      expect(instance?.outputActive).toBe(false);
      expect(instance?.lastExitCode).toBe(0);

      vi.useRealTimers();
    });
  });
});
