import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkspaceSelectorView } from "./WorkspaceSelectorView";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useSettingsStore } from "@/stores/settings-store";
import { getListeningPorts, getTerminalSummaries } from "@/lib/tauri-api";
import type { TerminalSummaryResponse } from "@/lib/tauri-api";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

vi.mock("@/lib/tauri-api", () => ({
  getListeningPorts: vi.fn().mockResolvedValue([]),
  createTerminalSession: vi.fn().mockResolvedValue({}),
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
  resizeTerminal: vi.fn().mockResolvedValue(undefined),
  closeTerminalSession: vi.fn().mockResolvedValue(undefined),
  getSyncGroupTerminals: vi.fn().mockResolvedValue([]),
  handleLxMessage: vi.fn().mockResolvedValue({}),
  loadSettings: vi.fn().mockResolvedValue({}),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  onTerminalOutput: vi.fn().mockResolvedValue(() => {}),
  onSyncCwd: vi.fn().mockResolvedValue(() => {}),
  onSyncBranch: vi.fn().mockResolvedValue(() => {}),
  onLxNotify: vi.fn().mockResolvedValue(() => {}),
  onSetTabTitle: vi.fn().mockResolvedValue(() => {}),
  getGitBranch: vi.fn().mockResolvedValue(null),
  sendOsNotification: vi.fn().mockResolvedValue(undefined),
  getTerminalSummaries: vi.fn().mockResolvedValue([]),
  markNotificationsRead: vi.fn().mockResolvedValue(0),
}));

/**
 * Build TerminalSummaryResponse objects from the current useTerminalStore
 * and useNotificationStore state — bridges old test setup to the new
 * backend-fetched architecture.
 */
function buildSummariesFromStores(ids: string[]): TerminalSummaryResponse[] {
  const { instances } = useTerminalStore.getState();
  const { notifications } = useNotificationStore.getState();
  return ids
    .map((id) => {
      const inst = instances.find((i) => i.id === id);
      if (!inst) return null;
      const termNotifs = notifications.filter((n) => n.terminalId === id);
      const unread = termNotifs.filter((n) => n.readAt === null);
      const latestUnread = [...unread].sort((a, b) => b.createdAt - a.createdAt)[0] ?? null;
      return {
        id: inst.id,
        profile: inst.profile,
        title: inst.title ?? "Terminal",
        cwd: inst.cwd ?? null,
        branch: inst.branch ?? null,
        lastCommand: inst.lastCommand ?? null,
        lastExitCode: inst.lastExitCode ?? null,
        lastCommandAt: inst.lastCommandAt ?? null,
        commandRunning: inst.lastCommand != null && inst.lastExitCode == null,
        activity: inst.activity ?? { type: "shell" as const },
        outputActive: inst.outputActive ?? false,
        isClaude: false,
        unreadNotificationCount: unread.length,
        latestNotification: latestUnread
          ? {
              id: 1,
              terminalId: id,
              message: latestUnread.message,
              level: latestUnread.level,
              createdAt: latestUnread.createdAt,
              readAt: null,
            }
          : null,
      } satisfies TerminalSummaryResponse;
    })
    .filter((s): s is TerminalSummaryResponse => s !== null);
}

/** Add a notification that bypasses auto-dismiss by temporarily switching away from the target workspace. */
function addUnreadNotification(params: {
  terminalId: string;
  workspaceId: string;
  message: string;
}) {
  const prev = useWorkspaceStore.getState().activeWorkspaceId;
  if (prev === params.workspaceId) {
    useWorkspaceStore.getState().addWorkspace("__temp__", "default-layout");
    const tempId = useWorkspaceStore.getState().workspaces.find((w) => w.name === "__temp__")!.id;
    useWorkspaceStore.getState().setActiveWorkspace(tempId);
  }
  useNotificationStore.getState().addNotification(params);
  if (prev === params.workspaceId) {
    useWorkspaceStore.getState().setActiveWorkspace(prev);
    useWorkspaceStore
      .getState()
      .removeWorkspace(
        useWorkspaceStore.getState().workspaces.find((w) => w.name === "__temp__")!.id,
      );
  }
}

describe("WorkspaceSelectorView", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useNotificationStore.setState(useNotificationStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());

    // Wire getTerminalSummaries to read from the stores dynamically
    vi.mocked(getTerminalSummaries).mockImplementation(async (ids: string[]) => {
      return buildSummariesFromStores(ids);
    });
  });

  it("renders workspace list", () => {
    render(<WorkspaceSelectorView />);
    expect(screen.getByTestId("workspace-selector")).toBeInTheDocument();
    expect(screen.getByTestId("workspace-item-ws-default")).toBeInTheDocument();
  });

  it("shows new workspace panel with layout cards", () => {
    render(<WorkspaceSelectorView />);
    expect(screen.getByTestId("new-workspace-panel")).toBeInTheDocument();
    expect(screen.getByTestId("layout-card-default-layout")).toBeInTheDocument();
  });

  it("highlights active workspace", () => {
    render(<WorkspaceSelectorView />);
    const activeWs = screen.getByTestId("workspace-item-ws-default");
    expect(activeWs).toHaveAttribute("data-active", "true");
  });

  it("adds a new workspace on layout card click", async () => {
    const user = userEvent.setup();
    render(<WorkspaceSelectorView />);
    await user.click(screen.getByTestId("layout-create-default-layout"));
    expect(useWorkspaceStore.getState().workspaces).toHaveLength(2);
  });

  it("switches workspace on click", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.getState().addWorkspace("Second", "default-layout");
    render(<WorkspaceSelectorView />);

    const items = screen.getAllByTestId(/^workspace-item-/);
    expect(items).toHaveLength(2);

    await user.click(items[1]);
    const ws2 = useWorkspaceStore.getState().workspaces[1];
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(ws2.id);
  });

  it("shows unread badge when notifications exist", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            {
              id: "p1",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView", profile: "PowerShell" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
    });
    addUnreadNotification({
      terminalId: "terminal-p1",
      workspaceId: "ws-default",
      message: "test msg",
    });
    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      expect(screen.getByTestId("unread-badge-ws-default")).toBeInTheDocument();
      expect(screen.getByTestId("unread-badge-ws-default")).toHaveTextContent("1");
    });
  });

  it("shows latest notification text", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            {
              id: "p1",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView", profile: "PowerShell" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
    });
    addUnreadNotification({
      terminalId: "terminal-p1",
      workspaceId: "ws-default",
      message: "Build done",
    });
    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      expect(screen.getByText(/Build done/)).toBeInTheDocument();
    });
  });

  it("marks notifications read when workspace is clicked", async () => {
    const user = userEvent.setup();
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "msg",
    });
    render(<WorkspaceSelectorView />);

    await user.click(screen.getByTestId("workspace-item-ws-default"));
    expect(useNotificationStore.getState().getUnreadCount("ws-default")).toBe(0);
  });

  it("displays git branch from terminal store (most recent activity)", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            {
              id: "p1",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView", profile: "PowerShell" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-p1", {
      branch: "feature/login",
    });

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      expect(screen.getByText("feature/login")).toBeInTheDocument();
    });
  });

  it("displays working directory from focused terminal", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            {
              id: "p1",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView", profile: "PowerShell" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-p1", {
      cwd: "~/dev/project",
    });
    useTerminalStore.getState().setTerminalFocus("terminal-p1");

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      expect(screen.getByText("~/dev/project")).toBeInTheDocument();
    });
  });

  it("shows unread state when workspace has unread notifications", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            {
              id: "p1",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView", profile: "PowerShell" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
    });
    addUnreadNotification({
      terminalId: "terminal-p1",
      workspaceId: "ws-default",
      message: "alert",
    });
    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      expect(screen.getByTestId("unread-badge-ws-default")).toBeInTheDocument();
    });
  });

  it("has a notification panel toggle button", () => {
    render(<WorkspaceSelectorView />);
    expect(screen.getByTestId("toggle-notification-panel")).toBeInTheDocument();
  });

  it("shows notification panel when toggled", async () => {
    const user = userEvent.setup();
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "Test notification",
    });

    render(<WorkspaceSelectorView />);
    await user.click(screen.getByTestId("toggle-notification-panel"));
    expect(screen.getByTestId("notification-panel")).toBeInTheDocument();
  });

  it("shows multiple layout cards when multiple layouts exist", () => {
    useWorkspaceStore.getState().exportAsNewLayout("Dev Split");
    render(<WorkspaceSelectorView />);

    const cards = screen.getAllByTestId(/^layout-card-/);
    expect(cards.length).toBe(2);
  });

  it("creates workspace with correct layout when layout card clicked", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.getState().exportAsNewLayout("Dev Split");
    render(<WorkspaceSelectorView />);

    const createBtns = screen.getAllByTestId(/^layout-create-/);
    await user.click(createBtns[1]);

    expect(useWorkspaceStore.getState().workspaces).toHaveLength(2);
    const newWs = useWorkspaceStore.getState().workspaces[1];
    const exportedLayout = useWorkspaceStore.getState().layouts[1];
    expect(newWs.panes).toHaveLength(exportedLayout.panes.length);
  });

  it("auto-switches to newly created workspace", async () => {
    const user = userEvent.setup();
    render(<WorkspaceSelectorView />);

    await user.click(screen.getByTestId("layout-create-default-layout"));
    const newWs = useWorkspaceStore.getState().workspaces[1];
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(newWs.id);
  });

  it("does not display listening ports in workspace tabs", async () => {
    vi.mocked(getListeningPorts).mockResolvedValue([
      { port: 3000, pid: null, process_name: null },
      { port: 8080, pid: null, process_name: null },
    ]);

    render(<WorkspaceSelectorView />);

    expect(screen.queryByText(/:3000/)).not.toBeInTheDocument();
    expect(screen.queryByText(/:8080/)).not.toBeInTheDocument();
  });

  it("displays last command with success indicator", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            {
              id: "p1",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView", profile: "PowerShell" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-p1", {
      lastCommand: "npm test",
      lastExitCode: 0,
      lastCommandAt: Date.now(),
    });

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      expect(screen.getByText(/npm test/)).toBeInTheDocument();
      expect(screen.getByTestId("cmd-status-ws-default")).toHaveTextContent("✓");
    });
  });

  it("displays last command with failure indicator", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            {
              id: "p1",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView", profile: "PowerShell" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-p1", {
      lastCommand: "npm build",
      lastExitCode: 1,
      lastCommandAt: Date.now(),
    });

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      expect(screen.getByText(/npm build/)).toBeInTheDocument();
      expect(screen.getByTestId("cmd-status-ws-default")).toHaveTextContent("✗");
    });
  });

  it("displays running indicator when command has no exit code", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            {
              id: "p1",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView", profile: "PowerShell" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-p1", {
      lastCommand: "npm test",
      lastCommandAt: Date.now(),
    });

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      expect(screen.getByTestId("cmd-status-ws-default")).toHaveTextContent("⏳");
    });
  });

  it("shows terminal count badge when terminals exist", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView", profile: "WSL" } },
            {
              id: "p2",
              x: 0.5,
              y: 0,
              w: 0.5,
              h: 1,
              view: { type: "TerminalView", profile: "PowerShell" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1",
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p2",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
    });

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      expect(screen.getByTestId("terminal-count-ws-default")).toHaveTextContent("2");
    });
  });

  it("shows per-terminal summaries for active workspace with 2+ terminals", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView", profile: "WSL" } },
            {
              id: "p2",
              x: 0.5,
              y: 0,
              w: 0.5,
              h: 1,
              view: { type: "TerminalView", profile: "PowerShell" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1",
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: "ws-default",
      label: "WSL",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p2",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
      label: "PS",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-p1", { cwd: "/home/user/project" });
    useTerminalStore.getState().updateInstanceInfo("terminal-p2", { cwd: "/home/user/api" });

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      expect(screen.getByText("WSL")).toBeInTheDocument();
      expect(screen.getByText("PS")).toBeInTheDocument();
      expect(screen.getByText("~/project")).toBeInTheDocument();
      expect(screen.getByText("~/api")).toBeInTheDocument();
    });
  });

  it("shows pane minimaps in per-terminal summaries with correct highlight", async () => {
    // Set up a workspace with 2 TerminalView panes (left/right split)
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            {
              id: "pane-left",
              x: 0,
              y: 0,
              w: 0.5,
              h: 1,
              view: { type: "TerminalView", profile: "WSL" },
            },
            {
              id: "pane-right",
              x: 0.5,
              y: 0,
              w: 0.5,
              h: 1,
              view: { type: "TerminalView", profile: "PowerShell" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    // Register terminals with IDs matching pane IDs (terminal-{paneId} pattern)
    useTerminalStore.getState().registerInstance({
      id: "terminal-pane-left",
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: "ws-default",
      label: "WSL",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-pane-right",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
      label: "PS",
    });

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      // Each terminal summary should have a minimap
      const minimap1 = screen.getByTestId("pane-minimap-terminal-pane-left");
      const minimap2 = screen.getByTestId("pane-minimap-terminal-pane-right");
      expect(minimap1).toBeInTheDocument();
      expect(minimap2).toBeInTheDocument();

      // First minimap: pane-left highlighted (index 0)
      const svg1 = minimap1.querySelector("svg")!;
      const rects1 = svg1.querySelectorAll("rect[data-pane-index]");
      expect(rects1).toHaveLength(2);
      expect(rects1[0].getAttribute("data-highlighted")).toBe("true");
      expect(rects1[1].getAttribute("data-highlighted")).toBe("false");

      // Second minimap: pane-right highlighted (index 1)
      const svg2 = minimap2.querySelector("svg")!;
      const rects2 = svg2.querySelectorAll("rect[data-pane-index]");
      expect(rects2[0].getAttribute("data-highlighted")).toBe("false");
      expect(rects2[1].getAttribute("data-highlighted")).toBe("true");
    });
  });

  it("shows minimap with correct proportions for complex layout", async () => {
    // 3-pane layout: top full-width, bottom-left, bottom-right
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            {
              id: "pane-top",
              x: 0,
              y: 0,
              w: 1,
              h: 0.6,
              view: { type: "TerminalView", profile: "WSL" },
            },
            {
              id: "pane-bl",
              x: 0,
              y: 0.6,
              w: 0.5,
              h: 0.4,
              view: { type: "TerminalView", profile: "PowerShell" },
            },
            { id: "pane-br", x: 0.5, y: 0.6, w: 0.5, h: 0.4, view: { type: "BrowserPreviewView" } },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-pane-top",
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: "ws-default",
      label: "WSL",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-pane-bl",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
      label: "PS",
    });

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      // Minimap for bottom-left terminal should show all 3 panes, highlight index 1
      const minimap = screen.getByTestId("pane-minimap-terminal-pane-bl");
      const svg = minimap.querySelector("svg")!;
      const rects = svg.querySelectorAll("rect[data-pane-index]");
      expect(rects).toHaveLength(3);
      expect(rects[0].getAttribute("data-highlighted")).toBe("false"); // top pane
      expect(rects[1].getAttribute("data-highlighted")).toBe("true"); // bottom-left (this terminal)
      expect(rects[2].getAttribute("data-highlighted")).toBe("false"); // bottom-right (browser)
    });
  });

  it("shows close button on workspace items when hovered and multiple exist", () => {
    useWorkspaceStore.getState().addWorkspace("Second", "default-layout");
    render(<WorkspaceSelectorView />);

    const item = screen.getByTestId("workspace-item-ws-default");
    fireEvent.mouseEnter(item);
    expect(screen.getByTestId("workspace-close-ws-default")).toBeInTheDocument();
  });

  it("does not show close button when only one workspace exists", () => {
    render(<WorkspaceSelectorView />);
    const item = screen.getByTestId("workspace-item-ws-default");
    fireEvent.mouseEnter(item);
    expect(screen.queryByTestId(/^workspace-close-/)).not.toBeInTheDocument();
  });

  it("removes workspace when close button is clicked", () => {
    useWorkspaceStore.getState().addWorkspace("Second", "default-layout");
    render(<WorkspaceSelectorView />);

    const ws2 = useWorkspaceStore.getState().workspaces[1];
    const item = screen.getByTestId(`workspace-item-${ws2.id}`);
    fireEvent.mouseEnter(item);
    fireEvent.click(screen.getByTestId(`workspace-close-${ws2.id}`));

    expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
    expect(useWorkspaceStore.getState().workspaces[0].id).toBe("ws-default");
  });

  it("switches to another workspace when active workspace is closed", () => {
    useWorkspaceStore.getState().addWorkspace("Second", "default-layout");
    const ws2 = useWorkspaceStore.getState().workspaces[1];
    useWorkspaceStore.getState().setActiveWorkspace(ws2.id);
    render(<WorkspaceSelectorView />);

    const item = screen.getByTestId(`workspace-item-${ws2.id}`);
    fireEvent.mouseEnter(item);
    fireEvent.click(screen.getByTestId(`workspace-close-${ws2.id}`));

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-default");
  });

  it("close button click does not trigger workspace selection", () => {
    useWorkspaceStore.getState().addWorkspace("Second", "default-layout");
    const ws2 = useWorkspaceStore.getState().workspaces[1];
    render(<WorkspaceSelectorView />);

    const item = screen.getByTestId(`workspace-item-${ws2.id}`);
    fireEvent.mouseEnter(item);
    fireEvent.click(screen.getByTestId(`workspace-close-${ws2.id}`));
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-default");
  });

  it("does not show dock terminal last command in active workspace summary", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            {
              id: "p1",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView", profile: "PowerShell" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    // Workspace terminal with old command
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-p1", {
      lastCommand: "npm test",
      lastExitCode: 0,
      lastCommandAt: Date.now() - 60000,
    });
    // Dock terminal with newer command (should NOT appear in workspace summary)
    useTerminalStore.getState().registerInstance({
      id: "terminal-dock-bottom",
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: "",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-dock-bottom", {
      lastCommand: "cargo build",
      lastExitCode: 1,
      lastCommandAt: Date.now(),
    });

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      // Should show workspace terminal's command, not dock's
      expect(screen.getByText(/npm test/)).toBeInTheDocument();
      expect(screen.queryByText(/cargo build/)).not.toBeInTheDocument();
      expect(screen.getByTestId("cmd-status-ws-default")).toHaveTextContent("✓");
    });
  });

  it("workspace items always render 3 rows even without data", () => {
    render(<WorkspaceSelectorView />);
    const item = screen.getByTestId("workspace-item-ws-default");
    // Should have row-1, row-2, row-3
    expect(item.querySelector("[data-testid='ws-row-1-ws-default']")).toBeInTheDocument();
    expect(item.querySelector("[data-testid='ws-row-2-ws-default']")).toBeInTheDocument();
    expect(item.querySelector("[data-testid='ws-row-3-ws-default']")).toBeInTheDocument();
  });

  it("workspace index number has shortcut tooltip", () => {
    render(<WorkspaceSelectorView />);
    const item = screen.getByTestId("workspace-item-ws-default");
    const indexSpan = item.querySelector("[title='Ctrl+Alt+1']");
    expect(indexSpan).toBeInTheDocument();
    expect(indexSpan).toHaveTextContent("1");
  });

  it("workspace index number is bright (visible) for active workspace", () => {
    render(<WorkspaceSelectorView />);
    const item = screen.getByTestId("workspace-item-ws-default");
    const indexSpan = item.querySelector("[title='Ctrl+Alt+1']") as HTMLElement;
    expect(indexSpan.style.color).toBe("var(--accent)");
    expect(indexSpan.style.opacity).toBe("0.9");
  });

  it("layout card shows 'default' label on first layout", () => {
    render(<WorkspaceSelectorView />);
    expect(screen.getByText("default")).toBeInTheDocument();
  });

  it("layout card does not show pane count text", () => {
    render(<WorkspaceSelectorView />);
    expect(screen.queryByText("1 pane")).not.toBeInTheDocument();
  });

  // -- Layout management --

  it("shows menu button on layout card hover", async () => {
    const user = userEvent.setup();
    render(<WorkspaceSelectorView />);

    const card = screen.getByTestId("layout-card-default-layout");
    await user.hover(card);
    expect(screen.getByTestId("layout-menu-default-layout")).toBeInTheDocument();
  });

  it("double-clicking workspace name triggers rename prompt", async () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Renamed WS");
    render(<WorkspaceSelectorView />);
    const nameEl = screen.getByTestId("workspace-name-ws-default");
    fireEvent.doubleClick(nameEl);
    expect(promptSpy).toHaveBeenCalledWith("Rename workspace:", "Default");
    expect(useWorkspaceStore.getState().workspaces[0].name).toBe("Renamed WS");
    promptSpy.mockRestore();
  });

  it("double-clicking workspace name does not rename when prompt is cancelled", () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    render(<WorkspaceSelectorView />);
    const nameEl = screen.getByTestId("workspace-name-ws-default");
    fireEvent.doubleClick(nameEl);
    expect(promptSpy).toHaveBeenCalled();
    expect(useWorkspaceStore.getState().workspaces[0].name).toBe("Default");
    promptSpy.mockRestore();
  });

  it("double-clicking workspace name does not trigger workspace select", () => {
    // Add a second workspace so we can check that double-clicking name on a non-active ws doesn't switch
    useWorkspaceStore.getState().addWorkspace("Second", "default-layout");
    const workspaces = useWorkspaceStore.getState().workspaces;
    const ws2 = workspaces[workspaces.length - 1];
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    render(<WorkspaceSelectorView />);
    const nameEl = screen.getByTestId(`workspace-name-${ws2.id}`);
    fireEvent.doubleClick(nameEl);
    // Active workspace should still be the first one
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-default");
    promptSpy.mockRestore();
  });

  it("renameLayout changes layout name in store", () => {
    useWorkspaceStore.getState().renameLayout("default-layout", "My Layout");
    expect(useWorkspaceStore.getState().layouts[0].name).toBe("My Layout");
  });

  it("duplicateLayout creates a copy", () => {
    useWorkspaceStore.getState().duplicateLayout("default-layout", "Copy");
    const layouts = useWorkspaceStore.getState().layouts;
    expect(layouts).toHaveLength(2);
    expect(layouts[1].name).toBe("Copy");
  });

  it("removeLayout removes layout and reassigns workspaces", () => {
    useWorkspaceStore.getState().exportAsNewLayout("Extra");
    expect(useWorkspaceStore.getState().layouts).toHaveLength(2);

    const extraId = useWorkspaceStore.getState().layouts[1].id;
    useWorkspaceStore.getState().removeLayout(extraId);
    expect(useWorkspaceStore.getState().layouts).toHaveLength(1);
  });

  it("setDefaultLayout moves layout to first position", () => {
    useWorkspaceStore.getState().exportAsNewLayout("NewDefault");
    const newId = useWorkspaceStore.getState().layouts[1].id;

    useWorkspaceStore.getState().setDefaultLayout(newId);
    expect(useWorkspaceStore.getState().layouts[0].id).toBe(newId);
  });

  // -- Pane-level notification badge --

  it("shows notification border on pane command icon when pane has unread notifications", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView", profile: "WSL" } },
            {
              id: "p2",
              x: 0.5,
              y: 0,
              w: 0.5,
              h: 1,
              view: { type: "TerminalView", profile: "PowerShell" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1",
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: "ws-default",
      label: "WSL",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p2",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
      label: "PS",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-p1", {
      lastCommand: "npm test",
      lastExitCode: 0,
      lastCommandAt: Date.now(),
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-p2", {
      lastCommand: "cargo build",
      lastExitCode: 1,
      lastCommandAt: Date.now(),
    });
    // Add notification only for terminal-p1
    addUnreadNotification({
      terminalId: "terminal-p1",
      workspaceId: "ws-default",
      message: "Build complete",
    });

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      // terminal-p1 should have notification badge border
      const badge1 = screen.getByTestId("pane-cmd-badge-terminal-p1");
      expect(badge1).toBeInTheDocument();
      expect(badge1.style.border).toContain("var(--accent)");

      // terminal-p2 should NOT have notification badge border
      const badge2 = screen.getByTestId("pane-cmd-badge-terminal-p2");
      expect(badge2.style.border).not.toContain("var(--accent)");
    });
  });

  it("shows notification border on hourglass icon for running command with notification", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            { id: "p1", x: 0, y: 0, w: 1, h: 1, view: { type: "TerminalView", profile: "WSL" } },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1",
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: "ws-default",
      label: "WSL",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-p1", {
      lastCommand: "npm test",
      lastCommandAt: Date.now(),
    });
    addUnreadNotification({
      terminalId: "terminal-p1",
      workspaceId: "ws-default",
      message: "alert",
    });

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      const badge = screen.getByTestId("pane-cmd-badge-terminal-p1");
      expect(badge).toBeInTheDocument();
      expect(badge).toHaveTextContent("⏳");
      expect(badge.style.border).toContain("var(--accent)");
    });
  });

  it("shows standalone notification dot when no command status but notification exists", async () => {
    // When there's no command icon, the notification badge should still appear
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            { id: "p1", x: 0, y: 0, w: 1, h: 1, view: { type: "TerminalView", profile: "WSL" } },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1",
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: "ws-default",
      label: "WSL",
    });
    // No command but notification exists
    addUnreadNotification({
      terminalId: "terminal-p1",
      workspaceId: "ws-default",
      message: "alert",
    });

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      // There's no command icon, so we show a standalone notification dot
      const badge = screen.getByTestId("pane-notif-dot-terminal-p1");
      expect(badge).toBeInTheDocument();
    });
  });

  it("hides minimap when workspaceDisplay.minimap is false", async () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      workspaceDisplay: { ...useSettingsStore.getState().workspaceDisplay, minimap: false },
    });
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Test",
          panes: [
            {
              id: "p1",
              x: 0,
              y: 0,
              w: 0.5,
              h: 1,
              view: { type: "TerminalView", profile: "PowerShell" },
            },
            {
              id: "p2",
              x: 0.5,
              y: 0,
              w: 0.5,
              h: 1,
              view: { type: "TerminalView", profile: "WSL" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1",
      profile: "PowerShell",
      syncGroup: "Test",
      workspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p2",
      profile: "WSL",
      syncGroup: "Test",
      workspaceId: "ws-default",
    });

    render(<WorkspaceSelectorView />);

    // Even after data loads, minimaps should be hidden
    expect(screen.queryByTestId("pane-minimap-terminal-p1")).not.toBeInTheDocument();
    expect(screen.queryByTestId("pane-minimap-terminal-p2")).not.toBeInTheDocument();
  });

  it("hides activity when workspaceDisplay.activity is false", async () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      workspaceDisplay: { ...useSettingsStore.getState().workspaceDisplay, activity: false },
    });
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Test",
          panes: [
            {
              id: "p1",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView", profile: "PowerShell" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1",
      profile: "PowerShell",
      syncGroup: "Test",
      workspaceId: "ws-default",
    });

    render(<WorkspaceSelectorView />);

    expect(screen.queryByTestId("terminal-activity-terminal-p1")).not.toBeInTheDocument();
  });

  describe("drag and drop reorder", () => {
    beforeEach(() => {
      // Set up 3 workspaces
      useWorkspaceStore.setState({
        layouts: [
          { id: "layout-1", name: "L", panes: [{ x: 0, y: 0, w: 1, h: 1, viewType: "EmptyView" }] },
        ],
        workspaces: [
          {
            id: "ws-1",
            name: "WS1",
            panes: [{ id: "p1", x: 0, y: 0, w: 1, h: 1, view: { type: "EmptyView" } }],
          },
          {
            id: "ws-2",
            name: "WS2",
            panes: [{ id: "p2", x: 0, y: 0, w: 1, h: 1, view: { type: "EmptyView" } }],
          },
          {
            id: "ws-3",
            name: "WS3",
            panes: [{ id: "p3", x: 0, y: 0, w: 1, h: 1, view: { type: "EmptyView" } }],
          },
        ],
        activeWorkspaceId: "ws-1",
      });
    });

    it("workspace items have draggable attribute in manual sort mode", () => {
      useSettingsStore.getState().setWorkspaceSortOrder("manual");
      render(<WorkspaceSelectorView />);
      const item = screen.getByTestId("workspace-item-ws-1");
      expect(item).toHaveAttribute("draggable", "true");
    });

    it("workspace items are not draggable in notification sort mode", () => {
      useSettingsStore.getState().setWorkspaceSortOrder("notification");
      render(<WorkspaceSelectorView />);
      const item = screen.getByTestId("workspace-item-ws-1");
      expect(item).toHaveAttribute("draggable", "false");
    });

    it("fires reorderWorkspaces on drag-drop and verifies order", () => {
      useSettingsStore.getState().setWorkspaceSortOrder("manual");
      render(<WorkspaceSelectorView />);

      const item1 = screen.getByTestId("workspace-item-ws-1");
      const item3 = screen.getByTestId("workspace-item-ws-3");

      // Simulate drag ws-1 onto ws-3 (jsdom getBoundingClientRect returns 0s,
      // so clientY=0 < top=0 + height=0/2 is false → position="bottom")
      fireEvent.dragStart(item1, { dataTransfer: { setData: vi.fn(), effectAllowed: "" } });
      fireEvent.dragOver(item3, { dataTransfer: { dropEffect: "" }, preventDefault: vi.fn() });
      fireEvent.drop(item3, { dataTransfer: { getData: () => "ws-1" }, preventDefault: vi.fn() });

      // position="bottom" → display order: [ws-2, ws-3, ws-1]
      // workspaces array is NOT modified — only display order changes
      const { workspaceDisplayOrder } = useWorkspaceStore.getState();
      expect(workspaceDisplayOrder).toEqual(["ws-2", "ws-3", "ws-1"]);
    });
  });

  describe("notification sort order", () => {
    beforeEach(() => {
      useWorkspaceStore.setState({
        layouts: [
          { id: "layout-1", name: "L", panes: [{ x: 0, y: 0, w: 1, h: 1, viewType: "EmptyView" }] },
        ],
        workspaces: [
          {
            id: "ws-1",
            name: "WS1",
            panes: [{ id: "p1", x: 0, y: 0, w: 1, h: 1, view: { type: "EmptyView" } }],
          },
          {
            id: "ws-2",
            name: "WS2",
            panes: [{ id: "p2", x: 0, y: 0, w: 1, h: 1, view: { type: "EmptyView" } }],
          },
          {
            id: "ws-3",
            name: "WS3",
            panes: [{ id: "p3", x: 0, y: 0, w: 1, h: 1, view: { type: "EmptyView" } }],
          },
        ],
        activeWorkspaceId: "ws-1",
      });
      useSettingsStore.getState().setWorkspaceSortOrder("notification");
    });

    it("preserves original array order when no workspaces have notifications", () => {
      render(<WorkspaceSelectorView />);
      const items = screen.getAllByTestId(/^workspace-item-ws-/);
      expect(items.map((el) => el.getAttribute("data-testid"))).toEqual([
        "workspace-item-ws-1",
        "workspace-item-ws-2",
        "workspace-item-ws-3",
      ]);
    });

    it("sorts workspace with unread notification to top", () => {
      useNotificationStore.setState({
        notifications: [
          {
            id: "n1",
            terminalId: "t1",
            workspaceId: "ws-3",
            message: "test",
            level: "info",
            createdAt: Date.now(),
            readAt: null,
          },
        ],
      });
      render(<WorkspaceSelectorView />);
      const items = screen.getAllByTestId(/^workspace-item-ws-/);
      expect(items[0].getAttribute("data-testid")).toBe("workspace-item-ws-3");
    });
  });

  describe("sort order toggle", () => {
    it("renders sort toggle button", () => {
      render(<WorkspaceSelectorView />);
      expect(screen.getByTestId("sort-order-toggle")).toBeInTheDocument();
    });

    it("clicking sort toggle switches between manual and notification", async () => {
      const user = userEvent.setup();
      render(<WorkspaceSelectorView />);

      expect(useSettingsStore.getState().workspaceSortOrder).toBe("manual");

      const toggle = screen.getByTestId("sort-order-toggle");
      await user.click(toggle);
      expect(useSettingsStore.getState().workspaceSortOrder).toBe("notification");

      await user.click(toggle);
      expect(useSettingsStore.getState().workspaceSortOrder).toBe("manual");
    });
  });

  it("falls back to lastCwd from settings when backend has no CWD yet", async () => {
    // Simulate app restart: pane has lastCwd but terminal hasn't emitted OSC 7 yet
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            {
              id: "pane-fb1",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: {
                type: "TerminalView",
                profile: "WSL",
                lastCwd: "/home/user/myproject",
              },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    // Register terminal instance WITHOUT cwd (shell hasn't started yet)
    useTerminalStore.getState().registerInstance({
      id: "terminal-pane-fb1",
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: "ws-default",
      label: "WSL",
    });

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      expect(screen.getByText("~/myproject")).toBeInTheDocument();
    });
  });

  it("shows lastCwd even when backend session does not exist yet", async () => {
    // Simulate very early app startup: no terminal session at all in the backend
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            {
              id: "pane-nosession",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: {
                type: "TerminalView",
                profile: "WSL",
                lastCwd: "/home/user/earlystart",
              },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    // Do NOT register any terminal instance — simulates no backend session

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      expect(screen.getByText("~/earlystart")).toBeInTheDocument();
    });
  });

  it("shows lastCwd with defaultProfile fallback for panes without explicit profile", async () => {
    // PowerShell pane without explicit profile (uses defaultProfile)
    useSettingsStore.getState().loadFromSettings({ defaultProfile: "PowerShell", profiles: [] });
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            {
              id: "pane-noexplicit",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: {
                type: "TerminalView",
                // No explicit profile — should use defaultProfile "PowerShell"
                lastCwd: "/mnt/c/Users/kochul/Projects",
              },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      // Should convert /mnt/c/Users/kochul/Projects → C:\Users\kochul\Projects → ~/Projects
      expect(screen.getByText("~/Projects")).toBeInTheDocument();
    });
  });

  it("displays PowerShell CWD as Windows path instead of /mnt/...", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            {
              id: "pane-ps1",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView", profile: "PowerShell" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-pane-ps1",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
      label: "PS",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-pane-ps1", {
      cwd: "/mnt/c/Users/kochul/Projects",
    });

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      // Should show as Windows path, not /mnt/c/...
      expect(screen.getByText("~/Projects")).toBeInTheDocument();
    });
  });

  it("does NOT convert /mnt/ path for WSL terminals", async () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          panes: [
            {
              id: "pane-wsl1",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView", profile: "WSL" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-pane-wsl1",
      profile: "WSL",
      syncGroup: "Default",
      workspaceId: "ws-default",
      label: "WSL",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-pane-wsl1", {
      cwd: "/mnt/c/Users/kochul",
    });

    render(<WorkspaceSelectorView />);

    await waitFor(() => {
      // WSL should keep the /mnt/ path format
      expect(screen.getByText("/mnt/c/Users/kochul")).toBeInTheDocument();
    });
  });

  it("displays IssueReporterView pane with proper label instead of ---", () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-issue",
          name: "Issue WS",
          panes: [
            {
              id: "pane-issue1",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "IssueReporterView" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-issue",
    });

    render(<WorkspaceSelectorView />);

    // Should NOT show "---" (the Empty abbreviation)
    const wsRow = screen.getByTestId("ws-row-2-ws-issue");
    expect(wsRow.textContent).not.toBe("---");
    // Should show a meaningful label for IssueReporterView
    expect(wsRow.textContent).toContain("ISS");
  });

  it("displays MemoView pane with proper label instead of ---", () => {
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-memo",
          name: "Memo WS",
          panes: [
            {
              id: "pane-memo1",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "MemoView" },
            },
          ],
        },
      ],
      activeWorkspaceId: "ws-memo",
    });

    render(<WorkspaceSelectorView />);

    const wsRow = screen.getByTestId("ws-row-2-ws-memo");
    expect(wsRow.textContent).not.toBe("---");
    expect(wsRow.textContent).toContain("MEM");
  });
});
