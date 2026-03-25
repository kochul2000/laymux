import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { useKeyboardShortcuts } from "./useKeyboardShortcuts";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useGridStore } from "@/stores/grid-store";
import { useUiStore } from "@/stores/ui-store";

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
          layoutId: "default-layout",
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
          layoutId: "default-layout",
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
          layoutId: "default-layout",
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
          layoutId: "default-layout",
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
          layoutId: "default-layout",
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
          layoutId: "default-layout",
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

  it("Alt+Arrow does nothing when no pane in that direction", () => {
    useWorkspaceStore.setState({
      ...useWorkspaceStore.getState(),
      workspaces: [
        {
          id: "ws-default",
          name: "Default",
          layoutId: "default-layout",
          panes: [
            { id: "p1", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
            { id: "p2", x: 0.5, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
          ],
        },
      ],
    });

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
          layoutId: "default-layout",
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
    expect(newWs.layoutId).toBe("default-layout");
  });
});
