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
  /** Optional mount seed; subsequent paths still use the pane's receive gate. */
  initialCwd?: string;
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
export interface SyncGroupCwdContext {
  cwd: string;
  /** The actual source, needed to distinguish identical paths in WSL guests. */
  sourceTerminalId?: string;
}

export function useSyncGroupCwd(options: SyncGroupCwdOptions): string {
  return useSyncGroupCwdContext(options).cwd;
}

export function useSyncGroupCwdContext({
  syncGroup,
  instanceId,
  cwdReceive = true,
  initialCwd,
}: SyncGroupCwdOptions): SyncGroupCwdContext {
  // Seeded from the store so a freshly mounted pane shows its group's repo
  // immediately instead of waiting for the next propagation event.
  const groupTerminal = useTerminalStore((s) => {
    if (!syncGroup) return undefined;
    return s.instances.find((t) => t.syncGroup === syncGroup && t.cwd);
  });
  const groupCwd = groupTerminal?.cwd ?? "";
  const groupTerminalId = groupTerminal?.id;
  const [context, setContext] = useState<SyncGroupCwdContext>({
    cwd: initialCwd || groupCwd,
    sourceTerminalId: initialCwd ? undefined : groupTerminalId,
  });
  const [eventScope, setEventScope] = useState<string | null>(null);
  // The seed keeps applying until an event supersedes it: `groupCwd` only
  // changes when the group's terminals do, and following it is the same
  // intent as following a propagation.
  const seedKey = `${groupTerminalId ?? ""}\0${groupCwd}`;
  const [seed, setSeed] = useState(seedKey);
  const [scope, setScope] = useState({ group: syncGroup, receive: cwdReceive });
  if (scope.group !== syncGroup || scope.receive !== cwdReceive) {
    setScope({ group: syncGroup, receive: cwdReceive });
    setSeed(seedKey);
    if (scope.group !== syncGroup) setEventScope(null);
    if (cwdReceive && (scope.group !== syncGroup || !scope.receive))
      setContext({ cwd: groupCwd, sourceTerminalId: groupTerminalId });
  } else if (seed !== seedKey) {
    setSeed(seedKey);
    if (eventScope !== syncGroup && cwdReceive && groupCwd)
      setContext({ cwd: groupCwd, sourceTerminalId: groupTerminalId });
  }

  useEffect(() => {
    if (!syncGroup) return;
    let cancelled = false;

    const normalPromise = onTerminalCwdChanged((data) => {
      if (cancelled || !cwdReceive || data.cwdSend === false) return;
      const terminal = useTerminalStore.getState().instances.find((t) => t.id === data.terminalId);
      if (!terminal || terminal.syncGroup !== syncGroup) return;
      setEventScope(syncGroup);
      setContext({ cwd: data.cwd, sourceTerminalId: data.terminalId });
    });

    const forcePromise = onSyncCwd((data) => {
      if (cancelled || !data.force || !cwdReceive) return;
      if (data.groupId !== syncGroup || data.terminalId === instanceId) return;
      const source = useTerminalStore
        .getState()
        .instances.find((terminal) => terminal.id === data.terminalId);
      setEventScope(syncGroup);
      setContext({ cwd: data.path, sourceTerminalId: source?.id });
    });

    return () => {
      cancelled = true;
      normalPromise.then((unlisten) => unlisten());
      forcePromise.then((unlisten) => unlisten());
    };
  }, [cwdReceive, syncGroup, instanceId]);

  return context;
}
