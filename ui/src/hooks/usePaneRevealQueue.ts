import { useEffect, useState } from "react";
import {
  DEFAULT_INITIAL_BATCH,
  DEFAULT_PER_FRAME,
  addNextRevealBatch,
  isRevealComplete,
  reconcileReveal,
} from "@/lib/pane-reveal";

export interface PaneRevealQueueOptions {
  /** Progress the queue only while true (inactive/hidden workspaces stay paused). */
  active: boolean;
  /** Always revealed immediately and jumps the queue when it changes. */
  focusedPaneId: string | null;
  /** Panes count ≤ this ⇒ reveal all synchronously (no staggering). */
  initialBatch?: number;
  /** Panes revealed per animation frame. */
  perFrame?: number;
  /** Panes that Automation must mount without waiting for queue progression. */
  requestedPaneIds?: ReadonlySet<string>;
}

const NO_REQUESTED_PANES: ReadonlySet<string> = new Set();

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/**
 * Progressively reveals panes so a many-pane workspace mounts a few terminals
 * at a time instead of all in one main-thread-blocking commit. Returns the set
 * of pane ids whose real view should mount now; the caller renders a spinner
 * placeholder for the rest. See lib/pane-reveal.ts for the pure transitions.
 *
 * Small layouts (≤ initialBatch) and reduced-motion reveal everything
 * synchronously, so their behavior is identical to mounting without the queue.
 */
export function usePaneRevealQueue(
  paneIds: string[],
  {
    active,
    focusedPaneId,
    initialBatch = DEFAULT_INITIAL_BATCH,
    perFrame = DEFAULT_PER_FRAME,
    requestedPaneIds = NO_REQUESTED_PANES,
  }: PaneRevealQueueOptions,
): ReadonlySet<string> {
  const revealAll = prefersReducedMotion() || paneIds.length <= initialBatch;

  // paneIds is a fresh array each render; track it by content signature so the
  // effects re-run on any id change (add/remove/reorder) with a fresh closure,
  // while identity churn alone never re-fires them.
  const idsKey = paneIds.join(" ");

  const [revealed, setRevealed] = useState<ReadonlySet<string>>(() =>
    reconcileReveal(new Set(), paneIds, focusedPaneId, initialBatch, revealAll, requestedPaneIds),
  );

  // Keep the invariants (prune dead ids, always reveal focused + baseline)
  // whenever the pane set, focus, or reveal-all mode changes.
  useEffect(() => {
    setRevealed((prev) =>
      reconcileReveal(prev, paneIds, focusedPaneId, initialBatch, revealAll, requestedPaneIds),
    );
    // paneIds is tracked by idsKey (content signature), not identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, focusedPaneId, initialBatch, revealAll, requestedPaneIds]);

  // Progressive reveal: each committed batch re-runs this effect (revealed dep)
  // and schedules the next frame, until every present pane is revealed. rAF is
  // scheduled outside any state updater so StrictMode's double-invoke cannot
  // leak an uncancelled frame (cleanup cancels exactly the handle it created).
  useEffect(() => {
    if (revealAll || !active) return;
    if (isRevealComplete(revealed, paneIds)) return;
    const handle = requestAnimationFrame(() => {
      setRevealed((prev) => addNextRevealBatch(prev, paneIds, focusedPaneId, perFrame));
    });
    return () => cancelAnimationFrame(handle);
    // paneIds is tracked by idsKey (content signature), not identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, revealed, active, revealAll, perFrame, focusedPaneId]);

  return revealed;
}
