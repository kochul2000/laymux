import { useState, useEffect, useCallback } from "react";
import {
  loadSettingsValidated,
  cleanTerminalOutputCache,
  type SettingsLoadResult,
  type ValidationWarning,
} from "@/lib/tauri-api";
import { persistSession, setBlockPersist } from "@/lib/persist-session";
import { applySettingsSnapshot } from "@/lib/settings-snapshot";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { useOverridesStore } from "@/stores/overrides-store";

/** Settings load status exposed to App for recovery UI. */
export interface SettingsLoadStatus {
  /** Whether settings loaded with issues. */
  result: SettingsLoadResult | null;
  /** Warnings from validation (repaired items). */
  warnings: ValidationWarning[];
}

/**
 * Hook that loads settings from disk on mount and provides a save function.
 * Bridges the gap between the Tauri backend settings.json and the frontend stores.
 */
export function useSessionPersistence() {
  const [loaded, setLoaded] = useState(false);
  const [loadStatus, setLoadStatus] = useState<SettingsLoadStatus>({
    result: null,
    warnings: [],
  });

  useEffect(() => {
    loadSettingsValidated()
      .then((loadResult) => {
        setLoadStatus({
          result: loadResult,
          warnings:
            loadResult.status === "repaired" || loadResult.status === "ok"
              ? loadResult.warnings
              : [],
        });

        // When settings.json couldn't be parsed, don't hydrate stores with defaults —
        // this prevents saveBeforeClose from overwriting the user's original file.
        if (loadResult.status === "parse_error") {
          setBlockPersist(true);
          setLoaded(true);
          return;
        }

        const rawSettings = loadResult.settings;
        applySettingsSnapshot(rawSettings, { includeStructural: true });

        // Clean orphaned terminal output cache files
        const allPaneIds: string[] = [
          ...(rawSettings.workspaces?.flatMap((ws) =>
            ws.panes.map((p) => p.id).filter((id): id is string => Boolean(id)),
          ) ?? []),
          ...(rawSettings.docks?.flatMap(
            (d) => d.panes?.map((p) => p.id).filter((id): id is string => Boolean(id)) ?? [],
          ) ?? []),
        ];
        if (allPaneIds.length > 0) {
          cleanTerminalOutputCache(allPaneIds).catch((err) => {
            console.warn("[useSessionPersistence] Failed to clean orphaned cache:", err);
          });
        }

        // Prune localStorage 오버라이드에서 살아있지 않은 paneId 제거.
        // 하이드레이션 이후 워크스페이스/독 스토어의 현재 pane 집합을 기준으로 GC.
        const alivePaneIds = new Set<string>();
        for (const ws of useWorkspaceStore.getState().workspaces) {
          for (const p of ws.panes) alivePaneIds.add(p.id);
        }
        for (const d of useDockStore.getState().docks) {
          for (const p of d.panes ?? []) alivePaneIds.add(p.id);
        }
        useOverridesStore.getState().gcStale(alivePaneIds);

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

  return { loaded, save, loadStatus };
}
