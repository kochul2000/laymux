import { beforeEach, describe, expect, it } from "vitest";

import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import type { Workspace, WorkspacePane } from "@/stores/types";

import { notificationStep, spatialStep } from "./navigation-actions";

function term(id: string, x: number, y: number, w = 0.5, h = 0.5): WorkspacePane {
  return { id, x, y, w, h, view: { type: "TerminalView" } };
}

function memo(id: string, x: number, y: number, w = 0.5, h = 0.5): WorkspacePane {
  return { id, x, y, w, h, view: { type: "MemoView" } };
}

function ws(id: string, name: string, panes: WorkspacePane[]): Workspace {
  return { id, name, panes };
}

/** Two workspaces: ws1 [a(1), b(2)], ws2 [c(1)]. */
function seedTwoWorkspaces() {
  useWorkspaceStore.setState({
    workspaces: [
      ws("ws1", "One", [term("a", 0, 0), term("b", 0.5, 0)]),
      ws("ws2", "Two", [term("c", 0, 0, 1, 1)]),
    ],
    activeWorkspaceId: "ws1",
    workspaceDisplayOrder: [],
  });
}

describe("navigation-actions", () => {
  beforeEach(() => {
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
    useNotificationStore.setState(useNotificationStore.getInitialState());
    useGridStore.setState(useGridStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
  });

  describe("spatialStep", () => {
    it("moves to the next pane within the active workspace", () => {
      seedTwoWorkspaces();
      useGridStore.getState().setFocusedPane(0); // pane a

      const result = spatialStep("next");

      expect(result).toMatchObject({
        moved: true,
        target: {
          workspaceId: "ws1",
          workspaceName: "One",
          paneId: "b",
          terminalId: "terminal-b",
          paneIndex: 1,
          paneNumber: 2,
          switchedWorkspace: false,
        },
      });
      expect(useGridStore.getState().focusedPaneIndex).toBe(1);
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws1");
    });

    it("crosses the workspace boundary and switches the active workspace", () => {
      seedTwoWorkspaces();
      useGridStore.getState().setFocusedPane(1); // pane b (last of ws1)

      const result = spatialStep("next");

      expect(result).toMatchObject({
        moved: true,
        target: { workspaceId: "ws2", paneId: "c", switchedWorkspace: true },
      });
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws2");
      expect(useGridStore.getState().focusedPaneIndex).toBe(0);
    });

    it("wraps from the first pane back to the last", () => {
      seedTwoWorkspaces();
      useGridStore.getState().setFocusedPane(0); // pane a (global first)

      const result = spatialStep("prev");

      expect(result).toMatchObject({
        moved: true,
        target: { workspaceId: "ws2", paneId: "c", switchedWorkspace: true },
      });
    });

    it("clears dock focus on landing", () => {
      seedTwoWorkspaces();
      useDockStore.getState().setFocusedDock("left");

      const result = spatialStep("next");

      expect(result.moved).toBe(true);
      expect(useDockStore.getState().focusedDock).toBeNull();
      expect(useGridStore.getState().focusedPaneIndex).not.toBeNull();
    });

    it("skips hidden workspaces", () => {
      useWorkspaceStore.setState({
        workspaces: [
          ws("ws1", "One", [term("a", 0, 0, 1, 1)]),
          ws("ws2", "Two", [term("b", 0, 0, 1, 1)]),
          ws("ws3", "Three", [term("c", 0, 0, 1, 1)]),
        ],
        activeWorkspaceId: "ws1",
        workspaceDisplayOrder: [],
      });
      useUiStore.getState().setWorkspaceHidden("ws2", true, ["b"]);
      useGridStore.getState().setFocusedPane(0);

      const result = spatialStep("next");

      expect(result).toMatchObject({ moved: true, target: { workspaceId: "ws3" } });
    });

    it("skips panes excluded by the Remote client", () => {
      seedTwoWorkspaces();
      useGridStore.getState().setFocusedPane(0); // pane a

      const excluded = new Set(["b"]);
      const first = spatialStep("next", excluded);
      expect(first).toMatchObject({ moved: true, target: { workspaceId: "ws2", paneId: "c" } });

      const second = spatialStep("next", excluded);
      expect(second).toMatchObject({ moved: true, target: { workspaceId: "ws1", paneId: "a" } });
    });

    it("keeps every pane included by default and ignores stale exclusions", () => {
      seedTwoWorkspaces();
      useGridStore.getState().setFocusedPane(0);

      expect(spatialStep("next", new Set(["stale-pane"]))).toMatchObject({
        moved: true,
        target: { workspaceId: "ws1", paneId: "b" },
      });
    });

    it("reports no_included_panes when the Remote client excludes every eligible pane", () => {
      seedTwoWorkspaces();
      useGridStore.getState().setFocusedPane(0);

      expect(spatialStep("next", new Set(["a", "b", "c"]))).toEqual({
        moved: false,
        reason: "no_included_panes",
      });
    });

    it("skips a whole workspace excluded by the Remote client", () => {
      seedTwoWorkspaces();
      useGridStore.getState().setFocusedPane(0); // pane a in ws1

      // ws2 excluded wholesale — stepping only ever cycles ws1's panes.
      const excludedWorkspaces = new Set(["ws2"]);
      const first = spatialStep("next", new Set(), excludedWorkspaces);
      expect(first).toMatchObject({ moved: true, target: { workspaceId: "ws1", paneId: "b" } });

      const second = spatialStep("next", new Set(), excludedWorkspaces);
      expect(second).toMatchObject({ moved: true, target: { workspaceId: "ws1", paneId: "a" } });
    });

    it("reports no_included_panes when every workspace is excluded", () => {
      seedTwoWorkspaces();
      useGridStore.getState().setFocusedPane(0);

      expect(spatialStep("next", new Set(), new Set(["ws1", "ws2"]))).toEqual({
        moved: false,
        reason: "no_included_panes",
      });
    });

    it("reports no_terminal_panes when no workspace has a terminal", () => {
      useWorkspaceStore.setState({
        workspaces: [ws("ws1", "One", [memo("m", 0, 0, 1, 1)])],
        activeWorkspaceId: "ws1",
        workspaceDisplayOrder: [],
      });

      expect(spatialStep("next")).toEqual({ moved: false, reason: "no_terminal_panes" });
    });

    it("reports no_other_target when the focused pane is the only entry", () => {
      useWorkspaceStore.setState({
        workspaces: [ws("ws1", "One", [term("a", 0, 0, 1, 1)])],
        activeWorkspaceId: "ws1",
        workspaceDisplayOrder: [],
      });
      useGridStore.getState().setFocusedPane(0);

      expect(spatialStep("next")).toEqual({ moved: false, reason: "no_other_target" });
    });
  });

  describe("notificationStep", () => {
    it("reports no_unread_notifications when there is nothing unread", () => {
      seedTwoWorkspaces();

      expect(notificationStep("recent")).toEqual({
        moved: false,
        reason: "no_unread_notifications",
      });
    });

    it("navigates to the notification pane and consumes the notification", () => {
      seedTwoWorkspaces();
      // Notification on inactive ws2 stays unread (auto-dismiss targets the active ws only)
      const n = useNotificationStore.getState().addNotification({
        terminalId: "terminal-c",
        workspaceId: "ws2",
        message: "done",
      });

      const result = notificationStep("recent");

      expect(result).toMatchObject({
        moved: true,
        target: {
          workspaceId: "ws2",
          workspaceName: "Two",
          terminalId: "terminal-c",
          paneId: "c",
          paneIndex: 0,
          paneNumber: 1,
          switchedWorkspace: true,
        },
        consumedNotificationIds: [n.id],
      });
      expect(useWorkspaceStore.getState().activeWorkspaceId).toBe("ws2");
      expect(useGridStore.getState().focusedPaneIndex).toBe(0);
      const stored = useNotificationStore.getState().notifications.find((x) => x.id === n.id);
      expect(stored?.readAt).not.toBeNull();
    });

    it("clears dock focus when landing on a workspace pane", () => {
      seedTwoWorkspaces();
      useDockStore.getState().setFocusedDock("left");
      useNotificationStore.getState().addNotification({
        terminalId: "terminal-c",
        workspaceId: "ws2",
        message: "done",
      });

      const result = notificationStep("oldest");

      expect(result.moved).toBe(true);
      expect(useDockStore.getState().focusedDock).toBeNull();
    });
  });
});
