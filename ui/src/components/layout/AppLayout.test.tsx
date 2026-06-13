import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/tauri-api", () => ({
  createTerminalSession: vi.fn().mockResolvedValue("t-mock"),
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminalSession: vi.fn().mockResolvedValue(undefined),
  onTerminalOutput: vi.fn().mockResolvedValue(() => {}),
  smartPaste: vi.fn().mockResolvedValue({ pasteType: "none", content: "" }),
  clipboardWriteText: vi.fn().mockResolvedValue(undefined),
  setTerminalCwdSend: vi.fn().mockResolvedValue(undefined),
  setTerminalCwdReceive: vi.fn().mockResolvedValue(undefined),
  updateTerminalSyncGroup: vi.fn().mockResolvedValue(undefined),
  openExternal: vi.fn().mockResolvedValue(undefined),
  loadTerminalOutputCache: vi.fn().mockRejectedValue(new Error("Cache not found: mock")),
  markClaudeTerminal: vi.fn().mockResolvedValue(false),
}));

vi.mock("@/components/views/TerminalView", () => ({
  TerminalView: () => <div data-testid="mock-terminal">Terminal Mock</div>,
}));

import { AppLayout } from "./AppLayout";
import { useDockStore } from "@/stores/dock-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useUiStore } from "@/stores/ui-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useGridStore } from "@/stores/grid-store";

describe("AppLayout", () => {
  beforeEach(() => {
    useDockStore.setState(useDockStore.getInitialState());
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useNotificationStore.setState(useNotificationStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useGridStore.setState(useGridStore.getInitialState());
  });

  it("renders left dock and workspace area by default", () => {
    render(<AppLayout />);
    expect(screen.getByTestId("dock-left")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-area")).toBeInTheDocument();
  });

  it("renders visible docks even without active view (shows EmptyView)", () => {
    render(<AppLayout />);
    // All docks are visible by default — even without activeView they render
    expect(screen.getByTestId("dock-top")).toBeInTheDocument();
    expect(screen.getByTestId("dock-bottom")).toBeInTheDocument();
    expect(screen.getByTestId("dock-right")).toBeInTheDocument();
  });

  it("renders dock with active view set", () => {
    useDockStore.getState().setDockActiveView("right", "SettingsView");
    render(<AppLayout />);
    expect(screen.getByTestId("dock-right")).toBeInTheDocument();
  });

  it("keeps dock in DOM when toggled invisible with dockPersistState on", () => {
    useSettingsStore.setState({
      dock: { ...useSettingsStore.getState().dock, persistState: true },
    });
    useDockStore.getState().toggleDockVisible("left");
    render(<AppLayout />);
    // Dock content remains in DOM (inside 0px grid cell with overflow:hidden)
    expect(screen.getByTestId("dock-left")).toBeInTheDocument();
  });

  it("removes dock from DOM when toggled invisible with dockPersistState off", () => {
    useSettingsStore.setState({
      dock: { ...useSettingsStore.getState().dock, persistState: false },
    });
    useDockStore.getState().toggleDockVisible("left");
    render(<AppLayout />);
    expect(screen.queryByTestId("dock-left")).not.toBeInTheDocument();
  });

  it("does not show settings modal by default", () => {
    render(<AppLayout />);
    expect(screen.queryByTestId("settings-modal")).not.toBeInTheDocument();
  });

  it("shows settings modal when settingsModalOpen is true", () => {
    useUiStore.getState().openSettingsModal();
    render(<AppLayout />);
    expect(screen.getByTestId("settings-modal")).toBeInTheDocument();
  });

  it("closes settings modal when backdrop is clicked", async () => {
    const user = userEvent.setup();
    useUiStore.getState().openSettingsModal();
    render(<AppLayout />);

    const backdrop = screen.getByTestId("settings-modal-backdrop");
    await user.click(backdrop);

    expect(useUiStore.getState().settingsModalOpen).toBe(false);
  });

  // --- Notification Panel Overlay ---

  it("does not show notification panel overlay by default", () => {
    render(<AppLayout />);
    expect(screen.queryByTestId("notification-panel-overlay")).not.toBeInTheDocument();
  });

  it("shows notification panel overlay when notificationPanelOpen is true", () => {
    useUiStore.getState().toggleNotificationPanel();
    render(<AppLayout />);
    expect(screen.getByTestId("notification-panel-overlay")).toBeInTheDocument();
    expect(screen.getByTestId("notification-panel")).toBeInTheDocument();
  });

  it("closes notification panel when backdrop is clicked", async () => {
    const user = userEvent.setup();
    useUiStore.getState().toggleNotificationPanel();
    render(<AppLayout />);

    const backdrop = screen.getByTestId("notification-panel-backdrop");
    await user.click(backdrop);

    expect(useUiStore.getState().notificationPanelOpen).toBe(false);
    expect(screen.queryByTestId("notification-panel-overlay")).not.toBeInTheDocument();
  });

  it("closes notification panel when close button is clicked", async () => {
    const user = userEvent.setup();
    useUiStore.getState().toggleNotificationPanel();
    render(<AppLayout />);

    await user.click(screen.getByTestId("notification-panel-close"));

    expect(useUiStore.getState().notificationPanelOpen).toBe(false);
  });

  // --- Layout Mode Toggle (Issue #6) ---

  it("layout mode toggle does not remount dock components", () => {
    const { rerender } = render(<AppLayout />);
    const dockBefore = screen.getByTestId("dock-left");

    act(() => {
      useDockStore.getState().toggleLayoutMode();
    });
    rerender(<AppLayout />);

    const dockAfter = screen.getByTestId("dock-left");
    expect(dockAfter).toBe(dockBefore); // Same DOM node, not recreated
  });

  it("dock pane IDs remain stable after toggleLayoutMode", () => {
    useDockStore.getState().setDockActiveView("bottom", "TerminalView");
    const paneIdBefore = useDockStore.getState().getDock("bottom")?.panes[0]?.id;

    render(<AppLayout />);
    act(() => {
      useDockStore.getState().toggleLayoutMode();
    });

    const paneIdAfter = useDockStore.getState().getDock("bottom")?.panes[0]?.id;
    expect(paneIdAfter).toBe(paneIdBefore);
  });

  it("notification panel overlay shows only active workspace notifications", () => {
    // Add notifications to active workspace (ws-default) and a second workspace
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "Active WS notification",
    });
    useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
    const ws2Id = useWorkspaceStore.getState().workspaces[1].id;
    useNotificationStore.getState().addNotification({
      terminalId: "t2",
      workspaceId: ws2Id,
      message: "Other WS notification",
    });

    useUiStore.getState().toggleNotificationPanel();
    render(<AppLayout />);

    expect(screen.getByText("Active WS notification")).toBeInTheDocument();
    expect(screen.queryByText("Other WS notification")).not.toBeInTheDocument();
  });

  // --- Notification auto-dismiss on focus/entry (ADR 0010, issue #302) ---
  //
  // 해제는 입력 종류가 아니라 프로그램의 진입/포커스 동작 자체가 트리거다.
  // AppLayout 의 두 effect 가 그 SoT 이며, 모드에 따라 해제 단위가 다르다.

  it("workspace mode: clears active-workspace alerts on entry (issue #302)", () => {
    const wsId = useWorkspaceStore.getState().activeWorkspaceId;
    useSettingsStore.setState((s) => ({
      notifications: { ...s.notifications, dismiss: "workspace" },
    }));
    // 비활성 시점에 도착해 unread 로 남아 있던 알림을 흉내낸다(강제 unread).
    const n = useNotificationStore.getState().addNotification({
      terminalId: "terminal-x",
      workspaceId: wsId,
      message: "build done",
    });
    useNotificationStore.setState((s) => ({
      notifications: s.notifications.map((x) => (x.id === n.id ? { ...x, readAt: null } : x)),
    }));
    expect(useNotificationStore.getState().getUnreadCount(wsId)).toBe(1);

    render(<AppLayout />);

    // 워크스페이스 진입(마운트) 시 자동 해제 effect 가 전체를 읽음 처리.
    expect(useNotificationStore.getState().getUnreadCount(wsId)).toBe(0);
  });

  it("paneFocus mode: focusing a pane clears only that pane's alerts", () => {
    // 같은 워크스페이스에 터미널 pane 2개.
    useWorkspaceStore.getState().setPaneView(0, { type: "TerminalView" });
    useWorkspaceStore.getState().splitPane(0, "horizontal");
    useWorkspaceStore.getState().setPaneView(1, { type: "TerminalView" });
    const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
    const wsId = ws.id;
    const pane0 = ws.panes[0].id;
    const pane1 = ws.panes[1].id;

    useSettingsStore.setState((s) => ({
      notifications: { ...s.notifications, dismiss: "paneFocus" },
    }));
    useGridStore.setState({ focusedPaneIndex: null });

    // 포커스가 없으니 두 알림 모두 unread 로 남는다.
    useNotificationStore.getState().addNotification({
      terminalId: `terminal-${pane0}`,
      workspaceId: wsId,
      message: "p0 done",
    });
    useNotificationStore.getState().addNotification({
      terminalId: `terminal-${pane1}`,
      workspaceId: wsId,
      message: "p1 done",
    });

    render(<AppLayout />);
    expect(useNotificationStore.getState().getUnreadCount(wsId)).toBe(2);

    // pane 0 포커스 → pane 0 알림만 해제, pane 1 은 유지.
    act(() => {
      useGridStore.setState({ focusedPaneIndex: 0 });
    });

    const notifs = useNotificationStore.getState().notifications;
    expect(notifs.find((nf) => nf.message === "p0 done")?.readAt).not.toBeNull();
    expect(notifs.find((nf) => nf.message === "p1 done")?.readAt).toBeNull();
    expect(useNotificationStore.getState().getUnreadCount(wsId)).toBe(1);
  });
});
