import { setSleepInhibit } from "@/lib/tauri-api";
import { useSleepInhibitStore } from "@/stores/sleep-inhibit-store";

/**
 * The one place that talks to the OS sleep inhibitor (ADR-0113).
 *
 * Module scope, not component scope. The state being tracked here — what the
 * backend last confirmed, what is in flight — belongs to the *process*, not to
 * whichever React tree happens to be mounted. Keeping it in refs meant a
 * remount started a second queue whose calls could interleave with the old
 * one's and settle in the wrong order.
 *
 * Invariants:
 * - At most one request is in flight. The command is async on the Rust side,
 *   so overlapping calls could be applied out of order.
 * - Values that came and went while a call was out are collapsed: only where
 *   the caller ended up is worth another round trip.
 * - A refused value is held back until the wanted value changes, so a machine
 *   that always refuses does not spin.
 * - A forced release outranks all of that. It is the last chance to let go.
 */

/** What the caller wants. */
let desired: boolean | null = null;
/** What the backend confirmed. `null` means unknown — assume nothing. */
let confirmed: boolean | null = null;
/** A value the backend would not deliver; held back until `desired` moves. */
let refused: boolean | null = null;
let inFlight = false;
/** A release that must be attempted whatever the dedupe would say. */
let releasePending = false;
let releaseAttemptsLeft = 0;

/**
 * How many times a forced release is retried before giving up.
 *
 * Bounded because the retry is driven by its own failure: an unbounded loop
 * would spin as fast as promises resolve on a machine that cannot release.
 */
const RELEASE_ATTEMPTS = 3;

function report(active: boolean, satisfied: boolean): void {
  useSleepInhibitStore.getState().reportResult(active, satisfied);
}

function send(want: boolean, forced: boolean): void {
  inFlight = true;
  void setSleepInhibit(want)
    .then((active) => {
      confirmed = active;
      const satisfied = active === want;
      // A backend that answers with something other than what was asked for
      // will answer the same way again — hold the value back like a refusal
      // instead of spinning, and let the UI show that it did not take.
      if (!satisfied) {
        refused = want;
      } else if (refused === want) {
        refused = null;
      }
      report(active, satisfied);
      if (forced && satisfied) releasePending = false;
    })
    .catch((error: unknown) => {
      // What the OS is doing is now unknown. Nothing may be skipped as a
      // duplicate on the strength of a failed attempt — least of all a release.
      confirmed = null;
      // A forced release must not be called off by its own failure.
      if (!forced) refused = want;
      useSleepInhibitStore.getState().reportFailure();
      console.warn("[sleep-prevention] failed to update inhibitor", error);
    })
    .finally(() => {
      inFlight = false;
      pump();
    });
}

function pump(): void {
  if (inFlight) return;

  if (releasePending) {
    if (confirmed === false) {
      // Known released; nothing to force.
      releasePending = false;
    } else if (releaseAttemptsLeft > 0) {
      releaseAttemptsLeft -= 1;
      send(false, true);
      return;
    } else {
      releasePending = false;
      // Hold the value back too, or the ordinary path below would immediately
      // add one more attempt on top of the budget just spent.
      refused = false;
      console.warn("[sleep-prevention] gave up releasing the inhibitor");
    }
  }

  const want = desired;
  if (want === null || want === confirmed || want === refused) return;
  send(want, false);
}

/**
 * Ask for a state. Idempotent: a value the backend already confirmed costs
 * nothing.
 */
export function requestSleepInhibit(next: boolean): void {
  // Leaving a refused value un-holds it: the hold-back exists to stop a
  // repeat of the *same* request, and without this a value refused once could
  // never be asked for again.
  if (refused !== null && refused !== next) refused = null;
  desired = next;
  pump();
}

/**
 * Let go, whatever the dedupe would say — the caller is going away.
 *
 * Queued like any other request, so it cannot overtake a call still in flight,
 * and it survives that call failing.
 */
export function releaseSleepInhibit(): void {
  desired = false;
  refused = null;
  releasePending = true;
  releaseAttemptsLeft = RELEASE_ATTEMPTS;
  pump();
}

/** Test-only: forget everything this module knows. */
export function resetSleepInhibitCoordinator(): void {
  desired = null;
  confirmed = null;
  refused = null;
  inFlight = false;
  releasePending = false;
  releaseAttemptsLeft = 0;
}
