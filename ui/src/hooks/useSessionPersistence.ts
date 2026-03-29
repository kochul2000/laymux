import { useState, useEffect, useCallback } from "react";
import { loadSettings } from "@/lib/tauri-api";
import { persistSession } from "@/lib/persist-session";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore, makeDefaultColorScheme } from "@/stores/settings-store";
import { useDockStore } from "@/stores/dock-store";
import type { ViewType, Layout, Workspace, DockPosition } from "@/stores/types";

/**
 * Hook that loads settings from disk on mount and provides a save function.
 * Bridges the gap between the Tauri backend settings.json and the frontend stores.
 */
export function useSessionPersistence() {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    loadSettings()
      .then((rawSettings) => {
        const sFont = rawSettings.font;
        const sProfiles = rawSettings.profiles;
        const sColorSchemes = rawSettings.colorSchemes;
        const sKeybindings = rawSettings.keybindings;
        const sProfileDefaults = rawSettings.profileDefaults;
        const sViewOrder = rawSettings.viewOrder;
        const sAppThemeId = rawSettings.appThemeId;

        // Apply to settings store
        useSettingsStore.getState().loadFromSettings({
          ...(sFont ? { font: { face: sFont.face, size: sFont.size, weight: sFont.weight ?? "normal" } } : {}),
          defaultProfile: rawSettings.defaultProfile,
          profileDefaults: sProfileDefaults as Parameters<ReturnType<typeof useSettingsStore.getState>["loadFromSettings"]>[0]["profileDefaults"],
          viewOrder: Array.isArray(sViewOrder) ? sViewOrder as string[] : undefined,
          appThemeId: typeof sAppThemeId === "string" ? sAppThemeId : undefined,
          profiles: sProfiles?.map((p) => ({
            name: p.name,
            commandLine: p.commandLine,
            startupCommand: p.startupCommand ?? "",
            colorScheme: p.colorScheme ?? "",
            startingDirectory: p.startingDirectory ?? "",
            hidden: p.hidden ?? false,
            cursorShape: (p.cursorShape ?? "bar") as import("@/stores/settings-store").CursorShape,
            padding: p.padding ?? { top: 8, right: 8, bottom: 8, left: 8 },
            scrollbackLines: p.scrollbackLines ?? 9001,
            opacity: p.opacity ?? 100,
            tabTitle: p.tabTitle ?? "",
            bellStyle: (p.bellStyle ?? "audible") as import("@/stores/settings-store").BellStyle,
            closeOnExit: (p.closeOnExit ?? "automatic") as import("@/stores/settings-store").CloseOnExit,
            antialiasingMode: (p.antialiasingMode ?? "grayscale") as import("@/stores/settings-store").AntialiasingMode,
            suppressApplicationTitle: p.suppressApplicationTitle ?? false,
            snapOnInput: p.snapOnInput ?? true,
          })) ?? [],
          colorSchemes: sColorSchemes?.map((cs) => {
            const base = makeDefaultColorScheme();
            return { ...base, ...Object.fromEntries(Object.entries(cs).filter(([, v]) => v !== undefined)) } as import("@/stores/settings-store").ColorScheme;
          }) ?? [],
          keybindings: sKeybindings?.map((kb) => ({
            keys: kb.keys,
            command: kb.command,
          })) ?? [],
        });

        // Apply layouts and workspaces to workspace store
        if (rawSettings.layouts?.length && rawSettings.workspaces?.length) {
          const layouts: Layout[] = rawSettings.layouts.map((l) => ({
            id: l.id,
            name: l.name,
            panes: l.panes.map((p) => ({
              x: p.x,
              y: p.y,
              w: p.w,
              h: p.h,
              viewType: p.viewType as ViewType,
            })),
          }));

          let paneCounter = 0;
          const workspaces: Workspace[] = rawSettings.workspaces.map((ws) => ({
            id: ws.id,
            name: ws.name,
            layoutId: ws.layoutId,
            panes: ws.panes.map((p) => ({
              id: `loaded-pane-${++paneCounter}`,
              x: p.x,
              y: p.y,
              w: p.w || 1,
              h: p.h || 1,
              view: {
                ...p.view,
                type: (p.view.type as ViewType) || "EmptyView",
              },
            })),
          }));

          useWorkspaceStore.setState({
            layouts,
            workspaces,
            activeWorkspaceId: workspaces[0]?.id ?? "ws-default",
          });
        }

        // Apply dock state
        const sDocks = rawSettings.docks;
        if (sDocks?.length) {
          const validPositions: DockPosition[] = ["top", "bottom", "left", "right"];
          const currentDocks = useDockStore.getState().docks;
          const updatedDocks = currentDocks.map((d) => {
            const saved = sDocks.find((sd) => sd.position === d.position);
            if (!saved || !validPositions.includes(saved.position as DockPosition)) return d;
            const savedAny = saved as unknown as Record<string, unknown>;
            const loadedPanes = Array.isArray(savedAny.panes)
              ? (savedAny.panes as { id: string; view: { type: string; [k: string]: unknown }; x?: number; y?: number; w?: number; h?: number }[]).map((p) => ({
                  id: p.id || `dp-${crypto.randomUUID().slice(0, 8)}`,
                  view: { ...p.view, type: (p.view.type as ViewType) || "EmptyView" },
                  x: p.x ?? 0,
                  y: p.y ?? 0,
                  w: p.w ?? 1,
                  h: p.h ?? 1,
                }))
              : undefined;
            return {
              ...d,
              activeView: (saved.activeView as ViewType) ?? d.activeView,
              views: Array.isArray(savedAny.views) ? savedAny.views as ViewType[] : d.views,
              visible: saved.visible ?? d.visible,
              size: typeof savedAny.size === "number" && savedAny.size >= 50 ? savedAny.size : d.size,
              ...(loadedPanes ? { panes: loadedPanes } : {}),
            };
          });
          useDockStore.setState({ docks: updatedDocks });
        }

        setLoaded(true);
      })
      .catch(() => {
        // Use defaults
        setLoaded(true);
      });
  }, []);

  const save = useCallback(async () => {
    await persistSession();
  }, []);

  return { loaded, save };
}
