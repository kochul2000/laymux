import type { TerminalInstance } from "@/stores/terminal-store";
import type { DockPane, DockPosition, Workspace, WorkspacePane } from "@/stores/types";
import { getPaneInstanceId } from "@/lib/view-instance-id";

interface FocusedTerminalTargetState {
  workspaces: readonly Workspace[];
  activeWorkspaceId: string;
  focusedPaneIndex: number | null;
  docks: readonly { position: DockPosition; panes: readonly DockPane[] }[];
  focusedDock: DockPosition | null;
  focusedDockPaneId: string | null;
}

interface FocusedTerminalCwdState extends FocusedTerminalTargetState {
  terminals: readonly Pick<TerminalInstance, "id" | "cwd">[];
}

/**
 * Resolve the pane that owns human terminal focus.
 *
 * Dock focus wins over the workspace grid. The remaining inputs are the same
 * raw focus SoTs that route keyboard input, so persistent per-workspace
 * `TerminalInstance.isFocused` metadata cannot make chrome point at a hidden
 * workspace or an old pane.
 */
export function resolveFocusedTerminalPane(
  state: FocusedTerminalTargetState,
): WorkspacePane | DockPane | undefined {
  const pane =
    state.focusedDock !== null
      ? state.docks
          .find((dock) => dock.position === state.focusedDock)
          ?.panes.find((candidate) => candidate.id === state.focusedDockPaneId)
      : (() => {
          const workspace = state.workspaces.find(
            (candidate) => candidate.id === state.activeWorkspaceId,
          );
          return workspace && state.focusedPaneIndex !== null
            ? workspace.panes[state.focusedPaneIndex]
            : undefined;
        })();

  return pane?.view.type === "TerminalView" ? pane : undefined;
}

/** CWD reported by the live terminal that owns the current UI focus. */
export function resolveFocusedTerminalCwd(state: FocusedTerminalCwdState): string | undefined {
  const pane = resolveFocusedTerminalPane(state);
  if (!pane) return undefined;
  const instanceId = getPaneInstanceId(pane);
  return state.terminals.find((terminal) => terminal.id === instanceId)?.cwd;
}
