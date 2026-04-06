import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/persist-session", () => ({
  persistSession: vi.fn().mockResolvedValue(undefined),
}));

import { useWorkspaceStore } from "@/stores/workspace-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useSettingsStore } from "@/stores/settings-store";

// ============================================================================
// Workspace Store E2E Tests
// ============================================================================

describe("Workspace Store E2E", () => {
  beforeEach(() => {
    // Reset store to initial state
    useWorkspaceStore.setState({
      layouts: [
        {
          id: "default-layout",
          name: "Default",
          panes: [{ x: 0, y: 0, w: 1, h: 1, viewType: "EmptyView" }],
        },
      ],
      workspaces: [
        {
          id: "ws-default",
          name: "Default",

          panes: [{ id: "p1", x: 0, y: 0, w: 1, h: 1, view: { type: "EmptyView" } }],
        },
      ],
      activeWorkspaceId: "ws-default",
    });
  });

  describe("Pane Split/Merge Lifecycle", () => {
    it("should split horizontally then merge back to original", () => {
      const store = useWorkspaceStore.getState();
      store.splitPane(0, "horizontal");

      let ws = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(ws.panes.length).toBe(2);
      expect(ws.panes[0].h).toBeCloseTo(0.5);
      expect(ws.panes[1].h).toBeCloseTo(0.5);
      expect(ws.panes[1].y).toBeCloseTo(0.5);

      // Remove the second pane (merge back)
      useWorkspaceStore.getState().removePane(1);
      ws = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(ws.panes.length).toBe(1);
      // After merge, the remaining pane absorbs the space
      expect(ws.panes[0].h).toBeCloseTo(1.0);
    });

    it("should split vertically then merge back", () => {
      useWorkspaceStore.getState().splitPane(0, "vertical");

      let ws = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(ws.panes.length).toBe(2);
      expect(ws.panes[0].w).toBeCloseTo(0.5);
      expect(ws.panes[1].w).toBeCloseTo(0.5);
      expect(ws.panes[1].x).toBeCloseTo(0.5);

      useWorkspaceStore.getState().removePane(0);
      ws = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(ws.panes.length).toBe(1);
      expect(ws.panes[0].w).toBeCloseTo(1.0);
    });

    it("should handle multiple sequential splits", () => {
      // Split into 4 panes (2x2 grid)
      useWorkspaceStore.getState().splitPane(0, "horizontal"); // 2 panes stacked
      useWorkspaceStore.getState().splitPane(0, "vertical"); // top-left splits
      useWorkspaceStore.getState().splitPane(2, "vertical"); // bottom splits

      const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(ws.panes.length).toBe(4);

      // Total area should still be covered
      const totalArea = ws.panes.reduce((sum, p) => sum + p.w * p.h, 0);
      expect(totalArea).toBeCloseTo(1.0);
    });

    it("should not split beyond practical limits", () => {
      // Split many times to create tiny panes
      for (let i = 0; i < 10; i++) {
        useWorkspaceStore.getState().splitPane(0, "horizontal");
      }
      const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(ws.panes.length).toBe(11);
      // First pane should be very small
      expect(ws.panes[0].h).toBeCloseTo(1 / 2 ** 10);
    });

    it("should not remove the last pane", () => {
      useWorkspaceStore.getState().removePane(0);
      const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(ws.panes.length).toBe(1); // Still 1 pane
    });

    it("should handle removing out-of-range pane index", () => {
      useWorkspaceStore.getState().removePane(-1);
      useWorkspaceStore.getState().removePane(99);
      const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(ws.panes.length).toBe(1);
    });

    it("should handle splitting out-of-range pane index", () => {
      useWorkspaceStore.getState().splitPane(-1, "horizontal");
      useWorkspaceStore.getState().splitPane(99, "vertical");
      const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(ws.panes.length).toBe(1);
    });
  });

  describe("Pane Resize Edge Cases", () => {
    it("should resize pane with partial delta", () => {
      useWorkspaceStore.getState().resizePane(0, { w: 0.8 });
      const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(ws.panes[0].w).toBe(0.8);
      expect(ws.panes[0].h).toBe(1); // Unchanged
    });

    it("should allow resizing to zero", () => {
      useWorkspaceStore.getState().resizePane(0, { w: 0, h: 0 });
      const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(ws.panes[0].w).toBe(0);
      expect(ws.panes[0].h).toBe(0);
    });

    it("should handle resizing non-existent pane index", () => {
      useWorkspaceStore.getState().resizePane(99, { w: 0.5 });
      const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
      expect(ws.panes[0].w).toBe(1); // Unchanged
    });
  });

  describe("Workspace CRUD Edge Cases", () => {
    it("should not add workspace with nonexistent layout", () => {
      useWorkspaceStore.getState().addWorkspace("New WS", "nonexistent-layout");
      expect(useWorkspaceStore.getState().workspaces.length).toBe(1);
    });

    it("should add workspace with valid layout and inherit panes", () => {
      useWorkspaceStore.getState().addWorkspace("New WS", "default-layout");
      const { workspaces } = useWorkspaceStore.getState();
      expect(workspaces.length).toBe(2);
      expect(workspaces[1].name).toBe("New WS");

      expect(workspaces[1].panes.length).toBe(1);
      expect(workspaces[1].panes[0].view.type).toBe("EmptyView");
    });

    it("should not remove the last workspace", () => {
      useWorkspaceStore.getState().removeWorkspace("ws-default");
      expect(useWorkspaceStore.getState().workspaces.length).toBe(1);
    });

    it("should switch active workspace when removing the active one", () => {
      useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
      const ws2Id = useWorkspaceStore.getState().workspaces[1].id;

      useWorkspaceStore.getState().setActiveWorkspace(ws2Id);
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(ws2Id);

      useWorkspaceStore.getState().removeWorkspace(ws2Id);
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-default");
    });

    it("should not switch to nonexistent workspace", () => {
      useWorkspaceStore.getState().setActiveWorkspace("nonexistent");
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws-default");
    });

    it("should rename workspace with empty string", () => {
      useWorkspaceStore.getState().renameWorkspace("ws-default", "");
      const ws = useWorkspaceStore.getState().workspaces[0];
      expect(ws.name).toBe("");
    });

    it("should rename workspace with unicode", () => {
      useWorkspaceStore.getState().renameWorkspace("ws-default", "프로젝트 A");
      const ws = useWorkspaceStore.getState().workspaces[0];
      expect(ws.name).toBe("프로젝트 A");
    });

    it("should rename nonexistent workspace silently", () => {
      useWorkspaceStore.getState().renameWorkspace("nonexistent", "New Name");
      // Should not throw, original workspace unchanged
      expect(useWorkspaceStore.getState().workspaces[0].name).toBe("Default");
    });
  });

  describe("Layout Actions", () => {
    it("exportAsNewLayout should create new layout from workspace", () => {
      useWorkspaceStore.getState().splitPane(0, "horizontal");
      useWorkspaceStore.getState().exportAsNewLayout("Custom Layout");

      const { layouts } = useWorkspaceStore.getState();
      expect(layouts.length).toBe(2);
      expect(layouts[1].name).toBe("Custom Layout");
      expect(layouts[1].panes.length).toBe(2);
    });

    it("exportToLayout should overwrite existing layout", () => {
      useWorkspaceStore.getState().splitPane(0, "vertical");
      useWorkspaceStore.getState().exportToLayout("default-layout");

      const layout = useWorkspaceStore.getState().layouts[0];
      expect(layout.panes.length).toBe(2);
    });

    it("exportToLayout should preserve view config (profile etc)", () => {
      useWorkspaceStore.getState().setPaneView(0, { type: "TerminalView", profile: "WSL" });
      useWorkspaceStore.getState().exportToLayout("default-layout");

      const layout = useWorkspaceStore.getState().layouts[0];
      expect(layout.panes[0].viewConfig).toEqual({ type: "TerminalView", profile: "WSL" });
    });

    it("addWorkspace from layout with viewConfig should restore view config", () => {
      useWorkspaceStore.getState().setPaneView(0, { type: "TerminalView", profile: "WSL" });
      useWorkspaceStore.getState().exportToLayout("default-layout");

      useWorkspaceStore.getState().addWorkspace("Test WS", "default-layout");

      const ws = useWorkspaceStore.getState().workspaces.find((w) => w.name === "Test WS")!;
      expect(ws.panes[0].view).toEqual({ type: "TerminalView", profile: "WSL" });
    });

    it("exportToLayout should work consecutively on the same layout", () => {
      const layoutId = useWorkspaceStore.getState().layouts[0].id;

      // First overwrite: split and export
      useWorkspaceStore.getState().splitPane(0, "horizontal");
      useWorkspaceStore.getState().exportToLayout(layoutId);
      expect(useWorkspaceStore.getState().layouts[0].panes.length).toBe(2);

      // Second overwrite: split again and export same layout
      useWorkspaceStore.getState().splitPane(0, "vertical");
      const result = useWorkspaceStore.getState().exportToLayout(layoutId);
      expect(result).toBe(true);
      expect(useWorkspaceStore.getState().layouts[0].panes.length).toBe(3);
    });

    it("exportAsNewLayout should not affect other workspaces", () => {
      useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
      useWorkspaceStore.getState().splitPane(0, "vertical");
      useWorkspaceStore.getState().exportAsNewLayout("My Layout");

      const { workspaces } = useWorkspaceStore.getState();
      const ws2 = workspaces.find((ws) => ws.name === "WS2")!;
      // WS2 keeps its original single pane — no propagation
      expect(ws2.panes.length).toBe(1);
    });
  });

  describe("Multiple Workspace Navigation", () => {
    it("should cycle through workspaces", () => {
      useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
      useWorkspaceStore.getState().addWorkspace("WS3", "default-layout");
      const ids = useWorkspaceStore.getState().workspaces.map((ws) => ws.id);

      // Switch to each workspace
      for (const id of ids) {
        useWorkspaceStore.getState().setActiveWorkspace(id);
        expect(useWorkspaceStore.getState().activeWorkspaceId).toBe(id);
      }
    });

    it("should remove middle workspace and keep navigation intact", () => {
      useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
      useWorkspaceStore.getState().addWorkspace("WS3", "default-layout");
      const ws2Id = useWorkspaceStore.getState().workspaces[1].id;

      useWorkspaceStore.getState().removeWorkspace(ws2Id);
      const { workspaces } = useWorkspaceStore.getState();
      expect(workspaces.length).toBe(2);
      expect(workspaces[0].name).toBe("Default");
      expect(workspaces[1].name).toBe("WS3");
    });
  });
});

// ============================================================================
// Terminal Store E2E Tests
// ============================================================================

describe("Terminal Store E2E", () => {
  beforeEach(() => {
    useTerminalStore.setState({ instances: [] });
  });

  it("should register and unregister terminals", () => {
    const store = useTerminalStore.getState();
    store.registerInstance({ id: "t1", profile: "WSL", syncGroup: "g1", workspaceId: "ws-1" });
    store.registerInstance({
      id: "t2",
      profile: "PowerShell",
      syncGroup: "g1",
      workspaceId: "ws-1",
    });
    store.registerInstance({
      id: "t3",
      profile: "PowerShell",
      syncGroup: "g2",
      workspaceId: "ws-1",
    });

    expect(useTerminalStore.getState().instances.length).toBe(3);

    useTerminalStore.getState().unregisterInstance("t2");
    expect(useTerminalStore.getState().instances.length).toBe(2);
    expect(useTerminalStore.getState().instances.map((i) => i.id)).toEqual(["t1", "t3"]);
  });

  it("should filter by sync group", () => {
    const store = useTerminalStore.getState();
    store.registerInstance({
      id: "t1",
      profile: "WSL",
      syncGroup: "project-a",
      workspaceId: "ws-1",
    });
    store.registerInstance({
      id: "t2",
      profile: "WSL",
      syncGroup: "project-a",
      workspaceId: "ws-1",
    });
    store.registerInstance({
      id: "t3",
      profile: "PowerShell",
      syncGroup: "project-b",
      workspaceId: "ws-1",
    });
    store.registerInstance({ id: "t4", profile: "WSL", syncGroup: "", workspaceId: "ws-1" }); // independent

    const groupA = useTerminalStore.getState().getInstancesBySyncGroup("project-a");
    expect(groupA.length).toBe(2);

    const groupB = useTerminalStore.getState().getInstancesBySyncGroup("project-b");
    expect(groupB.length).toBe(1);

    const independent = useTerminalStore.getState().getInstancesBySyncGroup("");
    expect(independent.length).toBe(1);

    const nonexistent = useTerminalStore.getState().getInstancesBySyncGroup("nonexistent");
    expect(nonexistent.length).toBe(0);
  });

  it("should update instance info partially", () => {
    useTerminalStore
      .getState()
      .registerInstance({ id: "t1", profile: "WSL", syncGroup: "g1", workspaceId: "ws-1" });

    useTerminalStore.getState().updateInstanceInfo("t1", { cwd: "/home/user" });
    expect(useTerminalStore.getState().instances[0].cwd).toBe("/home/user");
    expect(useTerminalStore.getState().instances[0].branch).toBeUndefined();

    useTerminalStore.getState().updateInstanceInfo("t1", { branch: "main" });
    expect(useTerminalStore.getState().instances[0].cwd).toBe("/home/user");
    expect(useTerminalStore.getState().instances[0].branch).toBe("main");

    useTerminalStore.getState().updateInstanceInfo("t1", { title: "My Terminal" });
    expect(useTerminalStore.getState().instances[0].title).toBe("My Terminal");
    expect(useTerminalStore.getState().instances[0].cwd).toBe("/home/user"); // Still preserved
  });

  it("should handle updating nonexistent instance gracefully", () => {
    useTerminalStore.getState().updateInstanceInfo("nonexistent", { cwd: "/foo" });
    expect(useTerminalStore.getState().instances.length).toBe(0);
  });

  it("should handle unregistering nonexistent instance", () => {
    useTerminalStore
      .getState()
      .registerInstance({ id: "t1", profile: "WSL", syncGroup: "g1", workspaceId: "ws-1" });
    useTerminalStore.getState().unregisterInstance("nonexistent");
    expect(useTerminalStore.getState().instances.length).toBe(1);
  });

  it("should handle many instances", () => {
    for (let i = 0; i < 100; i++) {
      useTerminalStore.getState().registerInstance({
        id: `t-${i}`,
        profile: i % 2 === 0 ? "WSL" : "PowerShell",
        syncGroup: `group-${i % 5}`,
        workspaceId: "ws-1",
      });
    }
    expect(useTerminalStore.getState().instances.length).toBe(100);

    const group0 = useTerminalStore.getState().getInstancesBySyncGroup("group-0");
    expect(group0.length).toBe(20);
  });
});

// ============================================================================
// Dock Store E2E Tests
// ============================================================================

describe("Dock Store E2E", () => {
  beforeEach(() => {
    useDockStore.setState({
      docks: [
        { position: "top", activeView: null, views: [], visible: true, size: 200, panes: [] },
        { position: "bottom", activeView: null, views: [], visible: true, size: 200, panes: [] },
        {
          position: "left",
          activeView: "WorkspaceSelectorView",
          views: ["WorkspaceSelectorView", "SettingsView"],
          visible: true,
          size: 250,
          panes: [],
        },
        { position: "right", activeView: null, views: [], visible: true, size: 200, panes: [] },
      ],
    });
  });

  it("should toggle dock visibility repeatedly", () => {
    for (let i = 0; i < 10; i++) {
      useDockStore.getState().toggleDockVisible("left");
    }
    // 10 toggles = back to original (visible)
    expect(useDockStore.getState().getDock("left")!.visible).toBe(true);
  });

  it("should toggle odd number of times to hidden", () => {
    for (let i = 0; i < 7; i++) {
      useDockStore.getState().toggleDockVisible("left");
    }
    expect(useDockStore.getState().getDock("left")!.visible).toBe(false);
  });

  it("should set active view for each position independently", () => {
    useDockStore.getState().setDockActiveView("top", "SettingsView");
    useDockStore.getState().setDockActiveView("bottom", "TerminalView");
    useDockStore.getState().setDockActiveView("right", "EmptyView");

    expect(useDockStore.getState().getDock("top")!.activeView).toBe("SettingsView");
    expect(useDockStore.getState().getDock("bottom")!.activeView).toBe("TerminalView");
    expect(useDockStore.getState().getDock("left")!.activeView).toBe("WorkspaceSelectorView"); // Unchanged
    expect(useDockStore.getState().getDock("right")!.activeView).toBe("EmptyView");
  });

  it("should return undefined for nonexistent dock position", () => {
    expect(useDockStore.getState().getDock("center" as any)).toBeUndefined();
  });

  it("should allow toggling all docks independently", () => {
    useDockStore.getState().toggleDockVisible("top");
    useDockStore.getState().toggleDockVisible("bottom");
    useDockStore.getState().toggleDockVisible("left");
    useDockStore.getState().toggleDockVisible("right");

    const state = useDockStore.getState();
    expect(state.getDock("top")!.visible).toBe(false);
    expect(state.getDock("bottom")!.visible).toBe(false);
    expect(state.getDock("left")!.visible).toBe(false);
    expect(state.getDock("right")!.visible).toBe(false);
  });
});

// ============================================================================
// Grid Store E2E Tests
// ============================================================================

describe("Grid Store E2E", () => {
  beforeEach(() => {
    useGridStore.setState({ editMode: false, focusedPaneIndex: null });
  });

  it("should toggle edit mode on and off", () => {
    useGridStore.getState().toggleEditMode();
    expect(useGridStore.getState().editMode).toBe(true);

    useGridStore.getState().toggleEditMode();
    expect(useGridStore.getState().editMode).toBe(false);
  });

  it("should track focused pane", () => {
    useGridStore.getState().setFocusedPane(0);
    expect(useGridStore.getState().focusedPaneIndex).toBe(0);

    useGridStore.getState().setFocusedPane(5);
    expect(useGridStore.getState().focusedPaneIndex).toBe(5);

    useGridStore.getState().setFocusedPane(null);
    expect(useGridStore.getState().focusedPaneIndex).toBeNull();
  });

  it("should handle negative pane index", () => {
    useGridStore.getState().setFocusedPane(-1);
    expect(useGridStore.getState().focusedPaneIndex).toBe(-1);
  });
});

// ============================================================================
// Notification Store E2E Tests
// ============================================================================

describe("Notification Store E2E", () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [] });
  });

  it("should track notifications per workspace", () => {
    const store = useNotificationStore.getState();
    store.addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "Build started" });
    store.addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "Build complete" });
    store.addNotification({ terminalId: "t1", workspaceId: "ws-2", message: "Tests failed" });

    expect(useNotificationStore.getState().getUnreadCount("ws-1")).toBe(2);
    expect(useNotificationStore.getState().getUnreadCount("ws-2")).toBe(1);
    expect(useNotificationStore.getState().getUnreadCount("ws-3")).toBe(0);
  });

  it("should mark read per workspace without affecting others", () => {
    useNotificationStore
      .getState()
      .addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "msg1" });
    useNotificationStore
      .getState()
      .addNotification({ terminalId: "t1", workspaceId: "ws-2", message: "msg2" });

    useNotificationStore.getState().markWorkspaceAsRead("ws-1");
    expect(useNotificationStore.getState().getUnreadCount("ws-1")).toBe(0);
    expect(useNotificationStore.getState().getUnreadCount("ws-2")).toBe(1);
  });

  it("should get latest notification per workspace", () => {
    useNotificationStore
      .getState()
      .addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "first" });
    useNotificationStore
      .getState()
      .addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "second" });
    useNotificationStore
      .getState()
      .addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "third" });

    const latest = useNotificationStore.getState().getLatestNotification("ws-1");
    expect(latest?.message).toBe("third");
  });

  it("should return undefined for workspace with no notifications", () => {
    const latest = useNotificationStore.getState().getLatestNotification("empty-ws");
    expect(latest).toBeUndefined();
  });

  it("should handle marking read on workspace with no notifications", () => {
    useNotificationStore.getState().markWorkspaceAsRead("empty-ws");
    expect(useNotificationStore.getState().notifications.length).toBe(0);
  });

  it("should handle many notifications", () => {
    for (let i = 0; i < 1000; i++) {
      useNotificationStore
        .getState()
        .addNotification({ terminalId: "t1", workspaceId: "ws-1", message: `Notification ${i}` });
    }
    expect(useNotificationStore.getState().notifications.length).toBe(1000);
    expect(useNotificationStore.getState().getUnreadCount("ws-1")).toBe(1000);

    useNotificationStore.getState().markWorkspaceAsRead("ws-1");
    expect(useNotificationStore.getState().getUnreadCount("ws-1")).toBe(0);
  });

  it("should add notifications after mark-read and show new unread", () => {
    useNotificationStore
      .getState()
      .addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "old" });
    useNotificationStore.getState().markWorkspaceAsRead("ws-1");
    useNotificationStore
      .getState()
      .addNotification({ terminalId: "t1", workspaceId: "ws-1", message: "new" });

    expect(useNotificationStore.getState().getUnreadCount("ws-1")).toBe(1);
    expect(useNotificationStore.getState().getLatestNotification("ws-1")?.message).toBe("new");
  });
});

// ============================================================================
// Settings Store E2E Tests
// ============================================================================

/** Helper: build a full Profile with defaults for test mocks. */
function makeTestProfile(overrides: {
  name: string;
  commandLine: string;
  colorScheme?: string;
  startingDirectory?: string;
  hidden?: boolean;
}): import("@/stores/settings-store").Profile {
  return {
    colorScheme: "",
    startingDirectory: "",
    hidden: false,
    startupCommand: "",
    cursorShape: "bar",
    padding: { top: 8, right: 8, bottom: 8, left: 8 },
    scrollbackLines: 9001,
    opacity: 100,
    tabTitle: "",
    bellStyle: "audible",
    closeOnExit: "automatic",
    antialiasingMode: "grayscale",
    suppressApplicationTitle: false,
    snapOnInput: true,
    ...overrides,
  };
}

/** Helper: build a full ColorScheme with defaults for test mocks. */
function makeTestColorScheme(overrides: {
  name: string;
  foreground?: string;
  background?: string;
}): import("@/stores/settings-store").ColorScheme {
  return {
    foreground: "#CCCCCC",
    background: "#1E1E1E",
    cursorColor: "#FFFFFF",
    selectionBackground: "#264F78",
    black: "#0C0C0C",
    red: "#C50F1F",
    green: "#13A10E",
    yellow: "#C19C00",
    blue: "#0037DA",
    purple: "#881798",
    cyan: "#3A96DD",
    white: "#CCCCCC",
    brightBlack: "#767676",
    brightRed: "#E74856",
    brightGreen: "#16C60C",
    brightYellow: "#F9F1A5",
    brightBlue: "#3B78FF",
    brightPurple: "#B4009E",
    brightCyan: "#61D6D6",
    brightWhite: "#F2F2F2",
    ...overrides,
  };
}

describe("Settings Store E2E", () => {
  beforeEach(() => {
    useSettingsStore.setState({
      defaultProfile: "PowerShell",
      profiles: [
        makeTestProfile({ name: "PowerShell", commandLine: "powershell.exe -NoLogo" }),
        makeTestProfile({ name: "WSL", commandLine: "wsl.exe" }),
      ],
      colorSchemes: [],
      keybindings: [],
    });
  });

  it("should load bulk settings via loadFromSettings", () => {
    useSettingsStore.getState().loadFromSettings({
      profileDefaults: { font: { face: "Fira Code", size: 16, weight: "normal" } } as any,
      defaultProfile: "WSL",
      colorSchemes: [makeTestColorScheme({ name: "Dark", foreground: "#fff", background: "#000" })],
    });

    const state = useSettingsStore.getState();
    expect(state.profileDefaults.font.face).toBe("Fira Code");
    expect(state.profileDefaults.font.size).toBe(16);
    expect(state.defaultProfile).toBe("WSL");
    // 10 builtins + 1 loaded = 11 (builtins are always merged)
    expect(state.colorSchemes.length).toBe(11);
    // Profiles should remain unchanged since not in the update
    expect(state.profiles.length).toBe(2);
  });

  it("should add and remove color schemes", () => {
    useSettingsStore
      .getState()
      .addColorScheme(
        makeTestColorScheme({ name: "Solarized", foreground: "#839496", background: "#002b36" }),
      );
    useSettingsStore
      .getState()
      .addColorScheme(
        makeTestColorScheme({ name: "Monokai", foreground: "#F8F8F2", background: "#272822" }),
      );

    expect(useSettingsStore.getState().colorSchemes.length).toBe(2);

    useSettingsStore.getState().removeColorScheme(0);
    expect(useSettingsStore.getState().colorSchemes.length).toBe(1);
    expect(useSettingsStore.getState().colorSchemes[0].name).toBe("Monokai");
  });

  it("should add and remove keybindings", () => {
    useSettingsStore.getState().addKeybinding({ keys: "ctrl+t", command: "newTab" });
    useSettingsStore.getState().addKeybinding({ keys: "ctrl+w", command: "closeTab" });

    expect(useSettingsStore.getState().keybindings.length).toBe(2);

    useSettingsStore.getState().removeKeybinding(0);
    expect(useSettingsStore.getState().keybindings[0].keys).toBe("ctrl+w");
  });

  it("should handle removing at out-of-range index", () => {
    useSettingsStore
      .getState()
      .addColorScheme(makeTestColorScheme({ name: "Test", foreground: "", background: "" }));
    useSettingsStore.getState().removeColorScheme(99);
    // Should not remove anything
    expect(useSettingsStore.getState().colorSchemes.length).toBe(1);
  });

  it("should handle font size edge values via profileDefaults", () => {
    useSettingsStore
      .getState()
      .setProfileDefaults({ font: { face: "Mono", size: 0, weight: "normal" } });
    expect(useSettingsStore.getState().profileDefaults.font.size).toBe(0);

    useSettingsStore
      .getState()
      .setProfileDefaults({ font: { face: "Mono", size: 999, weight: "normal" } });
    expect(useSettingsStore.getState().profileDefaults.font.size).toBe(999);
  });

  it("should handle empty font face via profileDefaults", () => {
    useSettingsStore
      .getState()
      .setProfileDefaults({ font: { face: "", size: 14, weight: "normal" } });
    expect(useSettingsStore.getState().profileDefaults.font.face).toBe("");
  });
});

// NOTE: OSC Parser, OSC Presets, and Lx Command Parser E2E tests have been
// removed — OSC processing is now centralized in Rust (src-tauri/src/osc.rs,
// osc_hooks.rs). Equivalent tests exist in Rust unit tests.

// ============================================================================

// (OSC tests removed — now in Rust)

// ============================================================================
// Cross-Store Integration E2E Tests
// ============================================================================

describe("Cross-Store Integration E2E", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      layouts: [
        {
          id: "default-layout",
          name: "Default",
          panes: [{ x: 0, y: 0, w: 1, h: 1, viewType: "EmptyView" }],
        },
      ],
      workspaces: [
        {
          id: "ws-1",
          name: "Project A",

          panes: [{ id: "p1", x: 0, y: 0, w: 1, h: 1, view: { type: "TerminalView" } }],
        },
      ],
      activeWorkspaceId: "ws-1",
    });
    useTerminalStore.setState({ instances: [] });
    useNotificationStore.setState({ notifications: [] });
    useDockStore.setState({
      docks: [
        { position: "top", activeView: null, views: [], visible: true, size: 200, panes: [] },
        { position: "bottom", activeView: null, views: [], visible: true, size: 200, panes: [] },
        {
          position: "left",
          activeView: "WorkspaceSelectorView",
          views: ["WorkspaceSelectorView"],
          visible: true,
          size: 250,
          panes: [],
        },
        { position: "right", activeView: null, views: [], visible: true, size: 200, panes: [] },
      ],
    });
    useGridStore.setState({ editMode: false, focusedPaneIndex: null });
  });

  it("should simulate full workspace session with terminals and notifications", () => {
    // 1. Register terminals in a workspace
    useTerminalStore
      .getState()
      .registerInstance({ id: "t1", profile: "WSL", syncGroup: "Project A", workspaceId: "ws-1" });
    useTerminalStore.getState().registerInstance({
      id: "t2",
      profile: "PowerShell",
      syncGroup: "Project A",
      workspaceId: "ws-1",
    });

    // 2. Receive sync-cwd event (simulate backend event)
    const targets = ["t1", "t2"];
    for (const id of targets) {
      useTerminalStore.getState().updateInstanceInfo(id, { cwd: "/home/user/project" });
    }

    // 3. Receive notification for a non-active workspace
    useNotificationStore
      .getState()
      .addNotification({ terminalId: "t1", workspaceId: "ws-other", message: "Build complete" });

    // 4. Verify state (active workspace is ws-1, notification is for ws-other so it stays unread)
    const instances = useTerminalStore.getState().instances;
    expect(instances.every((i) => i.cwd === "/home/user/project")).toBe(true);
    expect(useNotificationStore.getState().getUnreadCount("ws-other")).toBe(1);

    // 5. Switch workspace marks notification as read
    useNotificationStore.getState().markWorkspaceAsRead("ws-other");
    expect(useNotificationStore.getState().getUnreadCount("ws-other")).toBe(0);
  });

  it("should simulate sync-branch updating all group terminals", () => {
    useTerminalStore
      .getState()
      .registerInstance({ id: "t1", profile: "WSL", syncGroup: "dev", workspaceId: "ws-1" });
    useTerminalStore
      .getState()
      .registerInstance({ id: "t2", profile: "WSL", syncGroup: "dev", workspaceId: "ws-1" });
    useTerminalStore.getState().registerInstance({
      id: "t3",
      profile: "PowerShell",
      syncGroup: "other",
      workspaceId: "ws-1",
    });

    // Sync branch for "dev" group
    const groupTerminals = useTerminalStore.getState().getInstancesBySyncGroup("dev");
    for (const t of groupTerminals) {
      useTerminalStore.getState().updateInstanceInfo(t.id, { branch: "feature/login" });
    }

    // Only "dev" group terminals should be updated
    const t1 = useTerminalStore.getState().instances.find((i) => i.id === "t1")!;
    const t2 = useTerminalStore.getState().instances.find((i) => i.id === "t2")!;
    const t3 = useTerminalStore.getState().instances.find((i) => i.id === "t3")!;
    expect(t1.branch).toBe("feature/login");
    expect(t2.branch).toBe("feature/login");
    expect(t3.branch).toBeUndefined();
  });

  it("should simulate workspace switching with edit mode reset", () => {
    // Enter edit mode
    useGridStore.getState().toggleEditMode();
    useGridStore.getState().setFocusedPane(0);
    expect(useGridStore.getState().editMode).toBe(true);

    // Add new workspace and switch
    useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
    const ws2Id = useWorkspaceStore.getState().workspaces[1].id;
    useWorkspaceStore.getState().setActiveWorkspace(ws2Id);

    // Edit mode and focused pane should be independent of workspace
    expect(useGridStore.getState().editMode).toBe(true); // Still on
    expect(useGridStore.getState().focusedPaneIndex).toBe(0); // Still set
  });

  it("should simulate dock toggle affecting layout visibility", () => {
    // Toggle left dock off
    useDockStore.getState().toggleDockVisible("left");
    expect(useDockStore.getState().getDock("left")!.visible).toBe(false);

    // Workspace and terminal state should be unaffected
    expect(useWorkspaceStore.getState().getActiveWorkspace()).toBeDefined();
    expect(useTerminalStore.getState().instances.length).toBe(0);
  });

  it("should handle notifications for multiple workspaces simultaneously", () => {
    // active workspace is ws-1; create two more non-active workspaces
    useWorkspaceStore.getState().addWorkspace("WS2", "default-layout");
    useWorkspaceStore.getState().addWorkspace("WS3", "default-layout");
    const ws2Id = useWorkspaceStore.getState().workspaces[1].id;
    const ws3Id = useWorkspaceStore.getState().workspaces[2].id;

    // Notifications arrive for non-active workspaces (ws-1 is active, so use ws2/ws3)
    useNotificationStore
      .getState()
      .addNotification({ terminalId: "t1", workspaceId: ws2Id, message: "Build failed" });
    useNotificationStore
      .getState()
      .addNotification({ terminalId: "t1", workspaceId: ws3Id, message: "Tests passed" });
    useNotificationStore
      .getState()
      .addNotification({ terminalId: "t1", workspaceId: ws2Id, message: "Retry started" });

    expect(useNotificationStore.getState().getUnreadCount(ws2Id)).toBe(2);
    expect(useNotificationStore.getState().getUnreadCount(ws3Id)).toBe(1);

    // Mark ws2 as read
    useNotificationStore.getState().markWorkspaceAsRead(ws2Id);
    expect(useNotificationStore.getState().getUnreadCount(ws2Id)).toBe(0);
    expect(useNotificationStore.getState().getUnreadCount(ws3Id)).toBe(1); // Still unread
  });

  it("should simulate terminal close and sync group cleanup", () => {
    useTerminalStore
      .getState()
      .registerInstance({ id: "t1", profile: "WSL", syncGroup: "g1", workspaceId: "ws-1" });
    useTerminalStore
      .getState()
      .registerInstance({ id: "t2", profile: "WSL", syncGroup: "g1", workspaceId: "ws-1" });
    useTerminalStore
      .getState()
      .registerInstance({ id: "t3", profile: "PowerShell", syncGroup: "g1", workspaceId: "ws-1" });

    expect(useTerminalStore.getState().getInstancesBySyncGroup("g1").length).toBe(3);

    // Close terminals one by one
    useTerminalStore.getState().unregisterInstance("t1");
    expect(useTerminalStore.getState().getInstancesBySyncGroup("g1").length).toBe(2);

    useTerminalStore.getState().unregisterInstance("t2");
    expect(useTerminalStore.getState().getInstancesBySyncGroup("g1").length).toBe(1);

    useTerminalStore.getState().unregisterInstance("t3");
    expect(useTerminalStore.getState().getInstancesBySyncGroup("g1").length).toBe(0);
  });

  // OSC pipeline integration tests removed — now in Rust (osc.rs, osc_hooks.rs)
  // The full OSC → hook → dispatch pipeline is tested in Rust unit tests.
});

// ============================================================================
// Complex Workspace Layout Scenarios
// ============================================================================

describe("Complex Workspace Layout Scenarios", () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      layouts: [
        {
          id: "dev-split",
          name: "Dev Split",
          panes: [
            { x: 0, y: 0, w: 1, h: 0.6, viewType: "TerminalView" },
            { x: 0, y: 0.6, w: 0.5, h: 0.4, viewType: "TerminalView" },
            { x: 0.5, y: 0.6, w: 0.5, h: 0.4, viewType: "TerminalView" },
          ],
        },
      ],
      workspaces: [
        {
          id: "ws-a",
          name: "Project A",

          panes: [
            { id: "p1", x: 0, y: 0, w: 1, h: 0.6, view: { type: "TerminalView" } },
            { id: "p2", x: 0, y: 0.6, w: 0.5, h: 0.4, view: { type: "TerminalView" } },
            { id: "p3", x: 0.5, y: 0.6, w: 0.5, h: 0.4, view: { type: "TerminalView" } },
          ],
        },
      ],
      activeWorkspaceId: "ws-a",
    });
  });

  it("should create multiple workspaces sharing the same layout", () => {
    useWorkspaceStore.getState().addWorkspace("Project B", "dev-split");
    useWorkspaceStore.getState().addWorkspace("Project C", "dev-split");

    const { workspaces } = useWorkspaceStore.getState();
    expect(workspaces.length).toBe(3);

    // All have 3 panes from the dev-split layout
    for (const ws of workspaces) {
      expect(ws.panes.length).toBe(3);
    }
  });

  it("exportToLayout should update layout without affecting other workspaces", () => {
    useWorkspaceStore.getState().addWorkspace("Project B", "dev-split");

    // Split a pane in Project A
    useWorkspaceStore.getState().splitPane(0, "horizontal");
    expect(useWorkspaceStore.getState().getActiveWorkspace()!.panes.length).toBe(4);

    // Export to existing layout
    useWorkspaceStore.getState().exportToLayout("dev-split");

    // Layout should be updated
    const layout = useWorkspaceStore.getState().layouts.find((l) => l.id === "dev-split")!;
    expect(layout.panes.length).toBe(4);

    // Project B should NOT be affected (independent workspace)
    const wsB = useWorkspaceStore.getState().workspaces.find((ws) => ws.name === "Project B")!;
    expect(wsB.panes.length).toBe(3); // Still original 3 panes
  });

  it("should handle removing a pane from a multi-pane layout", () => {
    // Remove the bottom-left pane (index 1)
    useWorkspaceStore.getState().removePane(1);
    const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
    expect(ws.panes.length).toBe(2);
  });

  it("should handle removing panes until only one remains", () => {
    useWorkspaceStore.getState().removePane(2);
    useWorkspaceStore.getState().removePane(1);
    const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
    expect(ws.panes.length).toBe(1);

    // Cannot remove the last pane
    useWorkspaceStore.getState().removePane(0);
    expect(useWorkspaceStore.getState().getActiveWorkspace()!.panes.length).toBe(1);
  });
});
