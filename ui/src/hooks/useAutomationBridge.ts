import { useEffect } from "react";
import html2canvas from "html2canvas";
import { onAutomationRequest, automationResponse, type AutomationRequest } from "@/lib/tauri-api";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGridStore } from "@/stores/grid-store";
import { useDockStore } from "@/stores/dock-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useNotificationStore, type NotificationLevel } from "@/stores/notification-store";
import { useUiStore } from "@/stores/ui-store";
import { useSettingsStore } from "@/stores/settings-store";
import { computeWorkspaceSummary } from "@/lib/workspace-summary";
import type {
  DockPosition,
  ViewInstanceConfig,
  ViewType,
  Workspace,
  WorkspacePane,
} from "@/stores/types";

interface HandlerResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

type Handler = (params: Record<string, unknown>) => HandlerResult;
type HandlerMap = Record<string, Record<string, Handler>>;
type ActivePaneCtx = { err: HandlerResult } | { ws: Workspace; pane: WorkspacePane };

function ok(data: unknown): HandlerResult {
  return { success: true, data };
}

function err(message: string): HandlerResult {
  return { success: false, error: message };
}

// ── Shared helpers ────────────────────────────────────────────────

/** Construct terminal ID from pane ID. */
const toTerminalId = (paneId: string) => `terminal-${paneId}`;

/** Extract pane ID from terminal ID. */
const toPaneId = (terminalId: string) => terminalId.replace(/^terminal-/, "");

/** Get active workspace and validate pane index, returning the workspace and pane or an error. */
function getActivePaneCtx(paneIndex: number): ActivePaneCtx {
  const ws = useWorkspaceStore.getState().getActiveWorkspace();
  if (!ws) return { err: err("No active workspace") } as const;
  if (paneIndex < 0 || paneIndex >= ws.panes.length) {
    return { err: err(`Pane index out of range (0-${ws.panes.length - 1})`) } as const;
  }
  return { ws, pane: ws.panes[paneIndex] } as const;
}

/** Check that a workspace ID exists, returning an error result if not. */
function checkWorkspaceExists(workspaceId: string): HandlerResult | null {
  const { workspaces } = useWorkspaceStore.getState();
  if (!workspaces.some((ws) => ws.id === workspaceId)) {
    return err(`Workspace '${workspaceId}' not found`);
  }
  return null;
}

/** Find a terminal instance by id. */
function findTerminalInstance(terminalId: string) {
  return (
    useTerminalStore.getState().instances.find((instance) => instance.id === terminalId) ?? null
  );
}

/** Resolve pane index for a terminal within its workspace. */
function resolveTerminalPaneIndex(terminalId: string, workspaceId: string): number {
  const workspace = useWorkspaceStore.getState().workspaces.find((ws) => ws.id === workspaceId);
  if (!workspace) return -1;
  const paneId = toPaneId(terminalId);
  return workspace.panes.findIndex((pane) => pane.id === paneId);
}

/** Check if two 1D ranges overlap (with tolerance for floating point). */
function rangesOverlap(a: number, aLen: number, b: number, bLen: number): boolean {
  const eps = 0.01;
  return a < b + bLen - eps && b < a + aLen - eps;
}

/** Compute directional neighbors for a pane in the grid. */
function computeNeighbors(
  panes: WorkspacePane[],
  targetIndex: number,
): Record<string, { paneIndex: number; terminalId: string | null } | null> {
  const target = panes[targetIndex];
  if (!target) return { left: null, right: null, above: null, below: null };

  const result: Record<string, { paneIndex: number; terminalId: string | null } | null> = {
    left: null,
    right: null,
    above: null,
    below: null,
  };

  for (let i = 0; i < panes.length; i++) {
    if (i === targetIndex) continue;
    const other = panes[i];
    const entry = {
      paneIndex: i,
      terminalId: other.view.type === "TerminalView" ? toTerminalId(other.id) : null,
    };

    // Right: other starts where target ends on x-axis, y ranges overlap
    if (
      Math.abs(other.x - (target.x + target.w)) < 0.01 &&
      rangesOverlap(target.y, target.h, other.y, other.h)
    ) {
      if (!result.right || other.y < panes[result.right.paneIndex].y) result.right = entry;
    }
    // Left: other ends where target starts on x-axis
    if (
      Math.abs(other.x + other.w - target.x) < 0.01 &&
      rangesOverlap(target.y, target.h, other.y, other.h)
    ) {
      if (!result.left || other.y < panes[result.left.paneIndex].y) result.left = entry;
    }
    // Below: other starts where target ends on y-axis
    if (
      Math.abs(other.y - (target.y + target.h)) < 0.01 &&
      rangesOverlap(target.x, target.w, other.x, other.w)
    ) {
      if (!result.below || other.x < panes[result.below.paneIndex].x) result.below = entry;
    }
    // Above: other ends where target starts on y-axis
    if (
      Math.abs(other.y + other.h - target.y) < 0.01 &&
      rangesOverlap(target.x, target.w, other.x, other.w)
    ) {
      if (!result.above || other.x < panes[result.above.paneIndex].x) result.above = entry;
    }
  }

  return result;
}

/** Find the workspace and pane for a given terminal ID. */
function findTerminalContext(terminalId: string) {
  const { workspaces, activeWorkspaceId } = useWorkspaceStore.getState();
  const { instances } = useTerminalStore.getState();
  const terminal = instances.find((i) => i.id === terminalId);
  if (!terminal) return null;

  const workspace = workspaces.find((ws) => ws.id === terminal.workspaceId);
  if (!workspace) return null;

  const paneId = toPaneId(terminalId);
  const paneIndex = workspace.panes.findIndex((p) => p.id === paneId);
  const pane = paneIndex >= 0 ? workspace.panes[paneIndex] : null;

  return { terminal, workspace, pane, paneIndex, activeWorkspaceId };
}

/** Enrich a pane with its index and terminal ID (null for non-terminal panes). */
function enrichPane(p: WorkspacePane, index: number) {
  return {
    ...p,
    paneIndex: index,
    terminalId: p.view.type === "TerminalView" ? toTerminalId(p.id) : null,
  };
}

const handlers: HandlerMap = {
  workspaces: {
    list: () => {
      const { workspaces, activeWorkspaceId } = useWorkspaceStore.getState();
      return ok({ workspaces, activeWorkspaceId });
    },
    getActive: () => {
      const ws = useWorkspaceStore.getState().getActiveWorkspace();
      if (!ws) return ok({ workspace: null });
      const { focusedPaneIndex } = useGridStore.getState();
      const enriched = {
        ...ws,
        focusedPaneIndex,
        panes: ws.panes.map(enrichPane),
      };
      return ok({ workspace: enriched });
    },
    switchActive: (p) => {
      useWorkspaceStore.getState().setActiveWorkspace(p.id as string);
      return ok({ switched: p.id });
    },
    add: (p) => {
      const { layouts } = useWorkspaceStore.getState();
      const layoutId = (p.layoutId as string | undefined) ?? layouts[0]?.id;
      if (!layoutId) return err("No layouts available");
      const before = useWorkspaceStore.getState().workspaces;
      useWorkspaceStore.getState().addWorkspace(p.name as string, layoutId);
      const after = useWorkspaceStore.getState().workspaces;
      const newWs = after.find((ws) => !before.some((b) => b.id === ws.id));
      if (!newWs) return err(`Failed to create workspace: layout '${layoutId}' not found`);

      // Apply cwd to all panes — convert EmptyView to TerminalView with lastCwd
      const cwd = p.cwd as string | undefined;
      if (cwd) {
        const store = useWorkspaceStore.getState();
        // Find index of new workspace to operate on its panes
        const wsIdx = store.workspaces.findIndex((ws) => ws.id === newWs.id);
        if (wsIdx >= 0) {
          // Temporarily switch active to the new workspace so setPaneView works on it
          const prevActiveId = store.activeWorkspaceId;
          store.setActiveWorkspace(newWs.id);
          for (let i = 0; i < newWs.panes.length; i++) {
            const pane = newWs.panes[i];
            const viewConfig: ViewInstanceConfig = {
              ...(pane.view.type === "TerminalView" ? pane.view : { type: "TerminalView" }),
              lastCwd: cwd,
            };
            useWorkspaceStore.getState().setPaneView(i, viewConfig);
          }
          // Restore previous active workspace
          store.setActiveWorkspace(prevActiveId);
        }
      }

      const updatedWs = useWorkspaceStore.getState().workspaces.find((ws) => ws.id === newWs.id)!;
      return ok({
        created: true,
        workspace: { id: updatedWs.id, name: updatedWs.name, paneCount: updatedWs.panes.length },
      });
    },
    remove: (p) => {
      const id = p.id as string;
      const wsErr = checkWorkspaceExists(id);
      if (wsErr) return wsErr;
      useWorkspaceStore.getState().removeWorkspace(id);
      return ok({ removed: id });
    },
    rename: (p) => {
      const id = p.id as string;
      const wsErr = checkWorkspaceExists(id);
      if (wsErr) return wsErr;
      useWorkspaceStore.getState().renameWorkspace(id, p.name as string);
      return ok({ renamed: id });
    },
    reorder: (p) => {
      useWorkspaceStore
        .getState()
        .reorderWorkspaces(p.fromId as string, p.toId as string, p.position as "top" | "bottom");
      return ok({ reordered: true });
    },
    getSummary: (p) => {
      const wsId = p.id as string;
      const { instances } = useTerminalStore.getState();
      const { notifications } = useNotificationStore.getState();
      const summary = computeWorkspaceSummary(wsId, instances, new Map(), notifications);
      return ok({ summary });
    },
  },

  grid: {
    getState: () => {
      const { editMode, focusedPaneIndex } = useGridStore.getState();
      const { activeWorkspaceId } = useWorkspaceStore.getState();
      return ok({ editMode, focusedPaneIndex, activeWorkspaceId });
    },
    setEditMode: (p) => {
      useGridStore.getState().setEditMode(p.enabled as boolean);
      return ok({ editMode: p.enabled });
    },
    focusPane: (p) => {
      const index = p.index as number;
      const ctx = getActivePaneCtx(index);
      if ("err" in ctx) return ctx.err;
      useGridStore.getState().setFocusedPane(index);
      return ok({ focusedPaneIndex: index });
    },
    simulateHover: (p) => {
      const idx = p.index != null ? (p.index as number) : null;
      useGridStore.getState().setAutomationHover(idx);
      return ok({ automationHoverIndex: idx });
    },
  },

  panes: {
    split: (p) => {
      const idx = p.paneIndex as number;
      const ctx = getActivePaneCtx(idx);
      if ("err" in ctx) return ctx.err;
      useWorkspaceStore.getState().splitPane(idx, p.direction as "horizontal" | "vertical");
      const newPaneIndex = idx + 1;
      // Auto-convert EmptyView to TerminalView so MCP splits create usable terminals
      const wsBeforeConvert = useWorkspaceStore.getState().getActiveWorkspace();
      const newPaneBefore = wsBeforeConvert?.panes[newPaneIndex];
      if (newPaneBefore && newPaneBefore.view.type !== "TerminalView") {
        const viewConfig: ViewInstanceConfig = { type: "TerminalView" };
        if (p.profile) viewConfig.profile = p.profile as string;
        if (p.cwd) viewConfig.lastCwd = p.cwd as string;
        useWorkspaceStore.getState().setPaneView(newPaneIndex, viewConfig);
      }
      const ws = useWorkspaceStore.getState().getActiveWorkspace();
      const newPane = ws?.panes[newPaneIndex];
      const terminalId = newPane?.view.type === "TerminalView" ? toTerminalId(newPane.id) : null;
      // Check if the terminal instance is already registered (React may not have rendered yet)
      const { instances } = useTerminalStore.getState();
      const terminalReady = terminalId ? instances.some((i) => i.id === terminalId) : false;
      return ok({
        split: true,
        newPane: newPane
          ? {
              id: newPane.id,
              terminalId,
              paneIndex: newPaneIndex,
              x: newPane.x,
              y: newPane.y,
              w: newPane.w,
              h: newPane.h,
              ready: terminalReady,
            }
          : null,
        totalPanes: ws?.panes.length ?? 0,
        _hint:
          terminalId && !terminalReady
            ? "Terminal ID is allocated but not yet registered. Poll list_terminals or wait ~500ms before writing to it."
            : undefined,
      });
    },
    remove: (p) => {
      const ctx = getActivePaneCtx(p.paneIndex as number);
      if ("err" in ctx) return ctx.err;
      useWorkspaceStore.getState().removePane(p.paneIndex as number);
      return ok({ removed: true });
    },
    setView: (p) => {
      const ctx = getActivePaneCtx(p.paneIndex as number);
      if ("err" in ctx) return ctx.err;
      const view = p.view as { type: string; [key: string]: unknown };
      useWorkspaceStore
        .getState()
        .setPaneView(p.paneIndex as number, { ...view, type: view.type as ViewType });
      return ok({ viewSet: true });
    },
    resize: (p) => {
      const ctx = getActivePaneCtx(p.paneIndex as number);
      if ("err" in ctx) return ctx.err;
      const { pane } = ctx;
      const delta = p.delta as Partial<Pick<WorkspacePane, "x" | "y" | "w" | "h">>;
      const absolute: Partial<Pick<WorkspacePane, "x" | "y" | "w" | "h">> = {};
      if (delta.x != null) absolute.x = pane.x + delta.x;
      if (delta.y != null) absolute.y = pane.y + delta.y;
      if (delta.w != null) absolute.w = pane.w + delta.w;
      if (delta.h != null) absolute.h = pane.h + delta.h;
      useWorkspaceStore.getState().resizePane(p.paneIndex as number, absolute);
      return ok({ resized: true });
    },
    swap: (p) => {
      const srcCtx = getActivePaneCtx(p.sourceIndex as number);
      if ("err" in srcCtx) return srcCtx.err;
      const tgtCtx = getActivePaneCtx(p.targetIndex as number);
      if ("err" in tgtCtx) return tgtCtx.err;
      useWorkspaceStore.getState().swapPanes(p.sourceIndex as number, p.targetIndex as number);
      return ok({ swapped: true });
    },
  },

  docks: {
    list: () => {
      const { docks } = useDockStore.getState();
      return ok({ docks });
    },
    setActiveView: (p) => {
      useDockStore.getState().setDockActiveView(p.position as DockPosition, p.view as ViewType);
      return ok({ set: true });
    },
    toggleVisible: (p) => {
      useDockStore.getState().toggleDockVisible(p.position as DockPosition);
      return ok({ toggled: true });
    },
    setSize: (p) => {
      const size = typeof p.size === "number" ? p.size : 240;
      useDockStore.getState().setDockSize(p.position as DockPosition, size);
      return ok({ set: true });
    },
    setViews: (p) => {
      const views = Array.isArray(p.views) ? (p.views as ViewType[]) : [];
      const store = useDockStore.getState();
      const docks = store.docks.map((d) => (d.position === p.position ? { ...d, views } : d));
      useDockStore.setState({ docks });
      return ok({ set: true });
    },
    splitPane: (p) => {
      const paneId = typeof p.paneId === "string" ? p.paneId : undefined;
      const direction = (p.direction === "vertical" ? "vertical" : "horizontal") as
        | "horizontal"
        | "vertical";
      useDockStore.getState().splitDockPane(p.position as DockPosition, direction, paneId);
      return ok({ split: true });
    },
    removeDockPane: (p) => {
      useDockStore.getState().removeDockPane(p.position as DockPosition, p.paneId as string);
      return ok({ removed: true });
    },
    setDockPaneView: (p) => {
      const view = p.view as { type: string; [key: string]: unknown };
      useDockStore.getState().setDockPaneView(p.position as DockPosition, p.paneId as string, {
        ...view,
        type: view.type as ViewType,
      });
      return ok({ viewSet: true });
    },
    toggleLayoutMode: () => {
      useDockStore.getState().toggleLayoutMode();
      const { layoutMode } = useDockStore.getState();
      return ok({ layoutMode });
    },
  },

  settings: {
    setProfileDefaults: (p) => {
      useSettingsStore.getState().setProfileDefaults(p as Record<string, unknown>);
      return ok({ set: true });
    },
    setAppTheme: (p) => {
      useSettingsStore.getState().setAppTheme(p.themeId as string);
      return ok({ set: true });
    },
    updateProfile: (p) => {
      const idx = typeof p.index === "number" ? p.index : 0;
      const data = p.data as Record<string, unknown>;
      useSettingsStore.getState().updateProfile(idx, data);
      return ok({ updated: true });
    },
  },

  terminals: {
    list: () => {
      const { instances } = useTerminalStore.getState();
      const { workspaces } = useWorkspaceStore.getState();
      const enriched = instances.map((inst) => {
        const ws = workspaces.find((w) => w.id === inst.workspaceId);
        const paneId = toPaneId(inst.id);
        const paneIndex = ws?.panes.findIndex((p) => p.id === paneId) ?? -1;
        const pane = paneIndex >= 0 ? ws!.panes[paneIndex] : null;
        return {
          ...inst,
          paneIndex: paneIndex >= 0 ? paneIndex : null,
          panePosition: pane ? { x: pane.x, y: pane.y, w: pane.w, h: pane.h } : null,
        };
      });
      return ok({ instances: enriched });
    },
    get: (p) => {
      const ctx = findTerminalContext(p.id as string);
      if (!ctx) return err(`Terminal '${p.id}' not found`);
      const { terminal, workspace, pane, paneIndex, activeWorkspaceId } = ctx;
      return ok({
        terminal: {
          ...terminal,
          paneIndex: paneIndex >= 0 ? paneIndex : null,
          panePosition: pane ? { x: pane.x, y: pane.y, w: pane.w, h: pane.h } : null,
        },
        workspace: {
          id: workspace.id,
          name: workspace.name,
          isActive: workspace.id === activeWorkspaceId,
        },
      });
    },
    identify: (p) => {
      const ctx = findTerminalContext(p.id as string);
      if (!ctx) return err(`Terminal '${p.id}' not found`);
      const { terminal, workspace, pane, paneIndex, activeWorkspaceId } = ctx;
      const { focusedPaneIndex } = useGridStore.getState();

      return ok({
        terminal: {
          id: terminal.id,
          profile: terminal.profile,
          syncGroup: terminal.syncGroup,
          cwd: terminal.cwd,
          branch: terminal.branch,
          activity: terminal.activity,
          isFocused: terminal.isFocused,
        },
        workspace: {
          id: workspace.id,
          name: workspace.name,
          isActive: workspace.id === activeWorkspaceId,
          totalPanes: workspace.panes.length,
        },
        pane: pane
          ? {
              id: pane.id,
              index: paneIndex,
              x: pane.x,
              y: pane.y,
              w: pane.w,
              h: pane.h,
              isFocusedPane: workspace.id === activeWorkspaceId && focusedPaneIndex === paneIndex,
            }
          : null,
        neighbors: pane ? computeNeighbors(workspace.panes, paneIndex) : null,
      });
    },
    setFocus: (p) => {
      const terminalId = p.id as string;
      const terminal = findTerminalInstance(terminalId);
      if (!terminal) return err(`Terminal '${terminalId}' not found`);

      // Auto-switch workspace if terminal is in a different workspace
      const { activeWorkspaceId } = useWorkspaceStore.getState();
      const switchedWorkspace = terminal.workspaceId !== activeWorkspaceId;
      if (switchedWorkspace) {
        useWorkspaceStore.getState().setActiveWorkspace(terminal.workspaceId);
      }

      // Update focusedPaneIndex to match the target terminal's pane
      const paneIndex = resolveTerminalPaneIndex(terminalId, terminal.workspaceId);
      if (paneIndex >= 0) {
        useGridStore.getState().setFocusedPane(paneIndex);
      }

      useTerminalStore.getState().setTerminalFocus(terminalId);
      return ok({
        focused: terminalId,
        paneIndex: paneIndex >= 0 ? paneIndex : undefined,
        switchedWorkspace: switchedWorkspace ? terminal.workspaceId : undefined,
      });
    },
  },

  notifications: {
    list: () => {
      const { notifications } = useNotificationStore.getState();
      return ok({ notifications });
    },
    add: (p) => {
      const workspaceId = p.workspaceId as string;
      const terminalId = p.terminalId as string;
      const wsErr = checkWorkspaceExists(workspaceId);
      if (wsErr) return wsErr;
      // Validate terminal exists (skip for workspace-level notifications with empty terminalId)
      if (terminalId && !findTerminalInstance(terminalId)) {
        return err(`Terminal '${terminalId}' not found`);
      }
      const notification = useNotificationStore.getState().addNotification({
        terminalId,
        workspaceId,
        message: p.message as string,
        level: (p.level as NotificationLevel) ?? undefined,
      });
      return ok({ added: true, notification });
    },
    unreadCount: (p) => {
      const count = useNotificationStore.getState().getUnreadCount(p.workspaceId as string);
      return ok({ count });
    },
    markRead: (p) => {
      useNotificationStore.getState().markWorkspaceAsRead(p.workspaceId as string);
      return ok({ marked: true });
    },
  },

  layouts: {
    list: () => {
      const { layouts } = useWorkspaceStore.getState();
      return ok({ layouts });
    },
    exportNew: (p) => {
      useWorkspaceStore.getState().exportAsNewLayout(p.name as string);
      return ok({ exported: true });
    },
    exportTo: (p) => {
      const layoutId = p.layoutId as string;
      const success = useWorkspaceStore.getState().exportToLayout(layoutId);
      if (!success) return err(`layout '${layoutId}' not found`);
      return ok({ exported: true });
    },
  },

  profiles: {
    list: () => {
      const { profiles, defaultProfile } = useSettingsStore.getState();
      return ok({
        profiles: profiles.map((p) => ({
          name: p.name,
          commandLine: p.commandLine || undefined,
          startingDirectory: p.startingDirectory || undefined,
          isDefault: p.name === defaultProfile,
        })),
        defaultProfile,
      });
    },
  },

  ui: {
    openSettings: () => {
      useUiStore.getState().openSettingsModal();
      return ok({ opened: true });
    },
    closeSettings: () => {
      useUiStore.getState().closeSettingsModal();
      return ok({ closed: true });
    },
    toggleSettings: () => {
      useUiStore.getState().toggleSettingsModal();
      return ok({ toggled: true });
    },
    toggleNotificationPanel: () => {
      useUiStore.getState().toggleNotificationPanel();
      return ok({ toggled: true });
    },
    navigateSettings: (p) => {
      const target = typeof p.section === "string" ? p.section : "startup";
      useUiStore.getState().setSettingsNavTarget(target);
      return ok({ navigated: true, section: target });
    },
    toggleHideMode: () => {
      useUiStore.getState().toggleHideMode();
      return ok({ hideMode: useUiStore.getState().hideMode });
    },
    toggleWorkspaceHidden: (p) => {
      const id = typeof p.id === "string" ? p.id : null;
      if (!id) return err("id required");
      useUiStore.getState().toggleWorkspaceHidden(id);
      return ok({ hidden: useUiStore.getState().hiddenWorkspaceIds.has(id) });
    },
    togglePaneHidden: (p) => {
      const id = typeof p.id === "string" ? p.id : null;
      if (!id) return err("id required");
      useUiStore.getState().togglePaneHidden(id);
      return ok({ hidden: useUiStore.getState().hiddenPaneIds.has(id) });
    },
  },
};

/** Capture a screenshot of the current UI (or a specific pane) as a base64 PNG data URL.
 *  html2canvas cannot read WebGL canvases, so after the initial capture we
 *  composite each WebGL canvas (xterm.js terminals) onto the result manually. */
export async function captureScreenshot(paneIndex?: number): Promise<string> {
  let target: HTMLElement = document.documentElement;

  // If paneIndex specified, find the specific pane div (not minimap rects or hidden workspaces)
  if (paneIndex != null) {
    const paneElements = document.querySelectorAll<HTMLElement>("div[data-pane-index]");
    // Filter to only visible panes (display !== "none" means active workspace)
    const paneEl = Array.from(paneElements).find(
      (el) => el.getAttribute("data-pane-index") === String(paneIndex) && el.offsetParent !== null,
    );
    if (paneEl) {
      target = paneEl;
    }
  }

  const scale = window.devicePixelRatio || 1;
  const result = await html2canvas(target, {
    backgroundColor: null,
    scale,
    logging: false,
  });

  // Composite WebGL canvases that html2canvas missed
  const ctx = result.getContext("2d");
  if (ctx) {
    const targetRect = target.getBoundingClientRect();
    target.querySelectorAll("canvas").forEach((c) => {
      if (c.width === 0 || c.height === 0) return;
      const rect = c.getBoundingClientRect();
      try {
        ctx.drawImage(
          c,
          (rect.left - targetRect.left) * scale,
          (rect.top - targetRect.top) * scale,
          rect.width * scale,
          rect.height * scale,
        );
      } catch {
        // drawImage may fail for tainted/cross-origin canvases — ignore
      }
    });
  }

  return result.toDataURL("image/png");
}

/** Process a single automation request and return the result. */
export function handleAutomationRequest(request: AutomationRequest): HandlerResult {
  const targetHandlers = handlers[request.target];
  if (!targetHandlers) {
    return err(`Unknown target: ${request.target}`);
  }

  const handler = targetHandlers[request.method];
  if (!handler) {
    return err(`Unknown method: ${request.target}.${request.method}`);
  }

  try {
    return handler(request.params);
  } catch (e) {
    return err(`Handler error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Process an async automation request (e.g., screenshot, debug). */
export async function handleAsyncAutomationRequest(
  request: AutomationRequest,
): Promise<HandlerResult> {
  if (request.target === "screenshot" && request.method === "capture") {
    try {
      const paneIndex =
        typeof request.params.paneIndex === "number" ? request.params.paneIndex : undefined;
      const dataUrl = await captureScreenshot(paneIndex);
      return ok({ dataUrl });
    } catch (e) {
      return err(`Screenshot error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Fall through to sync handler
  return handleAutomationRequest(request);
}

/** Hook that bridges automation HTTP requests to Zustand stores. */
export function useAutomationBridge() {
  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;

    onAutomationRequest(async (request) => {
      if (cancelled) {
        // Still respond so the backend doesn't wait until timeout
        automationResponse(request.requestId, false, undefined, "Bridge listener cancelled");
        return;
      }
      const result = await handleAsyncAutomationRequest(request);
      if (cancelled) {
        // Respond with result anyway — backend is waiting on the oneshot channel
        automationResponse(request.requestId, result.success, result.data, result.error);
        return;
      }
      automationResponse(request.requestId, result.success, result.data, result.error);
    }).then((fn) => {
      if (cancelled) {
        // Effect was already cleaned up before promise resolved (StrictMode race)
        fn();
      } else {
        unlisten = fn;
      }
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
}
