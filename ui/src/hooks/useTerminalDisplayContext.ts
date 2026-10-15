import { useEffect } from "react";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { toTerminalId } from "@/lib/pane-ids";
import {
  loadTerminalDisplayContexts,
  startTerminalDisplayContextSync,
} from "@/lib/terminal-display-context";

export function useTerminalDisplayContext(ready: boolean): void {
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const stop = startTerminalDisplayContextSync();
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
    void loadTerminalDisplayContexts(profiles, () => !cancelled).catch(() => {
      console.warn("[terminal-display] Previous display context unavailable");
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [ready]);
}
