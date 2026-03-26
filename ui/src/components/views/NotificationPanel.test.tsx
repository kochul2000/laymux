import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach } from "vitest";
import { NotificationPanel } from "./NotificationPanel";
import { useNotificationStore } from "@/stores/notification-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useTerminalStore } from "@/stores/terminal-store";

describe("NotificationPanel", () => {
  beforeEach(() => {
    useNotificationStore.setState(useNotificationStore.getInitialState());
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
  });

  it("renders with test id", () => {
    render(<NotificationPanel />);
    expect(screen.getByTestId("notification-panel")).toBeInTheDocument();
  });

  it("shows empty state when no notifications", () => {
    render(<NotificationPanel />);
    expect(screen.getByText(/no notifications/i)).toBeInTheDocument();
  });

  it("displays notifications with messages", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "Build complete",
    });
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "Tests passed",
      level: "success",
    });

    render(<NotificationPanel />);
    expect(screen.getByText("Build complete")).toBeInTheDocument();
    expect(screen.getByText("Tests passed")).toBeInTheDocument();
  });

  it("shows unread indicator for unread notifications", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "Build complete",
    });

    render(<NotificationPanel />);
    const item = screen.getByText("Build complete").closest("[data-testid]");
    expect(item?.getAttribute("data-read")).toBe("false");
  });

  it("marks notifications as read when mark-read button clicked", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "Build complete",
    });
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "Deploy done",
    });

    render(<NotificationPanel />);

    const markReadBtn = screen.getByTestId("mark-read-ws-default");
    fireEvent.click(markReadBtn);

    expect(useNotificationStore.getState().getUnreadCount("ws-default")).toBe(0);
  });

  it("orders notifications by most recent first", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "First",
    });
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "Second",
    });

    render(<NotificationPanel />);

    const items = screen.getAllByTestId(/^notification-item-/);
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toContain("Second");
    expect(items[1].textContent).toContain("First");
  });

  it("displays workspace name instead of workspace ID", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "Test msg",
    });

    render(<NotificationPanel />);
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.queryByText("ws-default")).not.toBeInTheDocument();
  });

  it("displays terminal label for each notification", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "g",
      workspaceId: "ws-default",
      label: "WSL #1",
    });
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "Done",
    });

    render(<NotificationPanel />);
    expect(screen.getByText("[WSL #1]")).toBeInTheDocument();
  });

  it("shows '?' label for unknown terminal", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "unknown-terminal",
      workspaceId: "ws-default",
      message: "Mystery",
    });

    render(<NotificationPanel />);
    expect(screen.getByText("[?]")).toBeInTheDocument();
  });

  it("applies color based on notification level", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "Error msg",
      level: "error",
    });

    render(<NotificationPanel />);
    const msgEl = screen.getByText("Error msg");
    expect(msgEl.style.color).toBe("var(--red)");
  });

  it("sorts unread notifications above read ones", () => {
    const now = Date.now();
    useNotificationStore.setState({
      notifications: [
        {
          id: "n1",
          terminalId: "t1",
          workspaceId: "ws-default",
          message: "Read old",
          level: "info",
          createdAt: now - 3000,
          readAt: now - 1000,

        },
        {
          id: "n2",
          terminalId: "t1",
          workspaceId: "ws-default",
          message: "Unread new",
          level: "info",
          createdAt: now - 1000,
          readAt: null,

        },
        {
          id: "n3",
          terminalId: "t1",
          workspaceId: "ws-default",
          message: "Read newer",
          level: "info",
          createdAt: now - 500,
          readAt: now - 100,

        },
      ],
    });

    render(<NotificationPanel />);

    const items = screen.getAllByTestId(/^notification-item-/);
    expect(items[0].textContent).toContain("Unread new");
    // Read ones come after
    expect(items[1].getAttribute("data-read")).toBe("true");
    expect(items[2].getAttribute("data-read")).toBe("true");
  });

  it("filters by workspaceId when prop provided", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "Default msg",
    });
    useWorkspaceStore.getState().addWorkspace("Second", "default-layout");
    const ws2Id = useWorkspaceStore.getState().workspaces[1].id;
    useNotificationStore.getState().addNotification({
      terminalId: "t2",
      workspaceId: ws2Id,
      message: "Second msg",
    });

    render(<NotificationPanel workspaceId="ws-default" />);

    expect(screen.getByText("Default msg")).toBeInTheDocument();
    expect(screen.queryByText("Second msg")).not.toBeInTheDocument();
  });

  it("shows all workspaces when no workspaceId prop", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "Default msg",
    });
    useWorkspaceStore.getState().addWorkspace("Second", "default-layout");
    const ws2Id = useWorkspaceStore.getState().workspaces[1].id;
    useNotificationStore.getState().addNotification({
      terminalId: "t2",
      workspaceId: ws2Id,
      message: "Second msg",
    });

    render(<NotificationPanel />);

    expect(screen.getByText("Default msg")).toBeInTheDocument();
    expect(screen.getByText("Second msg")).toBeInTheDocument();
  });

  it("shows relative time for notifications", () => {
    // Override Date.now for controlled test
    const now = Date.now();
    useNotificationStore.setState({
      notifications: [
        {
          id: "n1",
          terminalId: "t1",
          workspaceId: "ws-default",
          message: "Recent",
          level: "info",
          createdAt: now - 30000, // 30 seconds ago
          readAt: null,

        },
      ],
    });

    render(<NotificationPanel />);
    expect(screen.getByText("방금")).toBeInTheDocument();
  });
});
