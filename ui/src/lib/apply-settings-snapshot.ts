import type { Settings } from "@/lib/tauri-api";
import { useDockStore } from "@/stores/dock-store";
import {
  defaultProfileDefaults,
  makeDefaultColorScheme,
  useSettingsStore,
} from "@/stores/settings-store";
import type { DockPosition, Layout, ViewType, Workspace } from "@/stores/types";
import { useWorkspaceStore } from "@/stores/workspace-store";

export interface ApplySettingsSnapshotOptions {
  includeStructural?: boolean;
}

/** Apply a validated Settings snapshot to the live Zustand stores. */
export function applySettingsSnapshot(
  rawSettings: Settings,
  options: ApplySettingsSnapshotOptions = {},
): void {
  const sProfiles = rawSettings.profiles;
  const sColorSchemes = rawSettings.colorSchemes;
  const sKeybindings = rawSettings.keybindings;
  const sProfileDefaults = rawSettings.profileDefaults;
  const sViewOrder = rawSettings.viewOrder;

  useSettingsStore.getState().loadFromSettings({
    ...(rawSettings.language ? { language: rawSettings.language } : {}),
    defaultProfile: rawSettings.defaultProfile,
    profileDefaults: sProfileDefaults as Parameters<
      ReturnType<typeof useSettingsStore.getState>["loadFromSettings"]
    >[0]["profileDefaults"],
    viewOrder: Array.isArray(sViewOrder) ? sViewOrder : undefined,
    profiles:
      sProfiles?.map((profile) => ({
        name: profile.name,
        commandLine: profile.commandLine,
        startupCommand: profile.startupCommand ?? "",
        colorScheme: profile.colorScheme ?? "",
        startingDirectory: profile.startingDirectory ?? "",
        hidden: profile.hidden ?? false,
        cursorShape: (profile.cursorShape ??
          "bar") as import("@/stores/settings-store").CursorShape,
        cursorBlink: profile.cursorBlink ?? defaultProfileDefaults.cursorBlink,
        stabilizeInteractiveCursor:
          profile.stabilizeInteractiveCursor ?? defaultProfileDefaults.stabilizeInteractiveCursor,
        padding: profile.padding ?? { top: 8, right: 8, bottom: 8, left: 8 },
        scrollbackLines: profile.scrollbackLines ?? 9001,
        opacity: profile.opacity ?? 100,
        tabTitle: profile.tabTitle ?? "",
        bellStyle: (profile.bellStyle ?? "audible") as import("@/stores/settings-store").BellStyle,
        closeOnExit: (profile.closeOnExit ??
          "automatic") as import("@/stores/settings-store").CloseOnExit,
        antialiasingMode: (profile.antialiasingMode ??
          "grayscale") as import("@/stores/settings-store").AntialiasingMode,
        suppressApplicationTitle: profile.suppressApplicationTitle ?? false,
        snapOnInput: profile.snapOnInput ?? true,
        ...(profile.font
          ? {
              font: {
                face: profile.font.face,
                size: profile.font.size,
                weight: profile.font.weight ?? "normal",
              },
            }
          : {}),
        ...(profile.restoreCwd !== undefined ? { restoreCwd: profile.restoreCwd } : {}),
        ...(profile.restoreOutput !== undefined ? { restoreOutput: profile.restoreOutput } : {}),
        ...(profile.syncCwd !== undefined ? { syncCwd: profile.syncCwd } : {}),
      })) ?? [],
    colorSchemes:
      sColorSchemes?.map(
        (scheme) =>
          ({
            ...makeDefaultColorScheme(),
            ...Object.fromEntries(
              Object.entries(scheme).filter(([, value]) => value !== undefined),
            ),
          }) as import("@/stores/settings-store").ColorScheme,
      ) ?? [],
    keybindings:
      sKeybindings?.map((keybinding) => ({
        keys: keybinding.keys,
        command: keybinding.command,
      })) ?? [],
    ...(rawSettings.appearance ? { appearance: rawSettings.appearance } : {}),
    ...(rawSettings.paste ? { paste: rawSettings.paste } : {}),
    ...(rawSettings.terminal ? { terminal: rawSettings.terminal } : {}),
    ...(rawSettings.controlBar ? { controlBar: rawSettings.controlBar } : {}),
    ...(rawSettings.dock ? { dock: rawSettings.dock } : {}),
    ...(rawSettings.notifications ? { notifications: rawSettings.notifications } : {}),
    ...(rawSettings.workspaceSelector ? { workspaceSelector: rawSettings.workspaceSelector } : {}),
    ...(rawSettings.claude ? { claude: rawSettings.claude } : {}),
    ...(rawSettings.codex ? { codex: rawSettings.codex } : {}),
    ...(rawSettings.issueReporter ? { issueReporter: rawSettings.issueReporter } : {}),
    ...(rawSettings.fileExplorer ? { fileExplorer: rawSettings.fileExplorer } : {}),
    ...(rawSettings.remote ? { remote: rawSettings.remote } : {}),
    ...(rawSettings.memo ? { memo: rawSettings.memo } : {}),
    ...(rawSettings.syncCwdDefaults ? { syncCwdDefaults: rawSettings.syncCwdDefaults } : {}),
  });

  if (options.includeStructural === false) return;
  applyWorkspaceSnapshot(rawSettings);
  applyDockSnapshot(rawSettings);
}

function applyWorkspaceSnapshot(rawSettings: Settings): void {
  if (!rawSettings.layouts?.length || !rawSettings.workspaces?.length) return;

  const layouts: Layout[] = rawSettings.layouts.map((layout) => ({
    id: layout.id,
    name: layout.name,
    panes: layout.panes.map((pane) => ({
      x: pane.x,
      y: pane.y,
      w: pane.w,
      h: pane.h,
      viewType: pane.viewType as ViewType,
      ...(pane.viewConfig
        ? { viewConfig: { ...pane.viewConfig, type: pane.viewConfig.type as ViewType } }
        : {}),
    })),
  }));

  let paneCounter = 0;
  const workspaces: Workspace[] = rawSettings.workspaces.map((workspace) => ({
    id: workspace.id,
    name: workspace.name,
    panes: workspace.panes.map((pane) => ({
      id: pane.id || `loaded-pane-${++paneCounter}`,
      x: pane.x,
      y: pane.y,
      w: pane.w || 1,
      h: pane.h || 1,
      view: {
        ...pane.view,
        type: (pane.view.type as ViewType) || "EmptyView",
      },
    })),
  }));
  const currentActiveId = useWorkspaceStore.getState().activeWorkspaceId;
  const activeWorkspaceId = workspaces.some((workspace) => workspace.id === currentActiveId)
    ? currentActiveId
    : (workspaces[0]?.id ?? "ws-default");
  useWorkspaceStore.setState({
    layouts,
    workspaces,
    activeWorkspaceId,
    workspaceDisplayOrder: Array.isArray(rawSettings.workspaceDisplayOrder)
      ? rawSettings.workspaceDisplayOrder
      : [],
  });
}

function applyDockSnapshot(rawSettings: Settings): void {
  if (!rawSettings.docks?.length) return;
  const validPositions: DockPosition[] = ["top", "bottom", "left", "right"];
  const currentDocks = useDockStore.getState().docks;
  const docks = currentDocks.map((dock) => {
    const saved = rawSettings.docks.find((candidate) => candidate.position === dock.position);
    if (!saved || !validPositions.includes(saved.position as DockPosition)) return dock;

    const loadedPanes = Array.isArray(saved.panes)
      ? saved.panes.map((pane) => ({
          id: pane.id || `dp-${crypto.randomUUID().slice(0, 8)}`,
          view: {
            ...pane.view,
            type: (pane.view.type as ViewType) || "EmptyView",
          },
          x: pane.x ?? 0,
          y: pane.y ?? 0,
          w: pane.w ?? 1,
          h: pane.h ?? 1,
        }))
      : undefined;
    const activeView = (saved.activeView as ViewType) ?? dock.activeView;
    let panes = loadedPanes ?? dock.panes;
    const visible = saved.visible ?? dock.visible;
    if (panes.length === 0 && visible) {
      panes = [
        {
          id: `dp-${crypto.randomUUID().slice(0, 8)}`,
          view: { type: activeView ?? "EmptyView" },
          x: 0,
          y: 0,
          w: 1,
          h: 1,
        },
      ];
    }
    return {
      ...dock,
      activeView,
      views: Array.isArray(saved.views) ? (saved.views as ViewType[]) : dock.views,
      visible,
      size: typeof saved.size === "number" && saved.size >= 50 ? saved.size : dock.size,
      panes,
    };
  });
  useDockStore.setState({ docks });
}
