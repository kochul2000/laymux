import { useEffect, useState } from "react";
import { useTerminalStore } from "@/stores/terminal-store";
import { onSyncCwd, onTerminalCwdChanged } from "@/lib/tauri-api";

export interface SyncGroupCwdOptions {
  /** Sync group this view follows. Empty string disables following. */
  syncGroup: string;
  /** This view instance's id, so it ignores its own force propagation. */
  instanceId: string;
  /** Per-pane receive gate. */
  cwdReceive?: boolean;
}

/**
 * Follow a sync group's CWD, read-only.
 *
 * A view that only *consumes* the propagated CWD (no navigation, no send) needs
 * exactly the receive half of what `FileExplorerView` implements inline: the
 * group's current CWD at mount plus the two propagation paths, both gated on
 * `cwdReceive` (issue #375):
 *  1. `terminal-cwd-changed` — ordinary OSC CWD change; followed only when the
 *     source had `cwdSend` on.
 *  2. `sync-cwd` with `force` — the control bar's one-shot propagation. `force`
 *     bypasses the *source* gate only; this pane's `cwdReceive` still wins.
 */
export function useSyncGroupCwd({
  syncGroup,
  instanceId,
  cwdReceive = true,
}: SyncGroupCwdOptions): string {
  // Seeded from the store so a freshly mounted pane shows its group's repo
  // immediately instead of waiting for the next propagation event.
  const groupCwd = useTerminalStore((s) => {
    if (!syncGroup) return "";
    return s.instances.find((t) => t.syncGroup === syncGroup && t.cwd)?.cwd ?? "";
  });
  const [cwd, setCwd] = useState(groupCwd);
  // The seed keeps applying until an event supersedes it: `groupCwd` only
  // changes when the group's terminals do, and following it is the same
  // intent as following a propagation.
  const [seed, setSeed] = useState(groupCwd);
  if (seed !== groupCwd) {
    setSeed(groupCwd);
    if (cwdReceive && groupCwd) setCwd(groupCwd);
  }

  useEffect(() => {
    if (!syncGroup) return;
    let cancelled = false;

    const normalPromise = onTerminalCwdChanged((data) => {
      if (cancelled || !cwdReceive || data.cwdSend === false) return;
      const terminal = useTerminalStore.getState().instances.find((t) => t.id === data.terminalId);
      if (!terminal || terminal.syncGroup !== syncGroup) return;
      setCwd(data.cwd);
    });

    const forcePromise = onSyncCwd((data) => {
      if (cancelled || !data.force || !cwdReceive) return;
      if (data.groupId !== syncGroup || data.terminalId === instanceId) return;
      setCwd(data.path);
    });

    return () => {
      cancelled = true;
      normalPromise.then((unlisten) => unlisten());
      forcePromise.then((unlisten) => unlisten());
    };
  }, [cwdReceive, syncGroup, instanceId]);

  return cwd;
}
