import { useTerminalStore } from "@/stores/terminal-store";
import { useTerminalDisplayStore } from "@/stores/terminal-display-store";
import type { Settings } from "./tauri-api";
import { toTerminalId } from "./pane-ids";
import {
  projectTerminalDisplay,
  snapshotTerminalDisplay,
  validDisplayContext,
  type TerminalDisplayContext,
} from "./terminal-display-context";

/** Content IDs, including hidden stack layers; never retain deleted/profile-changed panes. */
function terminalProfiles(settings: Pick<Settings, "workspaces" | "docks">): Map<string, string> {
  const contents = [
    ...settings.workspaces.flatMap((w) =>
      w.panes.flatMap((p) =>
        p.layers?.length ? p.layers : p.id && p.view ? [{ id: p.id, view: p.view }] : [],
      ),
    ),
    ...settings.docks.flatMap((d) => d.panes ?? []),
  ];
  return new Map(
    contents
      .filter((p) => p.view.type === "TerminalView")
      .map((p) => [
        toTerminalId(p.id),
        typeof p.view.profile === "string" && p.view.profile ? p.view.profile : "PowerShell",
      ]),
  );
}

export function collectTerminalDisplayCheckpoint(
  settings: Pick<Settings, "workspaces" | "docks">,
): Record<string, TerminalDisplayContext> {
  const history = useTerminalDisplayStore.getState().contexts;
  const instances = new Map(useTerminalStore.getState().instances.map((i) => [i.id, i]));
  const contexts: Record<string, TerminalDisplayContext> = {};
  for (const [id, profile] of terminalProfiles(settings)) {
    const instance = instances.get(id);
    const previous = history[id]?.profile === profile ? history[id] : undefined;
    const live = instance?.profile === profile ? instance : undefined;
    if (live) contexts[id] = snapshotTerminalDisplay(projectTerminalDisplay(live, previous));
    else if (previous) contexts[id] = previous;
  }
  return contexts;
}

export function restoreTerminalDisplayCheckpoint(
  contexts: Record<string, TerminalDisplayContext> | undefined,
  settings: Pick<Settings, "workspaces" | "docks">,
): void {
  const profiles = terminalProfiles(settings);
  useTerminalDisplayStore.setState({
    contexts: Object.fromEntries(
      Object.entries(contexts ?? {}).filter(
        ([id, context]) => validDisplayContext(context) && context.profile === profiles.get(id),
      ),
    ),
  });
}
