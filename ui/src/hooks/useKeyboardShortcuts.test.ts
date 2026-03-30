import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useGridStore } from "@/stores/grid-store";
import { useUiStore } from "@/stores/ui-store";
import { useSettingsStore } from "@/stores/settings-store";

vi.mock("@/lib/tauri-api", () => ({
  loadMemo: vi.fn().mockResolvedValue(""),
  saveMemo: vi.fn().mockResolvedValue(undefined),
  saveSettings: vi.fn().mockResolvedValue(undefined),
}));

function fireKey(
  key: string,
  mods: { ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean } = {},
) {
  document.dispatchEvent(
    new KeyboardEvent("keydown", { key, ...mods, bubbles: true }),
  );
}

describe("useKeyboardShortcuts", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
    useNotificationStore.setState(useNotificationStore.getInitialState());
    useGridStore.setState(useGridStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
  });

  // --- Ctrl+Alt+1~9: workspace switch ---
  it("Ctrl+Alt+1 switches to first workspace", () => {
    useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
    renderHook(() => useKeyboardShortcuts());

    fireKey("1", { ctrlKey: true, altKey: true });

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-default");
  });

  it("Ctrl+Alt+2 switches to second workspace", () => {
    useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
    renderHook(() => useKeyboardShortcuts());

    fireKey("2", { ctrlKey: true, altKey: true });

    const ws2 = useWorkspaceStore.getState().workspaces[1];
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(ws2.id);
  });

  it("Ctrl+Alt+9 switches to last workspace", () => {
    useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
    useWorkspaceStore.getState().addWorkspace("WS3", "default-layout");
    renderHook(() => useKeyboardShortcuts());

    fireKey("9", { ctrlKey: true, altKey: true });

    const lastWs = useWorkspaceStore.getState().workspaces.at(-1)!;
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(lastWs.id);
  });

  // --- Ctrl+Alt+ArrowDown/Up: next/previous workspace ---
  it("Ctrl+Alt+ArrowDown moves to next workspace", () => {
    useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
    renderHook(() => useKeyboardShortcuts());

    fireKey("ArrowDown", { ctrlKey: true, altKey: true });

    const ws2 = useWorkspaceStore.getState().workspaces[1];
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(ws2.id);
  });

  it("Ctrl+Alt+ArrowUp moves to previous workspace (wraps)", () => {
    useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
    renderHook(() => useKeyboardShortcuts());

    fireKey("ArrowUp", { ctrlKey: true, altKey: true });

    const lastWs = useWorkspaceStore.getState().workspaces.at(-1)!;
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(lastWs.id);
  });

  it("workspace switch clears dock focus and sets pane focus", () => {
    useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
    useDockStore.getState().setFocusedDock("left");
    useGridStore.setState({ focusedPaneIndex: null });

    renderHook(() => useKeyboardShortcuts());

    fireKey("ArrowDown", { ctrlKey: true, altKey: true });

    expect(useDockStore.getState().focusedDock).toBeNull();
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
  });

  // --- Ctrl+Shift+B: sidebar toggle ---
  it("Ctrl+Shift+B toggles left dock sidebar", () => {
    renderHook(() => useKeyboardShortcuts());
    const before = useDockStore.getState().getDock("left")?.visible;

    fireKey("B", { ctrlKey: true, shiftKey: true });

    expect(useDockStore.getState().getDock("left")?.visible).toBe(!before);
  });

  // --- Ctrl+Alt+W/R (workspace ops) ---
  it("Ctrl+Alt+W closes current workspace", () => {
    useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
    const ws2 = useWorkspaceStore.getState().workspaces[1];
    useWorkspaceStore.getState().setActiveWorkspace(ws2.id);

    renderHook(() => useKeyboardShortcuts());

    fireKey("W", { ctrlKey: true, altKey: true });

    expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-default");
  });

  it("Ctrl+Alt+W does not close last workspace", () => {
    renderHook(() => useKeyboardShortcuts());

    fireKey("W", { ctrlKey: true, altKey: true });

    expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
  });

  it("Ctrl+Alt+R triggers rename of active workspace", () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Renamed WS");
    renderHook(() => useKeyboardShortcuts());

    fireKey("R", { ctrlKey: true, altKey: true });

    expect(promptSpy).toHaveBeenCalled();
    expect(useWorkspaceStore.getState().workspaces[0].name).toBe("Renamed WS");
    promptSpy.mockRestore();
  });

  it("Ctrl+Alt+R cancels rename on null prompt", () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue(null);
    renderHook(() => useKeyboardShortcuts());

    fireKey("R", { ctrlKey: true, altKey: true });

    expect(useWorkspaceStore.getState().workspaces[0].name).toBe("Default");
    promptSpy.mockRestore();
  });

  it("Ctrl+Shift+U jumps to workspace with unread notifications", () => {
    useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
    const ws2 = useWorkspaceStore.getState().workspaces[1];

    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: ws2.id,
      message: "Build done",
    });

    renderHook(() => useKeyboardShortcuts());

    fireKey("U", { ctrlKey: true, shiftKey: true });

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(ws2.id);
  });

  // --- Ctrl+Shift+I: notification panel ---
  it("Ctrl+Shift+I toggles notification panel", () => {
    renderHook(() => useKeyboardShortcuts());

    expect(useUiStore.getState().notificationPanelOpen).toBe(false);

    fireKey("I", { ctrlKey: true, shiftKey: true });
    expect(useUiStore.getState().notificationPanelOpen).toBe(true);

    fireKey("I", { ctrlKey: true, shiftKey: true });
    expect(useUiStore.getState().notificationPanelOpen).toBe(false);
  });

  // --- Ctrl+, : settings ---
  it("Ctrl+, toggles settings modal", () => {
    renderHook(() => useKeyboardShortcuts());

    expect(useUiStore.getState().settingsModalOpen).toBe(false);

    fireKey(",", { ctrlKey: true });
    expect(useUiStore.getState().settingsModalOpen).toBe(true);

    fireKey(",", { ctrlKey: true });
    expect(useUiStore.getState().settingsModalOpen).toBe(false);
  });

  // --- Delete: remove pane ---
  it("Delete key removes focused pane in edit mode", () => {
    useWorkspaceStore.setState({
      ...useWorkspaceStore.getState(),
      workspaces: [
        {
          id: "ws-default",
          name: "Default",

          panes: [
            { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
            { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "EmptyView" } },
          ],
        },
      ],
    });

    useGridStore.setState({ editMode: true, focusedPaneIndex: 1 });
    renderHook(() => useKeyboardShortcuts());

    fireKey("Delete");

    expect(useWorkspaceStore.getState().workspaces[0].panes).toHaveLength(1);
  });

  it("Delete key does nothing when edit mode is off", () => {
    useWorkspaceStore.setState({
      ...useWorkspaceStore.getState(),
      workspaces: [
        {
          id: "ws-default",
          name: "Default",

          panes: [
            { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
            { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "EmptyView" } },
          ],
        },
      ],
    });

    useGridStore.setState({ editMode: false, focusedPaneIndex: 1 });
    renderHook(() => useKeyboardShortcuts());

    fireKey("Delete");

    expect(useWorkspaceStore.getState().workspaces[0].panes).toHaveLength(2);
  });

  it("Delete key does nothing when no pane is focused", () => {
    useWorkspaceStore.setState({
      ...useWorkspaceStore.getState(),
      workspaces: [
        {
          id: "ws-default",
          name: "Default",

          panes: [
            { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
            { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "EmptyView" } },
          ],
        },
      ],
    });

    useGridStore.setState({ editMode: true, focusedPaneIndex: null });
    renderHook(() => useKeyboardShortcuts());

    fireKey("Delete");

    expect(useWorkspaceStore.getState().workspaces[0].panes).toHaveLength(2);
  });

  // --- Alt+Arrow: pane navigation ---
  it("Alt+ArrowRight moves focus to right pane", () => {
    useWorkspaceStore.setState({
      ...useWorkspaceStore.getState(),
      workspaces: [
        {
          id: "ws-default",
          name: "Default",

          panes: [
            { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
            { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
          ],
        },
      ],
    });

    useGridStore.setState({ focusedPaneIndex: 0 });
    renderHook(() => useKeyboardShortcuts());

    fireKey("ArrowRight", { altKey: true });

    expect(useGridStore.getState().focusedPaneIndex).toBe(1);
  });

  it("Alt+ArrowLeft moves focus to left pane", () => {
    useWorkspaceStore.setState({
      ...useWorkspaceStore.getState(),
      workspaces: [
        {
          id: "ws-default",
          name: "Default",

          panes: [
            { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
            { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
          ],
        },
      ],
    });

    useGridStore.setState({ focusedPaneIndex: 1 });
    renderHook(() => useKeyboardShortcuts());

    fireKey("ArrowLeft", { altKey: true });

    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
  });

  it("Alt+ArrowDown moves focus to bottom pane", () => {
    useWorkspaceStore.setState({
      ...useWorkspaceStore.getState(),
      workspaces: [
        {
          id: "ws-default",
          name: "Default",

          panes: [
            { id: "p1", x: 0, y: 0, w: 1, h: 0.5, view: { type: "TerminalView" } },
            { id: "p2", x: 0, y: 0.5, w: 1, h: 0.5, view: { type: "TerminalView" } },
          ],
        },
      ],
    });

    useGridStore.setState({ focusedPaneIndex: 0 });
    renderHook(() => useKeyboardShortcuts());

    fireKey("ArrowDown", { altKey: true });

    expect(useGridStore.getState().focusedPaneIndex).toBe(1);
  });

  // --- Alt+Arrow: dock navigation ---
  it("Alt+Arrow enters visible dock when no workspace pane in that direction", () => {
    // Left dock is visible by default — single pane workspace, pressing left enters dock
    useGridStore.setState({ focusedPaneIndex: 0 });
    renderHook(() => useKeyboardShortcuts());

    fireKey("ArrowLeft", { altKey: true });

    expect(useDockStore.getState().focusedDock).toBe("left");
    expect(useGridStore.getState().focusedPaneIndex).toBeNull();
  });

  it("Alt+Arrow does not enter hidden dock", () => {
    // Hide the left dock first (it's visible by default)
    useDockStore.getState().toggleDockVisible("left");
    useGridStore.setState({ focusedPaneIndex: 0 });
    renderHook(() => useKeyboardShortcuts());

    fireKey("ArrowLeft", { altKey: true });

    expect(useDockStore.getState().focusedDock).toBeNull();
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
  });

  it("Alt+Arrow exits dock back to workspace", () => {
    // Focus left dock, then press right to exit
    useDockStore.getState().setFocusedDock("left");
    useGridStore.setState({ focusedPaneIndex: null });
    renderHook(() => useKeyboardShortcuts());

    fireKey("ArrowRight", { altKey: true }); // right exits left dock

    expect(useDockStore.getState().focusedDock).toBeNull();
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
  });

  it("Alt+Arrow navigates between docks", () => {
    // Top dock is visible but has no panes by default — add a view so it's navigable
    useDockStore.getState().setDockActiveView("top", "SettingsView");
    useDockStore.getState().setFocusedDock("left");
    renderHook(() => useKeyboardShortcuts());

    fireKey("ArrowUp", { altKey: true }); // from left dock → top dock

    expect(useDockStore.getState().focusedDock).toBe("top");
  });

  it("Alt+Arrow dock nav disabled when dockArrowNav is false", () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      convenience: { ...useSettingsStore.getState().convenience, dockArrowNav: false },
    });
    // Hide left dock to ensure dock nav doesn't interfere
    useDockStore.getState().toggleDockVisible("left");
    useGridStore.setState({ focusedPaneIndex: 0 });
    renderHook(() => useKeyboardShortcuts());

    fireKey("ArrowLeft", { altKey: true });

    // Should NOT enter dock
    expect(useDockStore.getState().focusedDock).toBeNull();
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
  });

  it("Alt+Arrow does nothing when no pane and no dock in that direction", () => {
    useWorkspaceStore.setState({
      ...useWorkspaceStore.getState(),
      workspaces: [
        {
          id: "ws-default",
          name: "Default",

          panes: [
            { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
            { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
          ],
        },
      ],
    });

    // Hide left dock so pressing left at p1 has nowhere to go
    useDockStore.getState().toggleDockVisible("left");
    useGridStore.setState({ focusedPaneIndex: 0 });
    renderHook(() => useKeyboardShortcuts());

    fireKey("ArrowLeft", { altKey: true });

    // Should stay on pane 0
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
  });

  it("Alt+Arrow defaults to pane 0 when no pane is focused", () => {
    useWorkspaceStore.setState({
      ...useWorkspaceStore.getState(),
      workspaces: [
        {
          id: "ws-default",
          name: "Default",

          panes: [
            { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
            { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
          ],
        },
      ],
    });

    useGridStore.setState({ focusedPaneIndex: null });
    renderHook(() => useKeyboardShortcuts());

    fireKey("ArrowRight", { altKey: true });

    expect(useGridStore.getState().focusedPaneIndex).toBe(1);
  });

  it("Alt+Arrow does not enter dock with no panes (empty dock)", () => {
    // Top dock is visible but has no panes by default
    useGridStore.setState({ focusedPaneIndex: 0 });
    renderHook(() => useKeyboardShortcuts());

    fireKey("ArrowUp", { altKey: true });

    // Should NOT enter empty dock
    expect(useDockStore.getState().focusedDock).toBeNull();
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
  });

  it("Alt+Arrow does not navigate to empty dock from another dock", () => {
    // Top dock is visible but has no panes by default
    useDockStore.getState().setFocusedDock("left");
    renderHook(() => useKeyboardShortcuts());

    fireKey("ArrowUp", { altKey: true });

    // Should stay on left dock — top dock has no panes
    expect(useDockStore.getState().focusedDock).toBe("left");
  });

  it("Alt+Arrow same direction as dock position is a no-op", () => {
    // Left Dock → ArrowLeft should do nothing (intentional)
    useDockStore.getState().setFocusedDock("left");
    renderHook(() => useKeyboardShortcuts());

    fireKey("ArrowLeft", { altKey: true });

    expect(useDockStore.getState().focusedDock).toBe("left");
  });

  it("Alt+Arrow in dock when all other docks are hidden stays put", () => {
    // Hide all docks except left
    useDockStore.getState().toggleDockVisible("top");
    useDockStore.getState().toggleDockVisible("bottom");
    useDockStore.getState().toggleDockVisible("right");
    useDockStore.getState().setFocusedDock("left");
    renderHook(() => useKeyboardShortcuts());

    fireKey("ArrowUp", { altKey: true });
    expect(useDockStore.getState().focusedDock).toBe("left");

    fireKey("ArrowDown", { altKey: true });
    expect(useDockStore.getState().focusedDock).toBe("left");
  });

  it("Alt+Arrow exit dock restores pane 0 when focusedPaneIndex was non-null before", () => {
    // Set focusedPaneIndex to 2, then enter dock (clears it), then exit
    useWorkspaceStore.setState({
      ...useWorkspaceStore.getState(),
      workspaces: [
        {
          id: "ws-default",
          name: "Default",

          panes: [
            { id: "p1", x: 0, y: 0, w: 0.33, h: 1, view: { type: "TerminalView" } },
            { id: "p2", x: 0.33, y: 0, w: 0.34, h: 1, view: { type: "TerminalView" } },
            { id: "p3", x: 0.67, y: 0, w: 0.33, h: 1, view: { type: "TerminalView" } },
          ],
        },
      ],
    });
    useGridStore.setState({ focusedPaneIndex: 2 });
    renderHook(() => useKeyboardShortcuts());

    // Enter left dock from pane 0 (leftmost)
    useGridStore.setState({ focusedPaneIndex: 0 });
    fireKey("ArrowLeft", { altKey: true });
    expect(useDockStore.getState().focusedDock).toBe("left");
    expect(useGridStore.getState().focusedPaneIndex).toBeNull();

    // Exit back — currently restores to 0 (known limitation, see PR #66 review comment #2)
    fireKey("ArrowRight", { altKey: true });
    expect(useDockStore.getState().focusedDock).toBeNull();
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);
  });

  // --- Ctrl+Alt+ArrowLeft/Right: notification-based pane navigation ---
  describe("Ctrl+Alt+ArrowLeft (most recent notification)", () => {
    it("navigates to pane with most recent unread notification", () => {
      useWorkspaceStore.setState({
        ...useWorkspaceStore.getState(),
        workspaces: [
          {
            id: "ws-default",
            name: "Default",
  
            panes: [
              { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
              { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
            ],
          },
        ],
      });

      useNotificationStore.setState({
        notifications: [
          { id: "n1", terminalId: "terminal-p1", workspaceId: "ws-default", message: "older", level: "info", createdAt: 100, readAt: null },
          { id: "n2", terminalId: "terminal-p2", workspaceId: "ws-default", message: "newest", level: "info", createdAt: 200, readAt: null },
        ],
      });

      renderHook(() => useKeyboardShortcuts());
      fireKey("ArrowLeft", { ctrlKey: true, altKey: true });

      // Should focus pane index 1 (p2 has the most recent notification)
      expect(useGridStore.getState().focusedPaneIndex).toBe(1);
    });

    it("switches workspace when notification is in a different workspace", () => {
      useWorkspaceStore.setState({
        ...useWorkspaceStore.getState(),
        workspaces: [
          {
            id: "ws-1",
            name: "WS1",
  
            panes: [{ id: "p1", x: 0, y: 0, w: 1, h: 1, view: { type: "TerminalView" } }],
          },
          {
            id: "ws-2",
            name: "WS2",
  
            panes: [{ id: "p2", x: 0, y: 0, w: 1, h: 1, view: { type: "TerminalView" } }],
          },
        ],
        activeWorkspaceId: "ws-1",
      });

      useNotificationStore.getState().addNotification({
        terminalId: "terminal-p2",
        workspaceId: "ws-2",
        message: "alert in ws-2",
      });

      renderHook(() => useKeyboardShortcuts());
      fireKey("ArrowLeft", { ctrlKey: true, altKey: true });

      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-2");
      expect(useGridStore.getState().focusedPaneIndex).toBe(0);
    });

    it("marks only target pane notifications as read", () => {
      useWorkspaceStore.setState({
        ...useWorkspaceStore.getState(),
        workspaces: [
          {
            id: "ws-default",
            name: "Default",
  
            panes: [
              { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
              { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
            ],
          },
        ],
      });

      useNotificationStore.setState({
        notifications: [
          { id: "n1", terminalId: "terminal-p1", workspaceId: "ws-default", message: "p1 alert", level: "info", createdAt: 100, readAt: null },
          { id: "n2", terminalId: "terminal-p2", workspaceId: "ws-default", message: "p2 alert", level: "info", createdAt: 200, readAt: null },
        ],
      });

      renderHook(() => useKeyboardShortcuts());
      fireKey("ArrowLeft", { ctrlKey: true, altKey: true });

      const notifs = useNotificationStore.getState().notifications;
      // p1 notification should still be unread
      expect(notifs.find((n) => n.terminalId === "terminal-p1")!.readAt).toBeNull();
      // p2 notification (most recent) should be marked as read
      expect(notifs.find((n) => n.terminalId === "terminal-p2")!.readAt).not.toBeNull();
    });

    it("marks consecutive same-terminal notifications as read", () => {
      useWorkspaceStore.setState({
        ...useWorkspaceStore.getState(),
        workspaces: [
          {
            id: "ws-default",
            name: "Default",
  
            panes: [
              { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
              { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
            ],
          },
        ],
      });

      useNotificationStore.setState({
        notifications: [
          { id: "n1", terminalId: "terminal-p1", workspaceId: "ws-default", message: "p1 old", level: "info", createdAt: 100, readAt: null },
          { id: "n2", terminalId: "terminal-p2", workspaceId: "ws-default", message: "p2 middle", level: "info", createdAt: 200, readAt: null },
          { id: "n3", terminalId: "terminal-p1", workspaceId: "ws-default", message: "p1 recent", level: "info", createdAt: 300, readAt: null },
        ],
      });

      renderHook(() => useKeyboardShortcuts());
      fireKey("ArrowLeft", { ctrlKey: true, altKey: true });

      const notifs = useNotificationStore.getState().notifications;
      // Sorted desc: n3(p1,300), n2(p2,200), n1(p1,100)
      // Only n3 is consecutive from top (n2 breaks it)
      expect(notifs[2].readAt).not.toBeNull(); // n3 (p1 recent) — read
      expect(notifs[1].readAt).toBeNull();     // n2 (p2) — still unread
      expect(notifs[0].readAt).toBeNull();     // n1 (p1 old) — still unread
    });

    it("does not navigate to already-read (auto-dismissed) notifications", () => {
      useWorkspaceStore.setState({
        ...useWorkspaceStore.getState(),
        workspaces: [
          {
            id: "ws-default",
            name: "Default",
  
            panes: [
              { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
              { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
            ],
          },
        ],
      });

      // All notifications are already read (auto-dismissed)
      useNotificationStore.setState({
        notifications: [
          { id: "n1", terminalId: "terminal-p1", workspaceId: "ws-default", message: "auto-dismissed", level: "info", createdAt: 100, readAt: 105 },
          { id: "n2", terminalId: "terminal-p2", workspaceId: "ws-default", message: "auto-dismissed", level: "info", createdAt: 200, readAt: 205 },
        ],
      });

      useGridStore.setState({ focusedPaneIndex: null });
      renderHook(() => useKeyboardShortcuts());
      fireKey("ArrowLeft", { ctrlKey: true, altKey: true });

      // Should NOT navigate — all notifications are read (no badge visible)
      expect(useGridStore.getState().focusedPaneIndex).toBeNull();
    });

    it("does nothing when no unread notifications exist", () => {
      renderHook(() => useKeyboardShortcuts());
      fireKey("ArrowLeft", { ctrlKey: true, altKey: true });

      // Should remain on default workspace, no crash
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-default");
    });
  });

  describe("Ctrl+Alt+ArrowRight (oldest notification)", () => {
    it("navigates to pane with oldest unread notification", () => {
      useWorkspaceStore.setState({
        ...useWorkspaceStore.getState(),
        workspaces: [
          {
            id: "ws-default",
            name: "Default",
  
            panes: [
              { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
              { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
            ],
          },
        ],
      });

      useNotificationStore.setState({
        notifications: [
          { id: "n1", terminalId: "terminal-p1", workspaceId: "ws-default", message: "oldest", level: "info", createdAt: 100, readAt: null },
          { id: "n2", terminalId: "terminal-p2", workspaceId: "ws-default", message: "newest", level: "info", createdAt: 200, readAt: null },
        ],
      });

      renderHook(() => useKeyboardShortcuts());
      fireKey("ArrowRight", { ctrlKey: true, altKey: true });

      // Should focus pane index 0 (p1 has the oldest notification)
      expect(useGridStore.getState().focusedPaneIndex).toBe(0);
    });

    it("marks consecutive oldest same-terminal notifications as read", () => {
      useWorkspaceStore.setState({
        ...useWorkspaceStore.getState(),
        workspaces: [
          {
            id: "ws-default",
            name: "Default",
  
            panes: [
              { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
              { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
            ],
          },
        ],
      });

      useNotificationStore.setState({
        notifications: [
          { id: "n1", terminalId: "terminal-p1", workspaceId: "ws-default", message: "p1 first", level: "info", createdAt: 100, readAt: null },
          { id: "n2", terminalId: "terminal-p1", workspaceId: "ws-default", message: "p1 second", level: "info", createdAt: 200, readAt: null },
          { id: "n3", terminalId: "terminal-p2", workspaceId: "ws-default", message: "p2 third", level: "info", createdAt: 300, readAt: null },
        ],
      });

      renderHook(() => useKeyboardShortcuts());
      fireKey("ArrowRight", { ctrlKey: true, altKey: true });

      const notifs = useNotificationStore.getState().notifications;
      // Sorted asc: n1(p1,100), n2(p1,200), n3(p2,300)
      // n1, n2 consecutive from p1 — both marked as read
      expect(notifs[0].readAt).not.toBeNull(); // n1
      expect(notifs[1].readAt).not.toBeNull(); // n2
      expect(notifs[2].readAt).toBeNull();     // n3 — still unread
    });
  });

  // --- Old Ctrl+single-key shortcuts should NOT work ---
  it("Ctrl+[ does NOT switch workspace (shell territory)", () => {
    useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
    renderHook(() => useKeyboardShortcuts());

    fireKey("[", { ctrlKey: true });

    // Should stay on default workspace
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-default");
  });

  it("Ctrl+] does NOT switch workspace (shell territory)", () => {
    useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
    renderHook(() => useKeyboardShortcuts());

    fireKey("]", { ctrlKey: true });

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-default");
  });

  it("Ctrl+B does NOT toggle sidebar (shell territory)", () => {
    renderHook(() => useKeyboardShortcuts());
    const before = useDockStore.getState().getDock("left")?.visible;

    fireKey("b", { ctrlKey: true });

    expect(useDockStore.getState().getDock("left")?.visible).toBe(before);
  });

  it("Ctrl+I does NOT toggle notification panel (shell territory)", () => {
    renderHook(() => useKeyboardShortcuts());

    fireKey("i", { ctrlKey: true });

    expect(useUiStore.getState().notificationPanelOpen).toBe(false);
  });

  // --- Ctrl+Alt+N: new workspace ---
  it("Ctrl+Alt+N creates new workspace with default layout", () => {
    renderHook(() => useKeyboardShortcuts());

    expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);

    fireKey("N", { ctrlKey: true, altKey: true });

    expect(useWorkspaceStore.getState().workspaces).toHaveLength(2);
    const newWs = useWorkspaceStore.getState().workspaces[1];
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(newWs.id);
  });

  it("Ctrl+Alt+N uses first layout as default", () => {
    renderHook(() => useKeyboardShortcuts());

    fireKey("N", { ctrlKey: true, altKey: true });

    const newWs = useWorkspaceStore.getState().workspaces[1];

  });

  // --- Lowercase Ctrl+Alt letter keys (case-insensitive) ---
  it("Ctrl+Alt+n (lowercase) creates new workspace", () => {
    renderHook(() => useKeyboardShortcuts());

    expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);

    fireKey("n", { ctrlKey: true, altKey: true });

    expect(useWorkspaceStore.getState().workspaces).toHaveLength(2);
    const newWs = useWorkspaceStore.getState().workspaces[1];
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(newWs.id);
  });

  it("Ctrl+Alt+d (lowercase) duplicates current workspace", () => {
    renderHook(() => useKeyboardShortcuts());

    expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);

    fireKey("d", { ctrlKey: true, altKey: true });

    expect(useWorkspaceStore.getState().workspaces).toHaveLength(2);
    const newWs = useWorkspaceStore.getState().workspaces[1];
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(newWs.id);
  });

  it("Ctrl+Alt+w (lowercase) closes current workspace", () => {
    useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
    const ws2 = useWorkspaceStore.getState().workspaces[1];
    useWorkspaceStore.getState().setActiveWorkspace(ws2.id);

    renderHook(() => useKeyboardShortcuts());

    fireKey("w", { ctrlKey: true, altKey: true });

    expect(useWorkspaceStore.getState().workspaces).toHaveLength(1);
    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-default");
  });

  it("Ctrl+Alt+r (lowercase) triggers rename of active workspace", () => {
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Renamed WS");
    renderHook(() => useKeyboardShortcuts());

    fireKey("r", { ctrlKey: true, altKey: true });

    expect(promptSpy).toHaveBeenCalled();
    expect(useWorkspaceStore.getState().workspaces[0].name).toBe("Renamed WS");
    promptSpy.mockRestore();
  });

  // --- Lowercase Ctrl+Shift letter keys (case-insensitive) ---
  it("Ctrl+Shift+b (lowercase) toggles left dock sidebar", () => {
    renderHook(() => useKeyboardShortcuts());
    const before = useDockStore.getState().getDock("left")?.visible;

    fireKey("b", { ctrlKey: true, shiftKey: true });

    expect(useDockStore.getState().getDock("left")?.visible).toBe(!before);
  });

  it("Ctrl+Shift+i (lowercase) toggles notification panel", () => {
    renderHook(() => useKeyboardShortcuts());

    expect(useUiStore.getState().notificationPanelOpen).toBe(false);

    fireKey("i", { ctrlKey: true, shiftKey: true });
    expect(useUiStore.getState().notificationPanelOpen).toBe(true);
  });

  it("Ctrl+Shift+u (lowercase) jumps to workspace with unread notifications", () => {
    useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
    const ws2 = useWorkspaceStore.getState().workspaces[1];

    useNotificationStore.getState().addNotification({
      terminalId: "t1",
      workspaceId: ws2.id,
      message: "Build done",
    });

    renderHook(() => useKeyboardShortcuts());

    fireKey("u", { ctrlKey: true, shiftKey: true });

    expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(ws2.id);
  });
});
