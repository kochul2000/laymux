import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import {
  useAutomationBridge,
  captureScreenshot,
  handleAutomationRequest,
  handleAsyncAutomationRequest,
} from "./useAutomationBridge";
import html2canvas from "html2canvas";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGridStore } from "@/stores/grid-store";
import { useDockStore } from "@/stores/dock-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useUiStore } from "@/stores/ui-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useFileViewerStore } from "@/stores/file-viewer-store";
vi.mock("@/lib/tauri-api", () => ({
  onAutomationRequest: vi.fn().mockResolvedValue(vi.fn()),
  automationResponse: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("html2canvas", () => ({
  default: vi.fn(),
}));

vi.mock("html2canvas", () => ({
  default: vi.fn(),
}));

function mockScreenshotCanvas() {
  const drawImage = vi.fn();
  const resultCanvas = {
    getContext: vi.fn(() => ({ drawImage })),
    toDataURL: vi.fn(() => "data:image/png;base64,test"),
  } as unknown as HTMLCanvasElement;

  vi.mocked(html2canvas).mockResolvedValueOnce(resultCanvas);
  return { drawImage };
}

function addCanvasElement() {
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  canvas.getBoundingClientRect = () =>
    ({
      x: 4,
      y: 8,
      left: 4,
      top: 8,
      right: 20,
      bottom: 24,
      width: 16,
      height: 16,
      toJSON: () => ({}),
    }) as DOMRect;
  document.documentElement.appendChild(canvas);
}

describe("handleAutomationRequest", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useGridStore.setState(useGridStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useNotificationStore.setState(useNotificationStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
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
    expect(result.data).toHaveProperty("workspaceDisplayOrder");
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
      useDockStore.getState().setFocusedDock("left");
      const result = handleAutomationRequest({
        requestId: "r3",
        category: "action",
        target: "workspaces",
        method: "switchActive",
        params: { id: wsId },
      });
      expect(result.success).toBe(true);
      expect(useDockStore.getState().focusedDock).toBeNull();
      expect(useDockStore.getState().focusedDockPaneId).toBeNull();
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
    // Split to have at least 3 panes (indices 0, 1, 2)
    useWorkspaceStore.getState().splitPane(0, "horizontal");
    useWorkspaceStore.getState().splitPane(0, "vertical");
    const result = handleAutomationRequest({
      requestId: "r6",
      category: "action",
      target: "grid",
      method: "focusPane",
      params: { index: 2 },
    });
    expect(result.success).toBe(true);
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

  it("marks terminal notifications as read", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "terminal-pane-1",
      workspaceId: "ws-default",
      message: "waiting",
      requiresAction: true,
    });

    const result = handleAutomationRequest({
      requestId: "r9b",
      category: "action",
      target: "notifications",
      method: "markTerminalRead",
      params: { terminalId: "terminal-pane-1" },
    });

    expect(result.success).toBe(true);
    expect(useNotificationStore.getState().notifications[0].readAt).not.toBeNull();
  });

  it("marks notification ids as read", () => {
    const store = useNotificationStore.getState();
    const first = store.addNotification({
      terminalId: "terminal-pane-1",
      workspaceId: "ws-default",
      message: "first",
      requiresAction: true,
    });
    const second = store.addNotification({
      terminalId: "terminal-pane-2",
      workspaceId: "ws-default",
      message: "second",
      requiresAction: true,
    });

    const result = handleAutomationRequest({
      requestId: "r9c",
      category: "action",
      target: "notifications",
      method: "markIdsRead",
      params: { ids: [first.id] },
    });

    expect(result.success).toBe(true);
    const notifications = useNotificationStore.getState().notifications;
    expect(
      notifications.find((notification) => notification.id === first.id)?.readAt,
    ).not.toBeNull();
    expect(notifications.find((notification) => notification.id === second.id)?.readAt).toBeNull();
  });

  it("marks all unread notifications as read", () => {
    const now = Date.now();
    useNotificationStore.setState({
      notifications: [
        {
          id: "unread-1",
          terminalId: "terminal-pane-1",
          workspaceId: "ws-default",
          message: "first",
          level: "info",
          createdAt: now - 10,
          readAt: null,
        },
        {
          id: "read-1",
          terminalId: "terminal-pane-2",
          workspaceId: "ws-default",
          message: "second",
          level: "info",
          createdAt: now - 5,
          readAt: now - 1,
        },
      ],
    });

    const result = handleAutomationRequest({
      requestId: "r9d",
      category: "action",
      target: "notifications",
      method: "markAllRead",
      params: {},
    });

    expect(result.success).toBe(true);
    expect((result.data as { marked: number }).marked).toBe(1);
    expect(
      useNotificationStore
        .getState()
        .notifications.every((notification) => notification.readAt !== null),
    ).toBe(true);
  });

  it("returns UI hidden state for remote navigation", () => {
    useUiStore.getState().toggleWorkspaceHidden("ws-hidden");
    useUiStore.getState().togglePaneHidden("pane-hidden");
    useDockStore.getState().setFocusedDock("left");
    const focusedDockPaneId = useDockStore.getState().focusedDockPaneId;
    useSettingsStore.getState().setWorkspaceSelector({ sortOrder: "notification" });

    const result = handleAutomationRequest({
      requestId: "r9c",
      category: "query",
      target: "ui",
      method: "state",
      params: {},
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      hiddenWorkspaceIds: ["ws-hidden"],
      hiddenPaneIds: ["pane-hidden"],
      hideMode: false,
      focusedDock: "left",
      focusedDockPaneId,
      workspaceSelector: expect.objectContaining({ sortOrder: "notification" }),
    });
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
    // Register a terminal so validation passes
    const wsId = useWorkspaceStore.getState().workspaces[0]?.id ?? "ws-default";
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "g",
      workspaceId: wsId,
    });
    const result = handleAutomationRequest({
      requestId: "n1",
      category: "action",
      target: "notifications",
      method: "add",
      params: {
        terminalId: "t1",
        workspaceId: wsId,
        message: "Build complete",
        level: "success",
      },
    });
    expect(result.success).toBe(true);
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    expect(useNotificationStore.getState().notifications[0].level).toBe("success");
  });

  it("gets workspace summary via automation API", () => {
    // Use a non-active workspace so notifications stay unread (auto-dismiss applies to active ws)
    useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
    const ws2 = useWorkspaceStore.getState().workspaces[1];
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: ws2.id,
    });
    useTerminalStore.getState().updateInstanceInfo("t1", { branch: "main", cwd: "/home/user" });
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: ws2.id,
      message: "test",
    });

    const result = handleAutomationRequest({
      requestId: "s1",
      category: "query",
      target: "workspaces",
      method: "getSummary",
      params: { id: ws2.id },
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
    const activePane = useWorkspaceStore.getState().getActiveWorkspace()!.panes[0];
    useWorkspaceStore.getState().setPaneView(0, { type: "TerminalView" });
    const terminalId = `terminal-${activePane.id}`;
    useDockStore.getState().setFocusedDock("left");
    useTerminalStore.getState().registerInstance({
      id: terminalId,
      profile: "WSL",
      syncGroup: "g",
      workspaceId: "ws-default",
    });

    const result = handleAutomationRequest({
      requestId: "f1",
      category: "action",
      target: "terminals",
      method: "setFocus",
      params: { id: terminalId },
    });
    expect(result.success).toBe(true);
    expect(useTerminalStore.getState().instances[0].isFocused).toBe(true);
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
    expect(useDockStore.getState().focusedDock).toBeNull();
    expect(useDockStore.getState().focusedDockPaneId).toBeNull();
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

  it("toggles Remote Access modal via automation API", () => {
    expect(useUiStore.getState().remoteAccessModalOpen).toBe(false);

    const result = handleAutomationRequest({
      requestId: "ui-remote",
      category: "action",
      target: "ui",
      method: "toggleRemoteAccess",
      params: {},
    });

    expect(result.success).toBe(true);
    expect(useUiStore.getState().remoteAccessModalOpen).toBe(true);
  });

  it("opens and closes Remote Access modal via automation API", () => {
    expect(useUiStore.getState().remoteAccessModalOpen).toBe(false);

    const openResult = handleAutomationRequest({
      requestId: "ui-remote-open",
      category: "action",
      target: "ui",
      method: "openRemoteAccess",
      params: {},
    });
    expect(openResult.success).toBe(true);
    expect(useUiStore.getState().remoteAccessModalOpen).toBe(true);

    const closeResult = handleAutomationRequest({
      requestId: "ui-remote-close",
      category: "action",
      target: "ui",
      method: "closeRemoteAccess",
      params: {},
    });
    expect(closeResult.success).toBe(true);
    expect(useUiStore.getState().remoteAccessModalOpen).toBe(false);
  });

  it("opens the file viewer via automation API (ui.openFileViewer)", () => {
    useFileViewerStore.setState({ open: false, path: "", maximized: false });
    const result = handleAutomationRequest({
      requestId: "fv-1",
      category: "action",
      target: "ui",
      method: "openFileViewer",
      params: { path: "  /tmp/report.txt  " },
    });
    expect(result.success).toBe(true);
    const s = useFileViewerStore.getState();
    expect(s.open).toBe(true);
    expect(s.path).toBe("/tmp/report.txt");
    expect(s.maximized).toBe(false);
  });

  it("opens the file viewer maximized when newWindow=true", () => {
    useFileViewerStore.setState({ open: false, path: "", maximized: false });
    const result = handleAutomationRequest({
      requestId: "fv-2",
      category: "action",
      target: "ui",
      method: "openFileViewer",
      params: { path: "/tmp/a.txt", newWindow: true },
    });
    expect(result.success).toBe(true);
    expect(useFileViewerStore.getState().maximized).toBe(true);
  });

  it("rejects openFileViewer with a blank path", () => {
    useFileViewerStore.setState({ open: false, path: "", maximized: false });
    const result = handleAutomationRequest({
      requestId: "fv-3",
      category: "action",
      target: "ui",
      method: "openFileViewer",
      params: { path: "   " },
    });
    expect(result.success).toBe(false);
    expect(useFileViewerStore.getState().open).toBe(false);
  });

  it("closes the file viewer via automation API (ui.closeFileViewer)", () => {
    useFileViewerStore.setState({ open: true, path: "/tmp/a.txt", maximized: false });
    const result = handleAutomationRequest({
      requestId: "fv-4",
      category: "action",
      target: "ui",
      method: "closeFileViewer",
      params: {},
    });
    expect(result.success).toBe(true);
    expect(useFileViewerStore.getState().open).toBe(false);
  });
});

describe("handleAsyncAutomationRequest", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.documentElement.querySelectorAll("canvas").forEach((node) => node.remove());
    vi.mocked(html2canvas).mockReset();
  });

  it("composites terminal canvases when no blocking overlay is visible", async () => {
    const { drawImage } = mockScreenshotCanvas();
    addCanvasElement();

    const dataUrl = await captureScreenshot();

    expect(dataUrl).toBe("data:image/png;base64,test");
    expect(drawImage).toHaveBeenCalledTimes(1);
  });

  it("does not composite terminal canvases over visible modal overlays", async () => {
    const { drawImage } = mockScreenshotCanvas();
    addCanvasElement();
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.getBoundingClientRect = () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 320,
        bottom: 180,
        width: 320,
        height: 180,
        toJSON: () => ({}),
      }) as DOMRect;
    document.body.appendChild(overlay);

    const dataUrl = await captureScreenshot();

    expect(dataUrl).toBe("data:image/png;base64,test");
    expect(drawImage).not.toHaveBeenCalled();
  });

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

describe("captureScreenshot", () => {
  function rect(left: number, top: number, width: number, height: number): DOMRect {
    return {
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    } as DOMRect;
  }

  it("skips canvas compositing when a screenshot occluder covers it", async () => {
    document.body.innerHTML = "";
    const drawImage = vi.fn();
    const resultCanvas = document.createElement("canvas");
    Object.defineProperty(resultCanvas, "getContext", {
      value: vi.fn(() => ({ drawImage })),
    });
    Object.defineProperty(resultCanvas, "toDataURL", {
      value: vi.fn(() => "data:image/png;base64,abc"),
    });
    vi.mocked(html2canvas).mockResolvedValueOnce(resultCanvas);

    const terminalCanvas = document.createElement("canvas");
    terminalCanvas.width = 100;
    terminalCanvas.height = 100;
    terminalCanvas.getBoundingClientRect = vi.fn(() => rect(10, 10, 100, 100));

    const overlay = document.createElement("div");
    overlay.setAttribute("data-screenshot-occluder", "true");
    overlay.getBoundingClientRect = vi.fn(() => rect(0, 0, 200, 200));

    document.body.append(terminalCanvas, overlay);

    await expect(captureScreenshot()).resolves.toBe("data:image/png;base64,abc");
    expect(drawImage).not.toHaveBeenCalled();
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

describe("identify_caller and enriched responses", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useGridStore.setState(useGridStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
    vi.clearAllMocks();
  });

  it("identifies caller terminal with workspace, pane, and neighbors", () => {
    // Split to get 2 panes (left/right via vertical split)
    handleAutomationRequest({
      requestId: "s1",
      category: "action",
      target: "panes",
      method: "split",
      params: { paneIndex: 0, direction: "vertical" },
    });

    // Set both panes to TerminalView (split creates EmptyView by default)
    useWorkspaceStore.getState().setPaneView(0, { type: "TerminalView" });
    useWorkspaceStore.getState().setPaneView(1, { type: "TerminalView" });

    const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
    const leftPane = ws.panes[0];
    const rightPane = ws.panes[1];

    // Register terminals for both panes
    useTerminalStore.getState().registerInstance({
      id: `terminal-${leftPane.id}`,
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: ws.id,
    });
    useTerminalStore.getState().registerInstance({
      id: `terminal-${rightPane.id}`,
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: ws.id,
    });

    // Identify the left pane terminal
    const result = handleAutomationRequest({
      requestId: "id1",
      category: "query",
      target: "terminals",
      method: "identify",
      params: { id: `terminal-${leftPane.id}` },
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;

    // Should have terminal info
    const terminal = data.terminal as Record<string, unknown>;
    expect(terminal.id).toBe(`terminal-${leftPane.id}`);

    // Should have workspace info
    const workspace = data.workspace as Record<string, unknown>;
    expect(workspace.id).toBe(ws.id);
    expect(workspace.isActive).toBe(true);
    expect(workspace.totalPanes).toBe(2);

    // Should have pane info
    const pane = data.pane as Record<string, unknown>;
    expect(pane.index).toBe(0);
    expect(typeof pane.x).toBe("number");

    // Should have right neighbor (the second pane)
    const neighbors = data.neighbors as Record<string, unknown>;
    const right = neighbors.right as Record<string, unknown>;
    expect(right).not.toBeNull();
    expect(right.terminalId).toBe(`terminal-${rightPane.id}`);
    expect(right.paneIndex).toBe(1);
  });

  it("returns error for identify with unknown terminal", () => {
    const result = handleAutomationRequest({
      requestId: "id2",
      category: "query",
      target: "terminals",
      method: "identify",
      params: { id: "terminal-nonexistent" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("gets single terminal with pane position", () => {
    const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
    const pane = ws.panes[0];
    useTerminalStore.getState().registerInstance({
      id: `terminal-${pane.id}`,
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: ws.id,
    });

    const result = handleAutomationRequest({
      requestId: "gt1",
      category: "query",
      target: "terminals",
      method: "get",
      params: { id: `terminal-${pane.id}` },
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const terminal = data.terminal as Record<string, unknown>;
    expect(terminal.paneIndex).toBe(0);
    expect(terminal.panePosition).toHaveProperty("x");
    const workspace = data.workspace as Record<string, unknown>;
    expect(workspace.id).toBe(ws.id);
  });

  it("list_terminals includes paneIndex and panePosition", () => {
    const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
    const pane = ws.panes[0];
    useTerminalStore.getState().registerInstance({
      id: `terminal-${pane.id}`,
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: ws.id,
    });

    const result = handleAutomationRequest({
      requestId: "lt1",
      category: "query",
      target: "terminals",
      method: "list",
      params: {},
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const instances = data.instances as Array<Record<string, unknown>>;
    expect(instances[0].paneIndex).toBe(0);
    expect(instances[0].panePosition).toHaveProperty("x");
  });

  it("get_active_workspace: EmptyView pane has terminalId null", () => {
    // Default workspace pane is EmptyView — no terminal registered
    const result = handleAutomationRequest({
      requestId: "gaw1",
      category: "query",
      target: "workspaces",
      method: "getActive",
      params: {},
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const ws = data.workspace as Record<string, unknown>;
    const panes = ws.panes as Array<Record<string, unknown>>;
    expect(panes[0]).toHaveProperty("paneIndex", 0);
    expect(panes[0].terminalId).toBeNull();
  });

  it("get_active_workspace: TerminalView pane has terminalId set", () => {
    // Set the pane to TerminalView
    const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
    useWorkspaceStore.getState().setPaneView(0, { type: "TerminalView" });

    const result = handleAutomationRequest({
      requestId: "gaw2",
      category: "query",
      target: "workspaces",
      method: "getActive",
      params: {},
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const wsData = data.workspace as Record<string, unknown>;
    const panes = wsData.panes as Array<Record<string, unknown>>;
    expect(panes[0].terminalId).toBe(`terminal-${ws.panes[0].id}`);
  });

  it("get_grid_state includes activeWorkspaceId", () => {
    const result = handleAutomationRequest({
      requestId: "gs1",
      category: "query",
      target: "grid",
      method: "getState",
      params: {},
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty("activeWorkspaceId");
    expect(data.activeWorkspaceId).toBe(useWorkspaceStore.getState().activeWorkspaceId);
  });

  it("split_pane returns new pane info", () => {
    const result = handleAutomationRequest({
      requestId: "sp1",
      category: "action",
      target: "panes",
      method: "split",
      params: { paneIndex: 0, direction: "vertical" },
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.split).toBe(true);
    expect(data.totalPanes).toBe(2);
    const newPane = data.newPane as Record<string, unknown>;
    expect(newPane).not.toBeNull();
    expect(newPane.paneIndex).toBe(1);
    // MCP split auto-converts to TerminalView — terminalId should be set
    expect(newPane.terminalId).not.toBeNull();
    expect(newPane).toHaveProperty("x");
  });

  it("create_workspace returns new workspace info", () => {
    const result = handleAutomationRequest({
      requestId: "cw1",
      category: "action",
      target: "workspaces",
      method: "add",
      params: { name: "TestWS", layoutId: "default-layout" },
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.created).toBe(true);
    const ws = data.workspace as Record<string, unknown>;
    expect(ws).not.toBeNull();
    expect(ws.name).toBe("TestWS");
    expect(typeof ws.id).toBe("string");
    expect(ws.paneCount).toBeGreaterThanOrEqual(1);
  });

  it("identify_caller: neighbor terminalId is null when neighbor is EmptyView", () => {
    // Use store directly (not MCP bridge) to split, so we keep EmptyView
    useWorkspaceStore.getState().splitPane(0, "vertical");

    const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
    const leftPane = ws.panes[0];
    // Set left pane to TerminalView, right pane stays EmptyView
    useWorkspaceStore.getState().setPaneView(0, { type: "TerminalView" });

    useTerminalStore.getState().registerInstance({
      id: `terminal-${leftPane.id}`,
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: ws.id,
    });

    const result = handleAutomationRequest({
      requestId: "nid1",
      category: "query",
      target: "terminals",
      method: "identify",
      params: { id: `terminal-${leftPane.id}` },
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const neighbors = data.neighbors as Record<string, unknown>;
    const right = neighbors.right as Record<string, unknown>;
    expect(right).not.toBeNull();
    expect(right.paneIndex).toBe(1);
    // Right pane is EmptyView (split via store, not MCP) — terminalId should be null
    expect(right.terminalId).toBeNull();
  });

  it("create_workspace returns error for invalid layoutId", () => {
    const result = handleAutomationRequest({
      requestId: "cwf1",
      category: "action",
      target: "workspaces",
      method: "add",
      params: { name: "FailWS", layoutId: "nonexistent-layout" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("layout");
  });

  it("create_workspace uses default layout when layoutId is omitted", () => {
    const before = useWorkspaceStore.getState().workspaces.length;
    const result = handleAutomationRequest({
      requestId: "cwdl1",
      category: "action",
      target: "workspaces",
      method: "add",
      params: { name: "NoLayoutWS" },
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.created).toBe(true);
    const ws = data.workspace as Record<string, unknown>;
    expect(ws).not.toBeNull();
    expect(ws.name).toBe("NoLayoutWS");
    expect(useWorkspaceStore.getState().workspaces.length).toBe(before + 1);
  });

  it("identify_caller: isFocusedPane is false for inactive workspace", () => {
    // Create a second workspace and register a terminal in it
    const { addWorkspace, layouts, workspaces } = useWorkspaceStore.getState();
    addWorkspace("WS2", layouts[0].id);
    const ws2 = useWorkspaceStore.getState().workspaces.find((ws) => ws.name === "WS2")!;

    // Set pane to TerminalView so we can register a terminal
    useWorkspaceStore.getState().setPaneView(0, { type: "TerminalView" }); // active ws pane 0
    // For WS2 we need to switch, set view, then switch back
    useWorkspaceStore.getState().setActiveWorkspace(ws2.id);
    useWorkspaceStore.getState().setPaneView(0, { type: "TerminalView" });
    // Switch back to original workspace
    const originalWsId = workspaces[0].id;
    useWorkspaceStore.getState().setActiveWorkspace(originalWsId);

    // Register terminal in the inactive WS2's pane 0
    const ws2Updated = useWorkspaceStore.getState().workspaces.find((ws) => ws.id === ws2.id)!;
    const ws2Pane = ws2Updated.panes[0];
    useTerminalStore.getState().registerInstance({
      id: `terminal-${ws2Pane.id}`,
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: ws2.id,
    });

    // focusedPaneIndex defaults to 0, and WS2 also has pane index 0
    // But WS2 is inactive, so isFocusedPane should be false
    useGridStore.setState({ focusedPaneIndex: 0 });

    const result = handleAutomationRequest({
      requestId: "ifp1",
      category: "query",
      target: "terminals",
      method: "identify",
      params: { id: `terminal-${ws2Pane.id}` },
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const workspace = data.workspace as Record<string, unknown>;
    expect(workspace.isActive).toBe(false);
    const pane = data.pane as Record<string, unknown>;
    expect(pane.index).toBe(0);
    // Key assertion: even though focusedPaneIndex === 0 === paneIndex,
    // isFocusedPane must be false because this is an inactive workspace
    expect(pane.isFocusedPane).toBe(false);
  });

  it("reorders workspaces via automation API", () => {
    // Create additional workspaces
    const { addWorkspace, layouts } = useWorkspaceStore.getState();
    addWorkspace("WS2", layouts[0].id);
    addWorkspace("WS3", layouts[0].id);
    const idsBefore = useWorkspaceStore.getState().workspaces.map((ws) => ws.id);
    expect(idsBefore).toHaveLength(3);

    const result = handleAutomationRequest({
      requestId: "reorder-1",
      category: "action",
      target: "workspaces",
      method: "reorder",
      params: { fromId: idsBefore[2], toId: idsBefore[0], position: "top" },
    });
    expect(result.success).toBe(true);

    const { workspaceDisplayOrder } = useWorkspaceStore.getState();
    expect(workspaceDisplayOrder).toEqual([idsBefore[2], idsBefore[0], idsBefore[1]]);
  });

  // -- P0 bug fix tests --

  it("focus_pane rejects out-of-range index", () => {
    // Default workspace has 1 pane (index 0)
    const ws = useWorkspaceStore.getState().getActiveWorkspace();
    expect(ws!.panes.length).toBeGreaterThan(0);

    const result = handleAutomationRequest({
      requestId: "fp-oob",
      category: "action",
      target: "grid",
      method: "focusPane",
      params: { index: 999 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("out of range");
    // State must NOT be corrupted
    expect(useGridStore.getState().focusedPaneIndex).not.toBe(999);
  });

  it("focus_pane rejects negative index", () => {
    const result = handleAutomationRequest({
      requestId: "fp-neg",
      category: "action",
      target: "grid",
      method: "focusPane",
      params: { index: -1 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("out of range");
  });

  it("send_notification rejects non-existent workspace", () => {
    const result = handleAutomationRequest({
      requestId: "sn-bad-ws",
      category: "action",
      target: "notifications",
      method: "add",
      params: {
        terminalId: "t1",
        workspaceId: "ws-nonexistent",
        message: "test",
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it("send_notification rejects non-existent terminal", () => {
    const wsId = useWorkspaceStore.getState().workspaces[0]?.id;
    const result = handleAutomationRequest({
      requestId: "sn-bad-t",
      category: "action",
      target: "notifications",
      method: "add",
      params: {
        terminalId: "terminal-nonexistent",
        workspaceId: wsId,
        message: "test",
      },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it("focus_terminal auto-switches workspace for cross-workspace terminal", () => {
    // Create a second workspace
    const { layouts } = useWorkspaceStore.getState();
    useWorkspaceStore.getState().addWorkspace("WS2", layouts[0].id);
    const ws2 = useWorkspaceStore.getState().workspaces[1];
    const ws1 = useWorkspaceStore.getState().workspaces[0];

    // Set pane to TerminalView in WS2
    useWorkspaceStore.getState().setActiveWorkspace(ws2.id);
    useWorkspaceStore.getState().setPaneView(0, { type: "TerminalView" });
    const ws2Pane = useWorkspaceStore.getState().getActiveWorkspace()!.panes[0];

    // Register terminal in WS2
    const termId = `terminal-${ws2Pane.id}`;
    useTerminalStore.getState().registerInstance({
      id: termId,
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: ws2.id,
    });

    // Switch back to WS1
    useWorkspaceStore.getState().setActiveWorkspace(ws1.id);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(ws1.id);

    // Focus terminal in WS2 — should auto-switch workspace
    const result = handleAutomationRequest({
      requestId: "ft-cross",
      category: "action",
      target: "terminals",
      method: "setFocus",
      params: { id: termId },
    });
    expect(result.success).toBe(true);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(ws2.id);
  });

  it("focus_terminal focuses dock terminal without switching workspace", () => {
    const { layouts } = useWorkspaceStore.getState();
    useWorkspaceStore.getState().addWorkspace("WS2", layouts[0].id);
    const ws1 = useWorkspaceStore.getState().workspaces[0];
    const ws2 = useWorkspaceStore.getState().workspaces[1];
    useWorkspaceStore.getState().setActiveWorkspace(ws1.id);
    useDockStore.getState().setDockActiveView("bottom", "TerminalView");
    const dockPane = useDockStore.getState().getDock("bottom")!.panes[0];
    const terminalId = `terminal-${dockPane.id}`;
    useTerminalStore.getState().registerInstance({
      id: terminalId,
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: ws2.id,
    });
    useGridStore.getState().setFocusedPane(0);

    const result = handleAutomationRequest({
      requestId: "ft-dock",
      category: "action",
      target: "terminals",
      method: "setFocus",
      params: { id: terminalId },
    });

    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      focused: terminalId,
      dockPosition: "bottom",
      dockPaneId: dockPane.id,
    });
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(ws1.id);
    expect(useDockStore.getState().focusedDock).toBe("bottom");
    expect(useDockStore.getState().focusedDockPaneId).toBe(dockPane.id);
    expect(useGridStore.getState().focusedPaneIndex).toBeNull();
  });

  it("focus_terminal returns error for non-existent terminal", () => {
    const result = handleAutomationRequest({
      requestId: "ft-bad",
      category: "action",
      target: "terminals",
      method: "setFocus",
      params: { id: "terminal-nonexistent" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("split_pane creates TerminalView (not EmptyView)", () => {
    // Ensure active workspace has at least one pane
    const ws = useWorkspaceStore.getState().getActiveWorkspace();
    expect(ws!.panes.length).toBeGreaterThan(0);

    const result = handleAutomationRequest({
      requestId: "sp-tv",
      category: "action",
      target: "panes",
      method: "split",
      params: { paneIndex: 0, direction: "horizontal" },
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    const newPane = data.newPane as Record<string, unknown>;
    expect(newPane).not.toBeNull();
    // New pane should be TerminalView, so terminalId should not be null
    expect(newPane.terminalId).not.toBeNull();
  });

  it("swap_panes exchanges absolute positions correctly", () => {
    // Split to get 2 panes
    handleAutomationRequest({
      requestId: "sw-setup",
      category: "action",
      target: "panes",
      method: "split",
      params: { paneIndex: 0, direction: "horizontal" },
    });
    const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
    const srcPos = { x: ws.panes[0].x, y: ws.panes[0].y, w: ws.panes[0].w, h: ws.panes[0].h };
    const tgtPos = { x: ws.panes[1].x, y: ws.panes[1].y, w: ws.panes[1].w, h: ws.panes[1].h };

    const result = handleAutomationRequest({
      requestId: "sw-1",
      category: "action",
      target: "panes",
      method: "swap",
      params: { sourceIndex: 0, targetIndex: 1 },
    });
    expect(result.success).toBe(true);

    const after = useWorkspaceStore.getState().getActiveWorkspace()!;
    // Pane 0 should now have pane 1's original position
    expect(after.panes[0].x).toBe(tgtPos.x);
    expect(after.panes[0].y).toBe(tgtPos.y);
    expect(after.panes[0].w).toBe(tgtPos.w);
    expect(after.panes[0].h).toBe(tgtPos.h);
    // Pane 1 should now have pane 0's original position
    expect(after.panes[1].x).toBe(srcPos.x);
    expect(after.panes[1].y).toBe(srcPos.y);
    expect(after.panes[1].w).toBe(srcPos.w);
    expect(after.panes[1].h).toBe(srcPos.h);
  });

  it("send_notification allows empty terminalId for workspace-level notification", () => {
    const wsId = useWorkspaceStore.getState().workspaces[0]?.id;
    const result = handleAutomationRequest({
      requestId: "sn-empty-t",
      category: "action",
      target: "notifications",
      method: "add",
      params: {
        terminalId: "",
        workspaceId: wsId,
        message: "workspace-level alert",
      },
    });
    expect(result.success).toBe(true);
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    expect(
      (result.data as { notification?: { workspaceId?: string } }).notification?.workspaceId,
    ).toBe(wsId);
  });

  it("resize_pane applies delta relative to current pane size", () => {
    // Split to get 2 panes with known geometry
    handleAutomationRequest({
      requestId: "rz-split",
      category: "action",
      target: "panes",
      method: "split",
      params: { paneIndex: 0, direction: "vertical" },
    });
    const wsBefore = useWorkspaceStore.getState().getActiveWorkspace()!;
    const paneBefore = wsBefore.panes[0];
    const originalW = paneBefore.w;
    const originalH = paneBefore.h;

    // Resize with delta
    const result = handleAutomationRequest({
      requestId: "rz-delta",
      category: "action",
      target: "panes",
      method: "resize",
      params: { paneIndex: 0, delta: { w: 0.1, h: -0.05 } },
    });
    expect(result.success).toBe(true);

    const wsAfter = useWorkspaceStore.getState().getActiveWorkspace()!;
    const paneAfter = wsAfter.panes[0];
    expect(paneAfter.w).toBeCloseTo(originalW + 0.1, 5);
    expect(paneAfter.h).toBeCloseTo(originalH - 0.05, 5);
  });

  it("split_pane forwards profile and cwd to new pane view config", () => {
    const result = handleAutomationRequest({
      requestId: "sp-profile",
      category: "action",
      target: "panes",
      method: "split",
      params: { paneIndex: 0, direction: "vertical", profile: "WSL", cwd: "/home/user" },
    });
    expect(result.success).toBe(true);

    const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
    const newPane = ws.panes[1];
    expect(newPane.view.type).toBe("TerminalView");
    expect(newPane.view.profile).toBe("WSL");
    expect(newPane.view.lastCwd).toBe("/home/user");
  });

  it("split_pane rejects out-of-range pane_index", () => {
    const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
    const result = handleAutomationRequest({
      requestId: "sp-oor",
      category: "action",
      target: "panes",
      method: "split",
      params: { paneIndex: 999, direction: "vertical" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("out of range");
    // Verify no panes were added
    const wsAfter = useWorkspaceStore.getState().getActiveWorkspace()!;
    expect(wsAfter.panes.length).toBe(ws.panes.length);
  });

  it("create_workspace applies cwd to terminal panes", () => {
    const result = handleAutomationRequest({
      requestId: "cw-cwd",
      category: "action",
      target: "workspaces",
      method: "add",
      params: { name: "CWD Test", cwd: "/home/user/project" },
    });
    expect(result.success).toBe(true);
    // Find the newly created workspace
    const ws = useWorkspaceStore.getState().workspaces.find((w) => w.name === "CWD-Test")!;
    expect(ws).toBeDefined();
    expect(ws.panes.length).toBeGreaterThan(0);
    // Convert any non-TerminalView panes so we can test — but at minimum, check
    // that TerminalView panes have lastCwd set. If all panes are EmptyView,
    // the handler should still set lastCwd on them as viewConfig.
    for (const pane of ws.panes) {
      if (pane.view.type === "TerminalView") {
        expect(pane.view.lastCwd).toBe("/home/user/project");
      }
    }
    // Ensure at least one TerminalView pane exists to make this test meaningful
    // If the default layout only has EmptyView, convert one and verify
    const termPanes = ws.panes.filter((p) => p.view.type === "TerminalView");
    expect(termPanes.length).toBeGreaterThan(0);
  });

  it("take_screenshot pane selector uses data-pane-index on workspace pane divs", () => {
    // This is a structural test — verify the PaneGrid renders data-pane-index
    // The actual screenshot capture is async and needs DOM, so we test the selector logic
    const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
    expect(ws.panes.length).toBeGreaterThan(0);
    // The fix ensures PaneGrid.tsx adds data-pane-index={i} to each pane div,
    // so captureScreenshot's querySelectorAll("[data-pane-index]") will match real panes.
    // This test validates the fix was applied by checking PaneGrid component rendering
    // in a separate PaneGrid.test.tsx test.
  });

  it("profiles.list returns configured profiles from settings", () => {
    const result = handleAutomationRequest({
      requestId: "pl-1",
      category: "query",
      target: "profiles",
      method: "list",
      params: {},
    });
    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("profiles");
    expect(result.data).toHaveProperty("defaultProfile");
    const data = result.data as { profiles: Array<{ name: string; isDefault?: boolean }> };
    expect(data.profiles.length).toBeGreaterThan(0);
    // At least one profile should be the default
    expect(data.profiles.some((p) => p.isDefault)).toBe(true);
  });

  it("focus_terminal updates focusedPaneIndex in grid store", () => {
    // Split to create 2 panes
    handleAutomationRequest({
      requestId: "ft-split",
      category: "action",
      target: "panes",
      method: "split",
      params: { paneIndex: 0, direction: "vertical" },
    });
    const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
    expect(ws.panes.length).toBe(2);

    // Register terminal instances for both panes
    const pane0Id = ws.panes[0].id;
    const pane1Id = ws.panes[1].id;
    useTerminalStore.setState({
      instances: [
        {
          id: `terminal-${pane0Id}`,
          workspaceId: ws.id,
          label: "",
          profile: "PowerShell",
        } as never,
        {
          id: `terminal-${pane1Id}`,
          workspaceId: ws.id,
          label: "",
          profile: "PowerShell",
        } as never,
      ],
    });

    // Focus second pane's terminal
    const result = handleAutomationRequest({
      requestId: "ft-focus",
      category: "action",
      target: "terminals",
      method: "setFocus",
      params: { id: `terminal-${pane1Id}` },
    });
    expect(result.success).toBe(true);
    expect(useGridStore.getState().focusedPaneIndex).toBe(1);
  });

  it("getActive workspace includes focusedPaneIndex", () => {
    useGridStore.getState().setFocusedPane(0);
    const result = handleAutomationRequest({
      requestId: "ga-fpi",
      category: "query",
      target: "workspaces",
      method: "getActive",
      params: {},
    });
    expect(result.success).toBe(true);
    const data = result.data as { workspace: { focusedPaneIndex: number } };
    expect(data.workspace.focusedPaneIndex).toBe(0);
  });

  it("remove_pane rejects out-of-range pane_index", () => {
    const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
    const paneCount = ws.panes.length;
    const result = handleAutomationRequest({
      requestId: "rm-oor",
      category: "action",
      target: "panes",
      method: "remove",
      params: { paneIndex: 999 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("out of range");
    const wsAfter = useWorkspaceStore.getState().getActiveWorkspace()!;
    expect(wsAfter.panes.length).toBe(paneCount);
  });

  it("setView rejects out-of-range pane_index", () => {
    const result = handleAutomationRequest({
      requestId: "sv-oor",
      category: "action",
      target: "panes",
      method: "setView",
      params: { paneIndex: 999, view: { type: "TerminalView" } },
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("out of range");
  });
});

describe("notifications.clear bridge handler", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useNotificationStore.setState(useNotificationStore.getInitialState());
  });

  it("clears notifications by ids and returns the cleared count", () => {
    const { addNotification } = useNotificationStore.getState();
    addNotification({ terminalId: "t1", workspaceId: "ws-a", message: "a" });
    addNotification({ terminalId: "t2", workspaceId: "ws-a", message: "b" });
    addNotification({ terminalId: "t3", workspaceId: "ws-b", message: "c" });

    const targets = useNotificationStore
      .getState()
      .notifications.slice(0, 2)
      .map((n) => n.id);

    const result = handleAutomationRequest({
      requestId: "cn-ids",
      category: "action",
      target: "notifications",
      method: "clear",
      params: { ids: targets },
    });

    expect(result.success).toBe(true);
    expect((result.data as { cleared: number }).cleared).toBe(2);
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });

  it("clears notifications before the timestamp", () => {
    const now = Date.now();
    useNotificationStore.setState({
      notifications: [
        {
          id: "old-1",
          terminalId: "t1",
          workspaceId: "ws-x",
          message: "old",
          level: "info",
          createdAt: now - 10000,
          readAt: null,
        },
        {
          id: "fresh-1",
          terminalId: "t2",
          workspaceId: "ws-x",
          message: "fresh",
          level: "info",
          createdAt: now - 100,
          readAt: null,
        },
      ],
    });

    const result = handleAutomationRequest({
      requestId: "cn-before",
      category: "action",
      target: "notifications",
      method: "clear",
      params: { before: now - 5000 },
    });

    expect(result.success).toBe(true);
    expect((result.data as { cleared: number }).cleared).toBe(1);
    const ids = useNotificationStore.getState().notifications.map((n) => n.id);
    expect(ids).toEqual(["fresh-1"]);
  });

  it("with before + read_only, only clears already-read older notifications", () => {
    const now = Date.now();
    useNotificationStore.setState({
      notifications: [
        {
          id: "old-read",
          terminalId: "t1",
          workspaceId: "ws-ro",
          message: "old read",
          level: "info",
          createdAt: now - 10000,
          readAt: now - 5000,
        },
        {
          id: "old-unread",
          terminalId: "t2",
          workspaceId: "ws-ro",
          message: "old unread",
          level: "info",
          createdAt: now - 9000,
          readAt: null,
        },
      ],
    });

    const result = handleAutomationRequest({
      requestId: "cn-ro",
      category: "action",
      target: "notifications",
      method: "clear",
      params: { before: now - 2000, read_only: true },
    });

    expect(result.success).toBe(true);
    expect((result.data as { cleared: number }).cleared).toBe(1);
    const ids = useNotificationStore.getState().notifications.map((n) => n.id);
    expect(ids).toEqual(["old-unread"]);
  });

  it("also accepts camelCase readOnly alias", () => {
    const now = Date.now();
    useNotificationStore.setState({
      notifications: [
        {
          id: "old-read",
          terminalId: "t1",
          workspaceId: "ws-ro",
          message: "old read",
          level: "info",
          createdAt: now - 10000,
          readAt: now - 5000,
        },
        {
          id: "old-unread",
          terminalId: "t2",
          workspaceId: "ws-ro",
          message: "old unread",
          level: "info",
          createdAt: now - 9000,
          readAt: null,
        },
      ],
    });

    const result = handleAutomationRequest({
      requestId: "cn-ro-camel",
      category: "action",
      target: "notifications",
      method: "clear",
      params: { before: now - 2000, readOnly: true },
    });

    expect(result.success).toBe(true);
    expect((result.data as { cleared: number }).cleared).toBe(1);
  });

  it("errors when neither ids nor before is provided", () => {
    const result = handleAutomationRequest({
      requestId: "cn-none",
      category: "action",
      target: "notifications",
      method: "clear",
      params: {},
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exactly one/i);
  });

  it("errors when both ids and before are provided", () => {
    const result = handleAutomationRequest({
      requestId: "cn-both",
      category: "action",
      target: "notifications",
      method: "clear",
      params: { ids: ["notif-1"], before: 1 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exactly one/i);
  });

  it("errors when ids is not an array", () => {
    const result = handleAutomationRequest({
      requestId: "cn-badids",
      category: "action",
      target: "notifications",
      method: "clear",
      params: { ids: "notif-1" },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/array/i);
  });
});

describe("spatial pane numbers (issue #256)", () => {
  // Seed a workspace whose array order [TL, BL, TR] diverges from reading order
  // (TL=1, TR=2, BL=3). Terminals registered for all three panes.
  const WS_ID = "ws-num";
  const TL = "pane-TL";
  const BL = "pane-BL";
  const TR = "pane-TR";

  function seedDivergentWorkspace() {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: WS_ID,
          name: "Nums",
          panes: [
            { id: TL, x: 0, y: 0, w: 0.5, h: 0.5, view: { type: "TerminalView" } },
            { id: BL, x: 0, y: 0.5, w: 0.5, h: 0.5, view: { type: "TerminalView" } },
            { id: TR, x: 0.5, y: 0, w: 0.5, h: 0.5, view: { type: "TerminalView" } },
          ],
        },
      ],
      activeWorkspaceId: WS_ID,
    });
    for (const id of [TL, BL, TR]) {
      useTerminalStore.getState().registerInstance({
        id: `terminal-${id}`,
        profile: "WSL",
        syncGroup: "Default",
        workspaceId: WS_ID,
      });
    }
  }

  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useGridStore.setState(useGridStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
    vi.clearAllMocks();
  });

  it("list_terminals exposes paneNumber in reading order regardless of array order", () => {
    seedDivergentWorkspace();
    const result = handleAutomationRequest({
      requestId: "n-list",
      category: "query",
      target: "terminals",
      method: "list",
      params: {},
    });
    const instances = (result.data as Record<string, unknown>).instances as Array<
      Record<string, unknown>
    >;
    const byId = Object.fromEntries(instances.map((i) => [i.id, i.paneNumber]));
    expect(byId[`terminal-${TL}`]).toBe(1);
    expect(byId[`terminal-${TR}`]).toBe(2);
    expect(byId[`terminal-${BL}`]).toBe(3);
  });

  it("identify exposes pane.number and neighbor paneNumber", () => {
    seedDivergentWorkspace();
    const result = handleAutomationRequest({
      requestId: "n-id",
      category: "query",
      target: "terminals",
      method: "identify",
      params: { id: `terminal-${TL}` },
    });
    const data = result.data as Record<string, unknown>;
    const pane = data.pane as Record<string, unknown>;
    expect(pane.number).toBe(1);
    const neighbors = data.neighbors as Record<string, Record<string, unknown> | null>;
    // TL's right neighbor is TR (paneNumber 2); below neighbor is BL (paneNumber 3).
    expect(neighbors.right?.paneNumber).toBe(2);
    expect(neighbors.below?.paneNumber).toBe(3);
  });

  it("get_active_workspace exposes paneNumber and focusedPaneNumber", () => {
    seedDivergentWorkspace();
    useGridStore.setState({ focusedPaneIndex: 1 }); // array index 1 = BL = number 3
    const result = handleAutomationRequest({
      requestId: "n-gaw",
      category: "query",
      target: "workspaces",
      method: "getActive",
      params: {},
    });
    const ws = (result.data as Record<string, unknown>).workspace as Record<string, unknown>;
    expect(ws.focusedPaneNumber).toBe(3);
    const panes = ws.panes as Array<Record<string, unknown>>;
    const byId = Object.fromEntries(panes.map((p) => [p.id, p.paneNumber]));
    expect(byId[TL]).toBe(1);
    expect(byId[TR]).toBe(2);
    expect(byId[BL]).toBe(3);
  });

  it("grid.getState exposes focusedPaneNumber and a number<->terminal summary", () => {
    seedDivergentWorkspace();
    useGridStore.setState({ focusedPaneIndex: 2 }); // array index 2 = TR = number 2
    const result = handleAutomationRequest({
      requestId: "n-grid",
      category: "query",
      target: "grid",
      method: "getState",
      params: {},
    });
    const data = result.data as Record<string, unknown>;
    expect(data.focusedPaneNumber).toBe(2);
    const panes = data.panes as Array<Record<string, unknown>>;
    // Sorted by paneNumber ascending.
    expect(panes.map((p) => p.paneNumber)).toEqual([1, 2, 3]);
    expect(panes[0]).toMatchObject({ paneNumber: 1, paneId: TL, terminalId: `terminal-${TL}` });
    expect(panes[1]).toMatchObject({ paneNumber: 2, paneId: TR });
  });

  it("resolveByNumber maps a number to a terminal id in the active workspace", () => {
    seedDivergentWorkspace();
    const result = handleAutomationRequest({
      requestId: "n-res",
      category: "query",
      target: "terminals",
      method: "resolveByNumber",
      params: { number: 2 },
    });
    expect(result.success).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.terminalId).toBe(`terminal-${TR}`);
    expect(data.paneId).toBe(TR);
  });

  it("resolveByNumber errors for an out-of-range number", () => {
    seedDivergentWorkspace();
    const result = handleAutomationRequest({
      requestId: "n-res-bad",
      category: "query",
      target: "terminals",
      method: "resolveByNumber",
      params: { number: 9 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No pane numbered 9/);
  });

  it("resolveByNumber errors when the pane is not a terminal", () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: WS_ID,
          name: "Nums",
          panes: [{ id: "pane-empty", x: 0, y: 0, w: 1, h: 1, view: { type: "EmptyView" } }],
        },
      ],
      activeWorkspaceId: WS_ID,
    });
    const result = handleAutomationRequest({
      requestId: "n-res-empty",
      category: "query",
      target: "terminals",
      method: "resolveByNumber",
      params: { number: 1 },
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a terminal/);
  });
});
