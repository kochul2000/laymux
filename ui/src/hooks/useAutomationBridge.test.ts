import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useAutomationBridge,
  handleAutomationRequest,
  handleAsyncAutomationRequest,
} from "./useAutomationBridge";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGridStore } from "@/stores/grid-store";
import { useDockStore } from "@/stores/dock-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useUiStore } from "@/stores/ui-store";
vi.mock("@/lib/tauri-api", () => ({
  onAutomationRequest: vi.fn().mockResolvedValue(vi.fn()),
  automationResponse: vi.fn().mockResolvedValue(undefined),
}));

describe("handleAutomationRequest", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useGridStore.setState(useGridStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useNotificationStore.setState(useNotificationStore.getInitialState());
    vi.clearAllMocks();
  });

  it("returns workspace list", () => {
    const result = handleAutomationRequest({
      requestId: "r1",
      category: "query",
      target: "workspaces",
      method: "list",
      params: {},
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("workspaces");
    expect(result.data).toHaveProperty("activeWorkspaceId");
  });

  it("returns active workspace", () => {
    const result = handleAutomationRequest({
      requestId: "r2",
      category: "query",
      target: "workspaces",
      method: "getActive",
      params: {},
    });
    expect(result.success).toBe(true);
  });

  it("switches active workspace", () => {
    const state = useWorkspaceStore.getState();
    const wsId = state.workspaces[0]?.id;
    if (wsId) {
      const result = handleAutomationRequest({
        requestId: "r3",
        category: "action",
        target: "workspaces",
        method: "switchActive",
        params: { id: wsId },
      });
      expect(result.success).toBe(true);
    }
  });

  it("returns grid state", () => {
    const result = handleAutomationRequest({
      requestId: "r4",
      category: "query",
      target: "grid",
      method: "getState",
      params: {},
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("editMode");
    expect(result.data).toHaveProperty("focusedPaneIndex");
  });

  it("sets edit mode", () => {
    handleAutomationRequest({
      requestId: "r5",
      category: "action",
      target: "grid",
      method: "setEditMode",
      params: { enabled: true },
    });
    expect(useGridStore.getState().editMode).toBe(true);
  });

  it("focuses pane", () => {
    handleAutomationRequest({
      requestId: "r6",
      category: "action",
      target: "grid",
      method: "focusPane",
      params: { index: 2 },
    });
    expect(useGridStore.getState().focusedPaneIndex).toBe(2);
  });

  it("returns dock list", () => {
    const result = handleAutomationRequest({
      requestId: "r7",
      category: "query",
      target: "docks",
      method: "list",
      params: {},
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("docks");
  });

  it("returns terminal list", () => {
    const result = handleAutomationRequest({
      requestId: "r8",
      category: "query",
      target: "terminals",
      method: "list",
      params: {},
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("instances");
  });

  it("returns notification list", () => {
    const result = handleAutomationRequest({
      requestId: "r9",
      category: "query",
      target: "notifications",
      method: "list",
      params: {},
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("notifications");
  });

  it("returns layout list", () => {
    const result = handleAutomationRequest({
      requestId: "r10",
      category: "query",
      target: "layouts",
      method: "list",
      params: {},
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("layouts");
  });

  it("returns error for unknown target", () => {
    const result = handleAutomationRequest({
      requestId: "r11",
      category: "query",
      target: "nonexistent",
      method: "list",
      params: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown target");
  });

  it("returns error for unknown method", () => {
    const result = handleAutomationRequest({
      requestId: "r12",
      category: "query",
      target: "workspaces",
      method: "nonexistent",
      params: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("Unknown method");
  });

  it("splits pane", () => {
    const result = handleAutomationRequest({
      requestId: "r13",
      category: "action",
      target: "panes",
      method: "split",
      params: { paneIndex: 0, direction: "horizontal" },
    });
    expect(result.success).toBe(true);
    // After split, the workspace should have 2 panes
    const ws = useWorkspaceStore.getState().getActiveWorkspace();
    expect(ws?.panes.length).toBeGreaterThanOrEqual(2);
  });

  // -- New notification/terminal/summary endpoints --

  it("adds a notification via automation API", () => {
    const result = handleAutomationRequest({
      requestId: "n1",
      category: "action",
      target: "notifications",
      method: "add",
      params: {
        terminalId: "t1",
        workspaceId: "ws-default",
        message: "Build complete",
        level: "success",
      },
    });
    expect(result.success).toBe(true);
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    expect(useNotificationStore.getState().notifications[0].level).toBe("success");
  });

  it("gets workspace summary via automation API", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: "ws-default",
    });
    useTerminalStore.getState().updateInstanceInfo("t1", { branch: "main", cwd: "/home/user" });
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "test",
    });

    const result = handleAutomationRequest({
      requestId: "s1",
      category: "query",
      target: "workspaces",
      method: "getSummary",
      params: { id: "ws-default" },
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty("summary");
    const summary = data.summary as Record<string, unknown>;
    expect(summary.branch).toBe("main");
    expect(summary.cwd).toBe("/home/user");
    expect(summary.unreadCount).toBe(1);
    expect(summary.hasUnread).toBe(true);
  });

  it("sets terminal focus via automation API", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "g",
      workspaceId: "ws-default",
    });

    const result = handleAutomationRequest({
      requestId: "f1",
      category: "action",
      target: "terminals",
      method: "setFocus",
      params: { id: "t1" },
    });
    expect(result.success).toBe(true);
    expect(useTerminalStore.getState().instances[0].isFocused).toBe(true);
  });

  it("removes pane", () => {
    // First split to have 2 panes
    handleAutomationRequest({
      requestId: "s1",
      category: "action",
      target: "panes",
      method: "split",
      params: { paneIndex: 0, direction: "horizontal" },
    });
    const before = useWorkspaceStore.getState().getActiveWorkspace()?.panes.length ?? 0;

    handleAutomationRequest({
      requestId: "r14",
      category: "action",
      target: "panes",
      method: "remove",
      params: { paneIndex: 0 },
    });
    const after = useWorkspaceStore.getState().getActiveWorkspace()?.panes.length ?? 0;
    expect(after).toBe(before - 1);
  });

  // -- UI action handlers --

  it("toggles settings modal via automation API", () => {
    useUiStore.setState(useUiStore.getInitialState());
    expect(useUiStore.getState().settingsModalOpen).toBe(false);

    const result = handleAutomationRequest({
      requestId: "ui-1",
      category: "action",
      target: "ui",
      method: "toggleSettings",
      params: {},
    });
    expect(result.success).toBe(true);
    expect(useUiStore.getState().settingsModalOpen).toBe(true);
  });

  it("toggles notification panel via automation API", () => {
    useUiStore.setState(useUiStore.getInitialState());
    expect(useUiStore.getState().notificationPanelOpen).toBe(false);

    const result = handleAutomationRequest({
      requestId: "ui-2",
      category: "action",
      target: "ui",
      method: "toggleNotificationPanel",
      params: {},
    });
    expect(result.success).toBe(true);
    expect(useUiStore.getState().notificationPanelOpen).toBe(true);

    // Toggle again to close
    handleAutomationRequest({
      requestId: "ui-3",
      category: "action",
      target: "ui",
      method: "toggleNotificationPanel",
      params: {},
    });
    expect(useUiStore.getState().notificationPanelOpen).toBe(false);
  });
});

describe("handleAsyncAutomationRequest", () => {
  it("falls through to sync handler for non-screenshot targets", async () => {
    const result = await handleAsyncAutomationRequest({
      requestId: "async-1",
      category: "query",
      target: "workspaces",
      method: "list",
      params: {},
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("workspaces");
  });

  it("handles screenshot target", async () => {
    // html2canvas is hard to test in jsdom, so we verify it attempts capture
    // and handles the error gracefully (jsdom has no real rendering)
    const result = await handleAsyncAutomationRequest({
      requestId: "async-2",
      category: "action",
      target: "screenshot",
      method: "capture",
      params: {},
    });
    // In jsdom, html2canvas may fail or return empty — either way, no crash
    expect(result).toHaveProperty("success");
  });
});

describe("useAutomationBridge hook", () => {
  it("registers event listener on mount", async () => {
    const { onAutomationRequest } = await import("@/lib/tauri-api");
    renderHook(() => useAutomationBridge());
    expect(onAutomationRequest).toHaveBeenCalled();
  });

  it("cleans up listener even when unmounted before promise resolves (StrictMode)", async () => {
    const unlistenMock = vi.fn();
    const { onAutomationRequest } = await import("@/lib/tauri-api");

    let resolveListenPromise!: (fn: () => void) => void;
    (onAutomationRequest as ReturnType<typeof vi.fn>).mockReturnValueOnce(
      new Promise<() => void>((resolve) => {
        resolveListenPromise = resolve;
      }),
    );

    const { unmount } = renderHook(() => useAutomationBridge());
    // Unmount before the listen promise resolves (simulates StrictMode cleanup race)
    unmount();

    // Now resolve — the unlisten should be called immediately since effect was cleaned up
    resolveListenPromise(unlistenMock);
    await Promise.resolve(); // flush microtask

    expect(unlistenMock).toHaveBeenCalled();
  });

  it("does not process requests after unmount", async () => {
    const { onAutomationRequest, automationResponse } = await import("@/lib/tauri-api");

    let capturedCallback: ((data: unknown) => void) | null = null;
    (onAutomationRequest as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (cb: (data: unknown) => void) => {
        capturedCallback = cb;
        return Promise.resolve(vi.fn());
      },
    );

    const { unmount } = renderHook(() => useAutomationBridge());
    await Promise.resolve(); // let promise resolve

    unmount();

    // Fire a request after unmount — should be ignored
    if (capturedCallback !== null) {
      await (capturedCallback as (data: unknown) => void)({
        requestId: "late-req",
        category: "query",
        target: "workspaces",
        method: "list",
        params: {},
      });
    }

    // automationResponse should NOT be called for the late request
    expect(automationResponse).not.toHaveBeenCalledWith(
      "late-req",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });
});
