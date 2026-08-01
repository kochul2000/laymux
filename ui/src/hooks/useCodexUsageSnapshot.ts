import { useCallback, useSyncExternalStore } from "react";
import {
  readCodexSnapshot,
  refreshCodexSnapshot,
  subscribeCodexUsage,
} from "@/lib/codex-usage-subscription";

/**
 * Read the shared Codex snapshot for one account.
 *
 * Every consumer of the same config dir joins one poller, so a UsageView and a
 * status widget always show the same capture and only one `codex app-server`
 * runs per interval (ADR-0104, ADR-0105).
 */
export function useCodexUsageSnapshot(refreshSeconds: number, configDir = "") {
  const intervalMs = Math.min(3_600, Math.max(600, refreshSeconds)) * 1_000;

  const subscribe = useCallback(
    (onChange: () => void) => subscribeCodexUsage(configDir, intervalMs, onChange),
    [configDir, intervalMs],
  );
  const snapshot = useSyncExternalStore(
    subscribe,
    () => readCodexSnapshot(configDir),
    () => readCodexSnapshot(configDir),
  );

  const refresh = useCallback(() => refreshCodexSnapshot(configDir), [configDir]);

  return { snapshot, refresh };
}
