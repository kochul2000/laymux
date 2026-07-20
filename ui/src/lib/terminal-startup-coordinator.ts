/**
 * Pure state transitions for globally serializing terminal startup.
 *
 * A terminal is revealed when it receives the single startup slot. The slot is
 * held until TerminalView reports both a ready PTY session and its first xterm
 * render. Already revealed terminals stay mounted while their pane still
 * exists; changing focus only affects the order of terminals that have not
 * started yet.
 */

export const TERMINAL_STARTUP_SLOT_TIMEOUT_MS = 10_000;
export const TERMINAL_AUTOMATION_READY_TIMEOUT_MS = TERMINAL_STARTUP_SLOT_TIMEOUT_MS * 2;

export interface TerminalStartupState {
  knownPaneIds: readonly string[];
  eligiblePaneIds: readonly string[];
  revealedPaneIds: ReadonlySet<string>;
  activePaneId: string | null;
}

export interface TerminalStartupSyncInput {
  knownPaneIds: readonly string[];
  eligiblePaneIds: readonly string[];
  /** Terminals mounted before the coordinator observed them (for restore/HMR). */
  readyPaneIds?: readonly string[];
}

interface CandidatePane {
  id: string;
  view: { type: string };
}

interface CandidateWorkspace {
  id: string;
  panes: readonly CandidatePane[];
}

interface CandidateDock {
  position: string;
  visible: boolean;
  panes: readonly CandidatePane[];
}

export interface CollectTerminalStartupCandidatesInput {
  workspaces: readonly CandidateWorkspace[];
  activeWorkspaceId: string;
  focusedPaneIndex: number | null;
  docks: readonly CandidateDock[];
  focusedDock: string | null;
  focusedDockPaneId: string | null;
  persistHiddenDocks: boolean;
  evictedPaneIds: ReadonlySet<string>;
  requestedPaneIds: readonly string[];
  /** Focus-owning terminals outside workspace/dock panes (for example FileViewer). */
  foregroundTerminalIds?: readonly string[];
}

export interface TerminalStartupCandidates {
  knownPaneIds: string[];
  eligiblePaneIds: string[];
}

function unique(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function grantNext(state: TerminalStartupState): TerminalStartupState {
  if (state.activePaneId !== null) return state;
  const nextPaneId = state.eligiblePaneIds.find((id) => !state.revealedPaneIds.has(id));
  if (!nextPaneId) return state;

  const revealedPaneIds = new Set(state.revealedPaneIds);
  revealedPaneIds.add(nextPaneId);
  return { ...state, activePaneId: nextPaneId, revealedPaneIds };
}

export function createTerminalStartupState(): TerminalStartupState {
  return {
    knownPaneIds: [],
    eligiblePaneIds: [],
    revealedPaneIds: new Set(),
    activePaneId: null,
  };
}

/** Reconcile pane membership and grant at most one unstarted eligible pane. */
export function syncTerminalStartupCandidates(
  state: TerminalStartupState,
  input: TerminalStartupSyncInput,
): TerminalStartupState {
  const knownPaneIds = unique(input.knownPaneIds);
  const knownPaneSet = new Set(knownPaneIds);
  const eligiblePaneIds = unique(input.eligiblePaneIds).filter((id) => knownPaneSet.has(id));
  const readyPaneIds = new Set((input.readyPaneIds ?? []).filter((id) => knownPaneSet.has(id)));

  const revealedPaneIds = new Set<string>();
  for (const id of state.revealedPaneIds) {
    if (knownPaneSet.has(id)) revealedPaneIds.add(id);
  }
  for (const id of readyPaneIds) revealedPaneIds.add(id);

  const activePaneId =
    state.activePaneId &&
    knownPaneSet.has(state.activePaneId) &&
    !readyPaneIds.has(state.activePaneId)
      ? state.activePaneId
      : null;

  const unchanged =
    activePaneId === state.activePaneId &&
    sameIds(knownPaneIds, state.knownPaneIds) &&
    sameIds(eligiblePaneIds, state.eligiblePaneIds) &&
    sameMembers(revealedPaneIds, state.revealedPaneIds);

  const reconciled = unchanged
    ? state
    : { knownPaneIds, eligiblePaneIds, revealedPaneIds, activePaneId };
  return grantNext(reconciled);
}

/** Release the current pane's slot after PTY readiness + first xterm render. */
export function settleTerminalStartup(
  state: TerminalStartupState,
  paneId: string,
): TerminalStartupState {
  if (state.activePaneId !== paneId) return state;
  return grantNext({ ...state, activePaneId: null });
}

function terminalPaneIds(panes: readonly CandidatePane[]): string[] {
  return panes.filter((pane) => pane.view.type === "TerminalView").map((pane) => pane.id);
}

/**
 * Build global membership and pending order. Automation requests win, then the
 * focused pane, then active-workspace and visible-dock reading order.
 */
export function collectTerminalStartupCandidates({
  workspaces,
  activeWorkspaceId,
  focusedPaneIndex,
  docks,
  focusedDock,
  focusedDockPaneId,
  persistHiddenDocks,
  evictedPaneIds,
  requestedPaneIds,
  foregroundTerminalIds = [],
}: CollectTerminalStartupCandidatesInput): TerminalStartupCandidates {
  const knownPaneIds: string[] = [];
  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);

  for (const workspace of workspaces) {
    for (const paneId of terminalPaneIds(workspace.panes)) {
      if (workspace.id !== activeWorkspaceId && evictedPaneIds.has(paneId)) continue;
      knownPaneIds.push(paneId);
    }
  }

  for (const dock of docks) {
    if (!dock.visible && !persistHiddenDocks) continue;
    knownPaneIds.push(...terminalPaneIds(dock.panes));
  }
  knownPaneIds.push(...foregroundTerminalIds);

  const layoutEligiblePaneIds = [
    ...terminalPaneIds(activeWorkspace?.panes ?? []),
    ...docks.filter((dock) => dock.visible).flatMap((dock) => terminalPaneIds(dock.panes)),
  ];
  const baseEligiblePaneIds = [...foregroundTerminalIds, ...layoutEligiblePaneIds];
  const eligiblePaneSet = new Set(baseEligiblePaneIds);

  let focusedPaneId: string | null = null;
  if (focusedDock !== null) {
    focusedPaneId = focusedDockPaneId;
  } else if (focusedPaneIndex !== null) {
    const pane = activeWorkspace?.panes[focusedPaneIndex];
    focusedPaneId = pane?.view.type === "TerminalView" ? pane.id : null;
  }

  const eligiblePaneIds = unique([
    ...requestedPaneIds.filter((id) => eligiblePaneSet.has(id)),
    ...foregroundTerminalIds,
    ...(focusedPaneId && eligiblePaneSet.has(focusedPaneId) ? [focusedPaneId] : []),
    ...layoutEligiblePaneIds,
  ]);

  return { knownPaneIds: unique(knownPaneIds), eligiblePaneIds };
}
