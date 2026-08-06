import { toTerminalId } from "./pane-ids";
import { writeToTerminal } from "./tauri-api";
import { useTerminalStore, type TerminalInstance } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

/**
 * Workspace-wide clear (issue #726, ADR-0137 — supersedes ADR-0113).
 *
 * Ctrl+Alt+L broadcasts one Ctrl+L keypress to every TerminalView pane of the
 * active workspace — exactly what pressing Ctrl+L in each pane by hand would
 * do. There is no per-activity text substitution and nothing to configure.
 *
 * Dock panes are out of scope: docks are fixed surfaces that survive workspace
 * switches, so they are not part of "this workspace".
 */

/** What a real Ctrl+L keypress sends. */
export const CTRL_L = "\x0c";

/** Why a pane was left untouched. */
export type WorkspaceClearSkipReason =
  /** No PTY session yet (pane still starting, or evicted while hidden). */
  "notReady";

export interface WorkspaceClearResult {
  /**
   * Terminals the Ctrl+L byte was successfully written to — not a guarantee
   * that the target interpreted it as "clear the screen". A program reading
   * its own stdin as data (rather than leaving line editing to the terminal)
   * receives it as a literal `\x0c`, same as a real keypress would.
   */
  cleared: string[];
  skipped: { terminalId: string; reason: WorkspaceClearSkipReason }[];
  /**
   * Terminals whose write was rejected. A remote client holding the control
   * lease and a PTY that died between planning and writing both land here —
   * without this array they would leave every list empty, which reads exactly
   * like "this workspace has no terminal panes".
   */
  failed: { terminalId: string; error: string }[];
}

/** True when the clear touched nothing at all — worth telling the user about. */
export function isNoOpClearResult(result: WorkspaceClearResult): boolean {
  return result.cleared.length === 0;
}

/** One-line summary for a log or a toast. */
export function summarizeClearResult(result: WorkspaceClearResult): string {
  const parts = [`cleared ${result.cleared.length}`];
  if (result.skipped.length > 0) parts.push(`skipped ${result.skipped.length}`);
  if (result.failed.length > 0) parts.push(`failed ${result.failed.length}`);
  return parts.join(", ");
}

/** Pane ids of a workspace's TerminalView panes, in layout order. */
export function terminalPaneIdsForWorkspace(workspaceId: string): string[] {
  const workspace = useWorkspaceStore.getState().workspaces.find((ws) => ws.id === workspaceId);
  if (!workspace) return [];
  return workspace.panes.filter((pane) => pane.view.type === "TerminalView").map((pane) => pane.id);
}

async function writeCtrlL(
  paneId: string,
  instance: TerminalInstance | undefined,
): Promise<{
  cleared?: string;
  skipped?: { terminalId: string; reason: "notReady" };
  failed?: { terminalId: string; error: string };
}> {
  const terminalId = toTerminalId(paneId);
  // `sessionReady` is undefined for instances registered before the backend
  // answered; only an explicit `false` means "no PTY yet".
  if (!instance || instance.sessionReady === false) {
    return { skipped: { terminalId, reason: "notReady" } };
  }
  try {
    await writeToTerminal(terminalId, CTRL_L);
    return { cleared: terminalId };
  } catch (error) {
    return {
      failed: { terminalId, error: error instanceof Error ? error.message : String(error) },
    };
  }
}

/**
 * Production entry point: broadcast Ctrl+L to every TerminalView pane of a
 * workspace. Terminals are written to concurrently, and a rejected write
 * never stops the others.
 */
export async function clearWorkspace(workspaceId: string): Promise<WorkspaceClearResult> {
  const paneIds = terminalPaneIdsForWorkspace(workspaceId);
  const byId = new Map(
    useTerminalStore.getState().instances.map((instance) => [instance.id, instance]),
  );

  const outcomes = await Promise.all(
    paneIds.map((paneId) => writeCtrlL(paneId, byId.get(toTerminalId(paneId)))),
  );

  const result: WorkspaceClearResult = { cleared: [], skipped: [], failed: [] };
  for (const outcome of outcomes) {
    if (outcome.cleared) result.cleared.push(outcome.cleared);
    if (outcome.skipped) result.skipped.push(outcome.skipped);
    if (outcome.failed) result.failed.push(outcome.failed);
  }
  return result;
}
