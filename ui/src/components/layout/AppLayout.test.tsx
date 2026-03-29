import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

import { AppLayout } from "./AppLayout";
import { useDockStore } from "@/stores/dock-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useUiStore } from "@/stores/ui-store";

describe("AppLayout", () => {
  beforeEach(() => {
    useDockStore.setState(useDockStore.getInitialState());
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useNotificationStore.setState(useNotificationStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
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

  it("hides dock when toggled invisible", () => {
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

    act(() => { useDockStore.getState().toggleLayoutMode(); });
    rerender(<AppLayout />);

    const dockAfter = screen.getByTestId("dock-left");
    expect(dockAfter).toBe(dockBefore); // Same DOM node, not recreated
  });

  it("dock pane IDs remain stable after toggleLayoutMode", () => {
    useDockStore.getState().setDockActiveView("bottom", "TerminalView");
    const paneIdBefore = useDockStore.getState().getDock("bottom")?.panes[0]?.id;

    render(<AppLayout />);
    act(() => { useDockStore.getState().toggleLayoutMode(); });

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
});
