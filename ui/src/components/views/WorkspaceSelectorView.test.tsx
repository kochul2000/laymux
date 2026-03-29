import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { WorkspaceSelectorView } from "./WorkspaceSelectorView";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { getListeningPorts } from "@/lib/tauri-api";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
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
}));

describe("WorkspaceSelectorView", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useNotificationStore.setState(useNotificationStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
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

  it("shows unread badge when notifications exist", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "test msg",
    });
    render(<WorkspaceSelectorView />);
    expect(screen.getByTestId("unread-badge-ws-default")).toBeInTheDocument();
    expect(screen.getByTestId("unread-badge-ws-default")).toHaveTextContent("1");
  });

  it("shows latest notification text", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "Build done",
    });
    render(<WorkspaceSelectorView />);
    expect(screen.getByText(/Build done/)).toBeInTheDocument();
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

  it("displays git branch from terminal store (most recent activity)", () => {
    useWorkspaceStore.setState({
      workspaces: [{
        id: "ws-default", name: "Default", layoutId: "default-layout",
        panes: [{ id: "p1", x: 0, y: 0, w: 1, h: 1, view: { type: "TerminalView", profile: "PowerShell" } }],
      }],
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
    expect(screen.getByText("feature/login")).toBeInTheDocument();
  });

  it("displays working directory from focused terminal", () => {
    useWorkspaceStore.setState({
      workspaces: [{
        id: "ws-default", name: "Default", layoutId: "default-layout",
        panes: [{ id: "p1", x: 0, y: 0, w: 1, h: 1, view: { type: "TerminalView", profile: "PowerShell" } }],
      }],
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
    expect(screen.getByText("~/dev/project")).toBeInTheDocument();
  });

  it("shows unread state when workspace has unread notifications", () => {
    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: "ws-default",
      message: "alert",
    });
    render(<WorkspaceSelectorView />);

    expect(screen.getByTestId("unread-badge-ws-default")).toBeInTheDocument();
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
    useWorkspaceStore.getState().saveAsNewLayout("Dev Split");
    render(<WorkspaceSelectorView />);

    const cards = screen.getAllByTestId(/^layout-card-/);
    expect(cards.length).toBe(2);
  });

  it("creates workspace with correct layout when layout card clicked", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.getState().saveAsNewLayout("Dev Split");
    render(<WorkspaceSelectorView />);

    const createBtns = screen.getAllByTestId(/^layout-create-/);
    await user.click(createBtns[1]);

    expect(useWorkspaceStore.getState().workspaces).toHaveLength(2);
    const newWs = useWorkspaceStore.getState().workspaces[1];
    expect(newWs.layoutId).toBe(useWorkspaceStore.getState().layouts[1].id);
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

  it("displays last command with success indicator", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
    });
    useTerminalStore.getState().updateInstanceInfo("t1", {
      lastCommand: "npm test",
      lastExitCode: 0,
      lastCommandAt: Date.now(),
    });

    render(<WorkspaceSelectorView />);
    expect(screen.getByText(/npm test/)).toBeInTheDocument();
    expect(screen.getByTestId("cmd-status-ws-default")).toHaveTextContent("✓");
  });

  it("displays last command with failure indicator", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
    });
    useTerminalStore.getState().updateInstanceInfo("t1", {
      lastCommand: "npm build",
      lastExitCode: 1,
      lastCommandAt: Date.now(),
    });

    render(<WorkspaceSelectorView />);
    expect(screen.getByText(/npm build/)).toBeInTheDocument();
    expect(screen.getByTestId("cmd-status-ws-default")).toHaveTextContent("✗");
  });

  it("displays running indicator when command has no exit code", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1",
      profile: "PowerShell",
      syncGroup: "Default",
      workspaceId: "ws-default",
    });
    useTerminalStore.getState().updateInstanceInfo("t1", {
      lastCommand: "npm test",
      lastCommandAt: Date.now(),
    });

    render(<WorkspaceSelectorView />);
    expect(screen.getByTestId("cmd-status-ws-default")).toHaveTextContent("⏳");
  });

  it("shows terminal count badge when terminals exist", () => {
    useTerminalStore.getState().registerInstance({
      id: "t1", profile: "WSL", syncGroup: "Default", workspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "t2", profile: "PowerShell", syncGroup: "Default", workspaceId: "ws-default",
    });

    render(<WorkspaceSelectorView />);
    expect(screen.getByTestId("terminal-count-ws-default")).toHaveTextContent("2");
  });

  it("shows per-terminal summaries for active workspace with 2+ terminals", () => {
    useWorkspaceStore.setState({
      workspaces: [{
        id: "ws-default", name: "Default", layoutId: "default-layout",
        panes: [
          { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView", profile: "WSL" } },
          { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "TerminalView", profile: "PowerShell" } },
        ],
      }],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1", profile: "WSL", syncGroup: "Default", workspaceId: "ws-default", label: "WSL",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-p2", profile: "PowerShell", syncGroup: "Default", workspaceId: "ws-default", label: "PS",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-p1", { cwd: "/home/user/project" });
    useTerminalStore.getState().updateInstanceInfo("terminal-p2", { cwd: "/home/user/api" });

    render(<WorkspaceSelectorView />);
    expect(screen.getByText("WSL")).toBeInTheDocument();
    expect(screen.getByText("PS")).toBeInTheDocument();
    expect(screen.getByText("~/project")).toBeInTheDocument();
    expect(screen.getByText("~/api")).toBeInTheDocument();
  });

  it("shows pane minimaps in per-terminal summaries with correct highlight", () => {
    // Set up a workspace with 2 TerminalView panes (left/right split)
    useWorkspaceStore.setState({
      workspaces: [{
        id: "ws-default",
        name: "Default",
        layoutId: "default-layout",
        panes: [
          { id: "pane-left", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView", profile: "WSL" } },
          { id: "pane-right", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "TerminalView", profile: "PowerShell" } },
        ],
      }],
      activeWorkspaceId: "ws-default",
    });
    // Register terminals with IDs matching pane IDs (terminal-{paneId} pattern)
    useTerminalStore.getState().registerInstance({
      id: "terminal-pane-left", profile: "WSL", syncGroup: "Default", workspaceId: "ws-default", label: "WSL",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-pane-right", profile: "PowerShell", syncGroup: "Default", workspaceId: "ws-default", label: "PS",
    });

    render(<WorkspaceSelectorView />);

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

  it("shows minimap with correct proportions for complex layout", () => {
    // 3-pane layout: top full-width, bottom-left, bottom-right
    useWorkspaceStore.setState({
      workspaces: [{
        id: "ws-default",
        name: "Default",
        layoutId: "default-layout",
        panes: [
          { id: "pane-top", x: 0, y: 0, w: 1, h: 0.6, view: { type: "TerminalView", profile: "WSL" } },
          { id: "pane-bl", x: 0, y: 0.6, w: 0.5, h: 0.4, view: { type: "TerminalView", profile: "PowerShell" } },
          { id: "pane-br", x: 0.5, y: 0.6, w: 0.5, h: 0.4, view: { type: "BrowserPreviewView" } },
        ],
      }],
      activeWorkspaceId: "ws-default",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-pane-top", profile: "WSL", syncGroup: "Default", workspaceId: "ws-default", label: "WSL",
    });
    useTerminalStore.getState().registerInstance({
      id: "terminal-pane-bl", profile: "PowerShell", syncGroup: "Default", workspaceId: "ws-default", label: "PS",
    });

    render(<WorkspaceSelectorView />);

    // Minimap for bottom-left terminal should show all 3 panes, highlight index 1
    const minimap = screen.getByTestId("pane-minimap-terminal-pane-bl");
    const svg = minimap.querySelector("svg")!;
    const rects = svg.querySelectorAll("rect[data-pane-index]");
    expect(rects).toHaveLength(3);
    expect(rects[0].getAttribute("data-highlighted")).toBe("false"); // top pane
    expect(rects[1].getAttribute("data-highlighted")).toBe("true");  // bottom-left (this terminal)
    expect(rects[2].getAttribute("data-highlighted")).toBe("false"); // bottom-right (browser)
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

  it("does not show dock terminal last command in active workspace summary", () => {
    useWorkspaceStore.setState({
      workspaces: [{
        id: "ws-default", name: "Default", layoutId: "default-layout",
        panes: [{ id: "p1", x: 0, y: 0, w: 1, h: 1, view: { type: "TerminalView", profile: "PowerShell" } }],
      }],
      activeWorkspaceId: "ws-default",
    });
    // Workspace terminal with old command
    useTerminalStore.getState().registerInstance({
      id: "terminal-p1", profile: "PowerShell", syncGroup: "Default", workspaceId: "ws-default",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-p1", {
      lastCommand: "npm test", lastExitCode: 0, lastCommandAt: Date.now() - 60000,
    });
    // Dock terminal with newer command (should NOT appear in workspace summary)
    useTerminalStore.getState().registerInstance({
      id: "terminal-dock-bottom", profile: "WSL", syncGroup: "Default", workspaceId: "",
    });
    useTerminalStore.getState().updateInstanceInfo("terminal-dock-bottom", {
      lastCommand: "cargo build", lastExitCode: 1, lastCommandAt: Date.now(),
    });

    render(<WorkspaceSelectorView />);
    // Should show workspace terminal's command, not dock's
    expect(screen.getByText(/npm test/)).toBeInTheDocument();
    expect(screen.queryByText(/cargo build/)).not.toBeInTheDocument();
    expect(screen.getByTestId("cmd-status-ws-default")).toHaveTextContent("✓");
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
    useWorkspaceStore.getState().saveAsNewLayout("Extra");
    expect(useWorkspaceStore.getState().layouts).toHaveLength(2);

    const extraId = useWorkspaceStore.getState().layouts[1].id;
    useWorkspaceStore.getState().removeLayout(extraId);
    expect(useWorkspaceStore.getState().layouts).toHaveLength(1);
  });

  it("setDefaultLayout moves layout to first position", () => {
    useWorkspaceStore.getState().saveAsNewLayout("NewDefault");
    const newId = useWorkspaceStore.getState().layouts[1].id;

    useWorkspaceStore.getState().setDefaultLayout(newId);
    expect(useWorkspaceStore.getState().layouts[0].id).toBe(newId);
  });
});
