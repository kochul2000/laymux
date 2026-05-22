import { useCallback } from "react";
import { resolveSyncCwd, type SyncCwdPair } from "@/lib/sync-cwd-config";
import type { TerminalLocation } from "@/stores/settings-store";
import {
  defaultProfileDefaults,
  FALLBACK_PROFILE,
  useSettingsStore,
} from "@/stores/settings-store";
import type { ViewInstanceConfig } from "@/stores/types";

function getCwdProfileName(
  view: ViewInstanceConfig,
  defaultProfile: string,
  fileExplorerShellProfile: string,
): string {
  if (view.type === "FileExplorerView") {
    return fileExplorerShellProfile || defaultProfile || FALLBACK_PROFILE;
  }
  return (view.profile as string) || defaultProfile || FALLBACK_PROFILE;
}

/**
 * Resolve the effective CWD defaults used by pane controls.
 *
 * The subscriptions are intentionally explicit. A stored resolver function that
 * calls get() would not re-render existing panes when syncCwd settings change.
 */
export function useCwdDefaultsResolver(
  location: TerminalLocation,
): (view: ViewInstanceConfig) => SyncCwdPair {
  const defaultProfile = useSettingsStore((s) => s.defaultProfile);
  const fileExplorerShellProfile = useSettingsStore((s) => s.fileExplorer?.shellProfile ?? "");
  const profiles = useSettingsStore((s) => s.profiles ?? []);
  const profileDefaultsSyncCwd = useSettingsStore(
    (s) => s.profileDefaults?.syncCwd ?? defaultProfileDefaults.syncCwd,
  );
  const syncCwdDefaults = useSettingsStore((s) => s.syncCwdDefaults);

  return useCallback(
    (view: ViewInstanceConfig) => {
      const profileName = getCwdProfileName(view, defaultProfile, fileExplorerShellProfile);
      return resolveSyncCwd({
        profileName,
        location,
        profileSyncCwd: profiles.find((p) => p.name === profileName)?.syncCwd,
        profileDefaultsSyncCwd,
        syncCwdDefaults,
      });
    },
    [
      defaultProfile,
      fileExplorerShellProfile,
      location,
      profileDefaultsSyncCwd,
      profiles,
      syncCwdDefaults,
    ],
  );
}
