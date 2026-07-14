/**
 * Pure logic for staggered pane reveal (see usePaneRevealQueue).
 *
 * Opening a workspace with many panes mounts every TerminalView in one React
 * commit, blocking the main thread long enough to flash unpainted (white) pane
 * boxes. To keep the user from seeing that, panes are revealed progressively:
 * a small initial batch mounts immediately and the rest mount one animation
 * frame at a time, each showing a spinner placeholder until revealed.
 *
 * These helpers are the geometry-agnostic state transitions, split out so they
 * can be unit-tested without a DOM (same pattern as pane-numbers.ts).
 */

export const DEFAULT_INITIAL_BATCH = 4;
export const DEFAULT_PER_FRAME = 1;

/**
 * Reveal order: the focused pane first (so keystrokes are never dropped onto an
 * unmounted terminal), then the caller's array order. Returns the input array
 * unchanged when there is no focused pane in the set.
 */
export function orderedRevealIds(paneIds: string[], focusedPaneId: string | null): string[] {
  if (!focusedPaneId || !paneIds.includes(focusedPaneId)) return paneIds;
  return [focusedPaneId, ...paneIds.filter((id) => id !== focusedPaneId)];
}

/**
 * The set that must be revealed synchronously (never waits for a frame): the
 * focused pane plus the initial batch, in reveal order. When `revealAll` is set
 * (small layouts, or reduced-motion) every pane is baseline — no staggering.
 */
export function baselineReveal(
  paneIds: string[],
  focusedPaneId: string | null,
  initialBatch: number,
  revealAll: boolean,
): Set<string> {
  const order = orderedRevealIds(paneIds, focusedPaneId);
  const take = revealAll ? order.length : Math.min(Math.max(initialBatch, 0), order.length);
  const set = new Set<string>();
  for (let i = 0; i < take; i++) set.add(order[i]);
  return set;
}

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

/**
 * Enforce the invariants on the revealed set for the current pane list:
 * - prune ids that no longer exist (pane removed / evicted),
 * - keep every still-present already-revealed id (add-only: a mounted terminal
 *   is never torn down by the queue),
 * - guarantee the baseline (focused + initial batch, or all) is revealed.
 *
 * Returns `prev` unchanged (same reference) when nothing changes, so callers
 * relying on referential equality skip needless re-renders.
 */
export function reconcileReveal(
  prev: ReadonlySet<string>,
  paneIds: string[],
  focusedPaneId: string | null,
  initialBatch: number,
  revealAll: boolean,
): ReadonlySet<string> {
  const paneSet = new Set(paneIds);
  const next = new Set<string>();
  for (const id of prev) if (paneSet.has(id)) next.add(id);
  for (const id of baselineReveal(paneIds, focusedPaneId, initialBatch, revealAll)) next.add(id);
  return sameMembers(prev, next) ? prev : next;
}

/**
 * Reveal the next `perFrame` not-yet-revealed panes in reveal order. Returns
 * `prev` unchanged when there is nothing left to reveal.
 */
export function addNextRevealBatch(
  prev: ReadonlySet<string>,
  paneIds: string[],
  focusedPaneId: string | null,
  perFrame: number,
): ReadonlySet<string> {
  const order = orderedRevealIds(paneIds, focusedPaneId);
  const next = new Set(prev);
  let added = 0;
  for (const id of order) {
    if (added >= perFrame) break;
    if (!next.has(id)) {
      next.add(id);
      added++;
    }
  }
  return added === 0 ? prev : next;
}

/** All present pane ids are revealed → progressive reveal is complete. */
export function isRevealComplete(revealed: ReadonlySet<string>, paneIds: string[]): boolean {
  for (const id of paneIds) if (!revealed.has(id)) return false;
  return true;
}
