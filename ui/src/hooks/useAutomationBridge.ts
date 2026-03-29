import { useEffect } from "react";
import html2canvas from "html2canvas";
import {
  onAutomationRequest,
  automationResponse,
  type AutomationRequest,
} from "@/lib/tauri-api";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGridStore } from "@/stores/grid-store";
import { useDockStore } from "@/stores/dock-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useNotificationStore, type NotificationLevel } from "@/stores/notification-store";
import { useUiStore } from "@/stores/ui-store";
import { useSettingsStore } from "@/stores/settings-store";
import { computeWorkspaceSummary } from "@/lib/workspace-summary";
import type { DockPosition, ViewType } from "@/stores/types";

interface HandlerResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

type Handler = (params: Record<string, unknown>) => HandlerResult;
type HandlerMap = Record<string, Record<string, Handler>>;

function ok(data: unknown): HandlerResult {
  return { success: true, data };
}

function err(message: string): HandlerResult {
  return { success: false, error: message };
}

const handlers: HandlerMap = {
  workspaces: {
    list: () => {
      const { workspaces, activeWorkspaceId } = useWorkspaceStore.getState();
      return ok({ workspaces, activeWorkspaceId });
    },
    getActive: () => {
      const ws = useWorkspaceStore.getState().getActiveWorkspace();
      return ok({ workspace: ws ?? null });
    },
    switchActive: (p) => {
      useWorkspaceStore.getState().setActiveWorkspace(p.id as string);
      return ok({ switched: p.id });
    },
    add: (p) => {
      useWorkspaceStore.getState().addWorkspace(p.name as string, p.layoutId as string);
      return ok({ created: true });
    },
    remove: (p) => {
      useWorkspaceStore.getState().removeWorkspace(p.id as string);
      return ok({ removed: p.id });
    },
    rename: (p) => {
      useWorkspaceStore.getState().renameWorkspace(p.id as string, p.name as string);
      return ok({ renamed: p.id });
    },
    save: () => {
      useWorkspaceStore.getState().saveWorkspace();
      return ok({ saved: true });
    },
    revert: () => {
      useWorkspaceStore.getState().revertWorkspace();
      return ok({ reverted: true });
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
      return ok({ editMode, focusedPaneIndex });
    },
    setEditMode: (p) => {
      useGridStore.getState().setEditMode(p.enabled as boolean);
      return ok({ editMode: p.enabled });
    },
    focusPane: (p) => {
      useGridStore.getState().setFocusedPane(p.index as number);
      return ok({ focusedPaneIndex: p.index });
    },
    simulateHover: (p) => {
      const idx = p.index != null ? (p.index as number) : null;
      useGridStore.getState().setAutomationHover(idx);
      return ok({ automationHoverIndex: idx });
    },
  },

  panes: {
    split: (p) => {
      useWorkspaceStore
        .getState()
        .splitPane(p.paneIndex as number, p.direction as "horizontal" | "vertical");
      return ok({ split: true });
    },
    remove: (p) => {
      useWorkspaceStore.getState().removePane(p.paneIndex as number);
      return ok({ removed: true });
    },
    setView: (p) => {
      const view = p.view as { type: string; [key: string]: unknown };
      useWorkspaceStore
        .getState()
        .setPaneView(p.paneIndex as number, { ...view, type: view.type as ViewType });
      return ok({ viewSet: true });
    },
  },

  docks: {
    list: () => {
      const { docks } = useDockStore.getState();
      return ok({ docks });
    },
    setActiveView: (p) => {
      useDockStore
        .getState()
        .setDockActiveView(p.position as DockPosition, p.view as ViewType);
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
      const views = Array.isArray(p.views) ? p.views as ViewType[] : [];
      const store = useDockStore.getState();
      const docks = store.docks.map((d) =>
        d.position === p.position ? { ...d, views } : d,
      );
      useDockStore.setState({ docks });
      return ok({ set: true });
    },
    splitPane: (p) => {
      const paneId = typeof p.paneId === "string" ? p.paneId : undefined;
      const direction = (p.direction === "vertical" ? "vertical" : "horizontal") as "horizontal" | "vertical";
      useDockStore.getState().splitDockPane(p.position as DockPosition, direction, paneId);
      return ok({ split: true });
    },
    removeDockPane: (p) => {
      useDockStore.getState().removeDockPane(p.position as DockPosition, p.paneId as string);
      return ok({ removed: true });
    },
    setDockPaneView: (p) => {
      const view = p.view as { type: string; [key: string]: unknown };
      useDockStore.getState().setDockPaneView(
        p.position as DockPosition,
        p.paneId as string,
        { ...view, type: view.type as ViewType },
      );
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
      return ok({ instances });
    },
    setFocus: (p) => {
      useTerminalStore.getState().setTerminalFocus(p.id as string);
      return ok({ focused: p.id });
    },
  },

  notifications: {
    list: () => {
      const { notifications } = useNotificationStore.getState();
      return ok({ notifications });
    },
    add: (p) => {
      useNotificationStore.getState().addNotification({
        terminalId: p.terminalId as string,
        workspaceId: p.workspaceId as string,
        message: p.message as string,
        level: (p.level as NotificationLevel) ?? undefined,
      });
      return ok({ added: true });
    },
    unreadCount: (p) => {
      const count = useNotificationStore
        .getState()
        .getUnreadCount(p.workspaceId as string);
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
  },
};

/** Capture a screenshot of the current UI as a base64 PNG data URL.
 *  html2canvas cannot read WebGL canvases, so after the initial capture we
 *  composite each WebGL canvas (xterm.js terminals) onto the result manually. */
export async function captureScreenshot(): Promise<string> {
  const root = document.documentElement;
  const scale = window.devicePixelRatio || 1;
  const result = await html2canvas(root, {
    backgroundColor: null,
    scale,
    logging: false,
  });

  // Composite WebGL canvases that html2canvas missed
  const ctx = result.getContext("2d");
  if (ctx) {
    document.querySelectorAll("canvas").forEach((c) => {
      if (c.width === 0 || c.height === 0) return;
      const rect = c.getBoundingClientRect();
      try {
        ctx.drawImage(c, rect.left * scale, rect.top * scale, rect.width * scale, rect.height * scale);
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
      const dataUrl = await captureScreenshot();
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
      if (cancelled) return;
      const result = await handleAsyncAutomationRequest(request);
      if (cancelled) return;
      automationResponse(
        request.requestId,
        result.success,
        result.data,
        result.error,
      );
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
