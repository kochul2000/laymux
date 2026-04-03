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
import { parseOsc, matchHook, type OscHook, type OscEvent } from "@/lib/osc-parser";
import { getPresetHooks } from "@/lib/osc-presets";
import { parseLxCommand, expandHookCommand } from "@/lib/lx-commands";

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

// ============================================================================
// OSC Parser E2E Tests
// ============================================================================

describe("OSC Parser E2E", () => {
  describe("parseOsc", () => {
    it("should parse OSC 7 (CWD change) with BEL terminator", () => {
      const result = parseOsc("\x1b]7;file://localhost/home/user\x07");
      expect(result).not.toBeNull();
      expect(result!.code).toBe(7);
      expect(result!.data).toBe("file://localhost/home/user");
    });

    it("should parse OSC 7 with ST terminator", () => {
      const result = parseOsc("\x1b]7;file://localhost/tmp\x1b\\");
      expect(result).not.toBeNull();
      expect(result!.code).toBe(7);
      expect(result!.data).toBe("file://localhost/tmp");
    });

    it("should parse OSC 133 D (command exit) with exit code", () => {
      const result = parseOsc("\x1b]133;D;1\x07");
      expect(result).not.toBeNull();
      expect(result!.code).toBe(133);
      expect(result!.param).toBe("D");
      expect(result!.data).toBe("1");
    });

    it("should parse OSC 133 D with exit code 0", () => {
      const result = parseOsc("\x1b]133;D;0\x07");
      expect(result!.code).toBe(133);
      expect(result!.param).toBe("D");
      expect(result!.data).toBe("0");
    });

    it("should parse OSC 133 E (command executed)", () => {
      const result = parseOsc("\x1b]133;E;git switch main\x07");
      expect(result!.code).toBe(133);
      expect(result!.param).toBe("E");
      expect(result!.data).toBe("git switch main");
    });

    it("should parse OSC 133 with no semicolons in data", () => {
      const result = parseOsc("\x1b]133;A\x07");
      expect(result!.code).toBe(133);
      expect(result!.param).toBe("A");
      expect(result!.data).toBe("");
    });

    it("should return null for non-OSC input", () => {
      expect(parseOsc("hello world")).toBeNull();
      expect(parseOsc("")).toBeNull();
      expect(parseOsc("\x1b[1;2H")).toBeNull(); // CSI, not OSC
    });

    it("should parse OSC 9 (notification)", () => {
      const result = parseOsc("\x1b]9;Build complete!\x07");
      expect(result!.code).toBe(9);
      expect(result!.data).toBe("Build complete!");
    });

    it("should handle OSC with empty data", () => {
      const result = parseOsc("\x1b]7;\x07");
      expect(result).not.toBeNull();
      expect(result!.code).toBe(7);
      expect(result!.data).toBe("");
    });

    it("should handle OSC embedded in surrounding data", () => {
      const result = parseOsc("some output\x1b]7;/path\x07more output");
      expect(result).not.toBeNull();
      expect(result!.code).toBe(7);
      expect(result!.data).toBe("/path");
    });

    it("should parse OSC with unicode data", () => {
      const result = parseOsc("\x1b]7;file:///홈/사용자\x07");
      expect(result!.data).toBe("file:///홈/사용자");
    });

    it("should handle very long OSC data", () => {
      const longPath = "/a".repeat(5000);
      const result = parseOsc(`\x1b]7;${longPath}\x07`);
      expect(result!.data).toBe(longPath);
    });
  });

  describe("matchHook", () => {
    it("should match hook by OSC code only", () => {
      const hooks: OscHook[] = [{ osc: 7, run: "lx sync-cwd $path" }];
      const event: OscEvent = { code: 7, data: "/home/user" };
      const matched = matchHook(hooks, event);
      expect(matched.length).toBe(1);
    });

    it("should not match hook with wrong OSC code", () => {
      const hooks: OscHook[] = [{ osc: 7, run: "cmd" }];
      const event: OscEvent = { code: 133, param: "D", data: "0" };
      expect(matchHook(hooks, event).length).toBe(0);
    });

    it("should match hook with param filter", () => {
      const hooks: OscHook[] = [
        { osc: 133, param: "D", run: "notify" },
        { osc: 133, param: "E", run: "sync-branch" },
      ];

      const eventD: OscEvent = { code: 133, param: "D", data: "1" };
      expect(matchHook(hooks, eventD).length).toBe(1);
      expect(matchHook(hooks, eventD)[0].run).toBe("notify");

      const eventE: OscEvent = { code: 133, param: "E", data: "git switch main" };
      expect(matchHook(hooks, eventE).length).toBe(1);
      expect(matchHook(hooks, eventE)[0].run).toBe("sync-branch");
    });

    it("should evaluate 'when' condition for notify-on-fail", () => {
      const hooks: OscHook[] = [
        { osc: 133, param: "D", when: "exitCode !== '0'", run: "notify fail" },
      ];

      // Exit code 1 → should match
      const failEvent: OscEvent = { code: 133, param: "D", data: "1" };
      expect(matchHook(hooks, failEvent).length).toBe(1);

      // Exit code 0 → should not match
      const successEvent: OscEvent = { code: 133, param: "D", data: "0" };
      expect(matchHook(hooks, successEvent).length).toBe(0);
    });

    it("should evaluate 'when' condition for sync-branch", () => {
      const hooks: OscHook[] = [
        {
          osc: 133,
          param: "E",
          when: "command.startsWith('git switch') || command.startsWith('git checkout')",
          run: "lx sync-branch",
        },
      ];

      const switchEvent: OscEvent = { code: 133, param: "E", data: "git switch main" };
      expect(matchHook(hooks, switchEvent).length).toBe(1);

      const checkoutEvent: OscEvent = { code: 133, param: "E", data: "git checkout feature" };
      expect(matchHook(hooks, checkoutEvent).length).toBe(1);

      const lsEvent: OscEvent = { code: 133, param: "E", data: "ls -la" };
      expect(matchHook(hooks, lsEvent).length).toBe(0);
    });

    it("should handle malformed 'when' condition gracefully", () => {
      const hooks: OscHook[] = [{ osc: 7, when: "this.is.invalid(((syntax", run: "cmd" }];
      const event: OscEvent = { code: 7, data: "/path" };
      // Should not throw, returns empty
      expect(matchHook(hooks, event).length).toBe(0);
    });

    it("should match multiple hooks for same event", () => {
      const hooks: OscHook[] = [
        { osc: 7, run: "cmd1" },
        { osc: 7, run: "cmd2" },
        { osc: 7, run: "cmd3" },
      ];
      const event: OscEvent = { code: 7, data: "/path" };
      expect(matchHook(hooks, event).length).toBe(3);
    });

    it("should return empty for no hooks", () => {
      const event: OscEvent = { code: 7, data: "/path" };
      expect(matchHook([], event).length).toBe(0);
    });
  });
});

// ============================================================================
// OSC Presets E2E Tests
// ============================================================================

describe("OSC Presets E2E", () => {
  it("sync-cwd preset should match OSC 7 only", () => {
    const hooks = getPresetHooks("sync-cwd");
    expect(hooks.length).toBe(1);
    expect(hooks[0].osc).toBe(7);

    const event: OscEvent = { code: 7, data: "file:///home/user" };
    expect(matchHook(hooks, event).length).toBe(1);

    // OSC 9;9 should NOT match sync-cwd (handled by set-wsl-distro)
    const osc9Event: OscEvent = { code: 9, data: "9;//wsl.localhost/Ubuntu/home/user" };
    expect(matchHook(hooks, osc9Event).length).toBe(0);
  });

  it("sync-branch preset should match git switch/checkout commands", () => {
    const hooks = getPresetHooks("sync-branch");
    expect(hooks.length).toBe(1);
    expect(hooks[0].osc).toBe(133);

    // git switch
    const switchEvent: OscEvent = { code: 133, param: "E", data: "git switch develop" };
    expect(matchHook(hooks, switchEvent).length).toBe(1);

    // git checkout
    const checkoutEvent: OscEvent = { code: 133, param: "E", data: "git checkout -b feature" };
    expect(matchHook(hooks, checkoutEvent).length).toBe(1);

    // Non-git command
    const npmEvent: OscEvent = { code: 133, param: "E", data: "npm install" };
    expect(matchHook(hooks, npmEvent).length).toBe(0);
  });

  it("notify-on-fail preset should match non-zero exit codes", () => {
    const hooks = getPresetHooks("notify-on-fail");

    const failEvent: OscEvent = { code: 133, param: "D", data: "127" };
    expect(matchHook(hooks, failEvent).length).toBe(1);

    const successEvent: OscEvent = { code: 133, param: "D", data: "0" };
    expect(matchHook(hooks, successEvent).length).toBe(0);
  });

  it("set-title-cwd preset should match OSC 7 and OSC 9;9", () => {
    const hooks = getPresetHooks("set-title-cwd");
    expect(hooks.length).toBe(2);
    expect(hooks[0].osc).toBe(7);
    expect(hooks[1].osc).toBe(9);

    const event: OscEvent = { code: 7, data: "/new/path" };
    expect(matchHook(hooks, event).length).toBe(1);
  });

  it("should return empty for unknown preset", () => {
    const hooks = getPresetHooks("nonexistent" as any);
    expect(hooks.length).toBe(0);
  });

  it("all presets together should handle a complete terminal session", () => {
    const allHooks = [
      ...getPresetHooks("sync-cwd"),
      ...getPresetHooks("set-wsl-distro"),
      ...getPresetHooks("sync-branch"),
      ...getPresetHooks("notify-on-fail"),
      ...getPresetHooks("set-title-cwd"),
    ];

    // CWD change via OSC 7 → 2 hooks match (sync-cwd + set-title-cwd)
    const cwdEvent: OscEvent = { code: 7, data: "file:///home/user/project" };
    expect(matchHook(allHooks, cwdEvent).length).toBe(2);

    // Command exit failure → 1 hook (notify-on-fail)
    const failEvent: OscEvent = { code: 133, param: "D", data: "1" };
    expect(matchHook(allHooks, failEvent).length).toBe(1);

    // git switch → 1 hook (sync-branch)
    const gitEvent: OscEvent = { code: 133, param: "E", data: "git switch main" };
    expect(matchHook(allHooks, gitEvent).length).toBe(1);

    // Success exit → 0 hooks
    const successEvent: OscEvent = { code: 133, param: "D", data: "0" };
    expect(matchHook(allHooks, successEvent).length).toBe(0);
  });
});

// ============================================================================
// Lx Command Parser E2E Tests
// ============================================================================

describe("Lx Command Parser E2E", () => {
  describe("parseLxCommand", () => {
    it("should parse basic sync-cwd command", () => {
      const result = parseLxCommand("lx sync-cwd /home/user/project");
      expect(result).not.toBeNull();
      expect(result!.action).toBe("sync-cwd");
      expect(result!.args).toEqual(["/home/user/project"]);
    });

    it("should parse command with flags", () => {
      const result = parseLxCommand("lx sync-cwd /foo --all");
      expect(result!.action).toBe("sync-cwd");
      expect(result!.args).toEqual(["/foo"]);
      expect(result!.flags["all"]).toBe(true);
    });

    it("should parse command with flag value", () => {
      const result = parseLxCommand("lx sync-cwd /foo --group mygroup");
      expect(result!.action).toBe("sync-cwd");
      expect(result!.args).toEqual(["/foo"]);
      expect(result!.flags["group"]).toBe("mygroup");
    });

    it("should parse send-command with quoted string", () => {
      const result = parseLxCommand('lx send-command "echo hello world" --group g1');
      expect(result!.action).toBe("send-command");
      expect(result!.args).toEqual(["echo hello world"]);
      expect(result!.flags["group"]).toBe("g1");
    });

    it("should parse single-quoted strings", () => {
      const result = parseLxCommand("lx notify '빌드 완료'");
      expect(result!.action).toBe("notify");
      expect(result!.args).toEqual(["빌드 완료"]);
    });

    it("should return null for non-lx commands", () => {
      expect(parseLxCommand("git status")).toBeNull();
      expect(parseLxCommand("ls -la")).toBeNull();
      expect(parseLxCommand("")).toBeNull();
    });

    it("should return null for 'lx' alone", () => {
      expect(parseLxCommand("lx")).toBeNull();
      expect(parseLxCommand("lx ")).toBeNull();
    });

    it("should handle multiple args", () => {
      const result = parseLxCommand("lx open-file /path/to/file.rs");
      expect(result!.action).toBe("open-file");
      expect(result!.args).toEqual(["/path/to/file.rs"]);
    });

    it("should handle multiple flags", () => {
      const result = parseLxCommand("lx sync-cwd /foo --all --group mygroup --verbose");
      expect(result!.flags["all"]).toBe(true);
      expect(result!.flags["group"]).toBe("mygroup");
      expect(result!.flags["verbose"]).toBe(true);
    });

    it("should handle no args and no flags", () => {
      const result = parseLxCommand("lx get-cwd");
      expect(result!.action).toBe("get-cwd");
      expect(result!.args).toEqual([]);
      expect(Object.keys(result!.flags)).toEqual([]);
    });

    it("should handle path with spaces in quotes", () => {
      const result = parseLxCommand('lx sync-cwd "/path/with spaces/project"');
      expect(result!.args).toEqual(["/path/with spaces/project"]);
    });

    it("should handle extra whitespace", () => {
      const result = parseLxCommand("lx   sync-cwd   /foo   --all  ");
      expect(result!.action).toBe("sync-cwd");
      expect(result!.args).toEqual(["/foo"]);
      expect(result!.flags["all"]).toBe(true);
    });
  });

  describe("expandHookCommand", () => {
    it("should expand $path variable", () => {
      const result = expandHookCommand("lx sync-cwd $path", { path: "/home/user" });
      expect(result).toBe("lx sync-cwd /home/user");
    });

    it("should expand multiple variables", () => {
      const result = expandHookCommand("$action $path --group $group", {
        action: "sync-cwd",
        path: "/foo",
        group: "mygroup",
      });
      expect(result).toBe("sync-cwd /foo --group mygroup");
    });

    it("should leave unknown variables as-is", () => {
      const result = expandHookCommand("lx sync-cwd $unknown", {});
      expect(result).toBe("lx sync-cwd $unknown");
    });

    it("should handle empty template", () => {
      const result = expandHookCommand("", { path: "/foo" });
      expect(result).toBe("");
    });

    it("should handle template with no variables", () => {
      const result = expandHookCommand("lx get-cwd", { path: "/foo" });
      expect(result).toBe("lx get-cwd");
    });

    it("should expand $exitCode", () => {
      const result = expandHookCommand("lx notify 'Command failed (exit $exitCode)'", {
        exitCode: "1",
      });
      expect(result).toBe("lx notify 'Command failed (exit 1)'");
    });

    it("should handle variable adjacent to text", () => {
      const result = expandHookCommand("prefix$path/suffix", { path: "/home" });
      expect(result).toBe("prefix/home/suffix");
    });
  });
});

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

  it("should handle the full OSC → hook → IDE command pipeline", () => {
    // 1. Terminal outputs an OSC 7 sequence (CWD changed)
    const oscData = "\x1b]7;file:///home/user/new-project\x07";
    const event = parseOsc(oscData)!;
    expect(event.code).toBe(7);

    // 2. Match against preset hooks
    const hooks = getPresetHooks("sync-cwd");
    const matched = matchHook(hooks, event);
    expect(matched.length).toBe(1);

    // 3. Expand the hook command template
    const command = expandHookCommand(matched[0].run, { path: event.data });
    expect(command).toBe("lx sync-cwd file:///home/user/new-project");

    // 4. Parse the expanded command
    const parsed = parseLxCommand(command)!;
    expect(parsed.action).toBe("sync-cwd");
    expect(parsed.args[0]).toBe("file:///home/user/new-project");
  });

  it("should handle the full OSC 133 E → sync-branch pipeline", () => {
    // 1. Terminal reports a git switch command
    const oscData = "\x1b]133;E;git switch develop\x07";
    const event = parseOsc(oscData)!;
    expect(event.code).toBe(133);
    expect(event.param).toBe("E");
    expect(event.data).toBe("git switch develop");

    // 2. Match against sync-branch preset
    const hooks = getPresetHooks("sync-branch");
    const matched = matchHook(hooks, event);
    expect(matched.length).toBe(1);

    // 3. Would expand to: lx sync-branch $branch (branch extracted from git)
    const command = expandHookCommand(matched[0].run, { branch: "develop" });
    expect(command).toBe("lx sync-branch develop");

    // 4. Parse
    const parsed = parseLxCommand(command)!;
    expect(parsed.action).toBe("sync-branch");
    expect(parsed.args[0]).toBe("develop");
  });

  it("should handle the full OSC 133 D → notify-on-fail pipeline", () => {
    // 1. Command exits with non-zero
    const oscData = "\x1b]133;D;127\x07";
    const event = parseOsc(oscData)!;

    // 2. Match notify-on-fail
    const hooks = getPresetHooks("notify-on-fail");
    const matched = matchHook(hooks, event);
    expect(matched.length).toBe(1);

    // 3. Expand
    const command = expandHookCommand(matched[0].run, { exitCode: event.data });
    expect(command).toBe("lx notify --level error 'Command failed (exit 127)'");

    // 4. Parse
    const parsed = parseLxCommand(command)!;
    expect(parsed.action).toBe("notify");
    expect(parsed.flags.level).toBe("error");
    expect(parsed.args[0]).toBe("Command failed (exit 127)");
  });

  it("should NOT trigger notify-on-fail for successful commands", () => {
    const oscData = "\x1b]133;D;0\x07";
    const event = parseOsc(oscData)!;
    const hooks = getPresetHooks("notify-on-fail");
    const matched = matchHook(hooks, event);
    expect(matched.length).toBe(0);
  });
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
