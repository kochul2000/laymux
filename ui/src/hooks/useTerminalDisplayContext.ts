import { useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { toTerminalId } from "@/lib/pane-ids";
import { useTerminalStore } from "@/stores/terminal-store";
import { pruneTerminalDisplayContexts } from "@/lib/terminal-display-checkpoint";
import {
  loadTerminalDisplayContexts,
  startTerminalDisplayContextSync,
} from "@/lib/terminal-display-context";

export function useTerminalDisplayContext(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const stop = startTerminalDisplayContextSync();
    const prune = () =>
      pruneTerminalDisplayContexts({
        workspaces: useWorkspaceStore.getState().workspaces,
        docks: useDockStore.getState().docks,
      });
    const stopWorkspaces = useWorkspaceStore.subscribe((state, before) => {
      if (state.workspaces !== before.workspaces) prune();
    });
    const stopDocks = useDockStore.subscribe((state, before) => {
      if (state.docks !== before.docks) prune();
    });
    const stopTerminals = useTerminalStore.subscribe((state, before) => {
      // A live event may still publish between structural deletion and React's
      // unmount cleanup. Prune once more when the instance actually goes away.
      if (state.instances.length < before.instances.length) prune();
    });
    const panes = [
      ...useWorkspaceStore.getState().workspaces.flatMap((w) => w.panes.flatMap((p) => p.layers)),
      ...useDockStore.getState().docks.flatMap((d) => d.panes),
    ];
    const profiles = Object.fromEntries(
      panes
        .filter((p) => p.view.type === "TerminalView")
        .map((p) => [
          toTerminalId(p.id),
          typeof p.view.profile === "string" && p.view.profile ? p.view.profile : "PowerShell",
        ]),
    );
    void loadTerminalDisplayContexts(profiles, () => !cancelled)
      .then(() => {
        if (!cancelled) prune();
      })
      .catch(() => {
        console.warn("[terminal-display] Previous display context unavailable");
      });
    return () => {
      cancelled = true;
      stop();
      stopWorkspaces();
      stopDocks();
      stopTerminals();
    };
  }, [ready]);
}
