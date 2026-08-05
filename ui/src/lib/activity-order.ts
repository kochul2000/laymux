/**
 * Ordering for the two backend producers of pane activity (ADR-0135).
 *
 * The PTY callback resolves activity per OSC title; the reconcile worker
 * re-derives every pane on a timer. They share no lock, and emission order is
 * not derivation order — a reconcile pass snapshots state, walks every terminal,
 * then emits, so a title resolved during that walk is newer yet arrives first
 * and gets overwritten by the pass's older verdict. The pane then shows the
 * stale value until the next pass.
 *
 * Both producers therefore stamp the activity with a counter read at derivation
 * time, and the store keeps the stamp it applied. Anything older is ignored.
 */

/**
 * Whether an incoming activity verdict is older than what the pane already
 * shows.
 *
 * Unstamped input is never stale: the mount-time `get_terminal_states` pull has
 * no stamp to give, and refusing it would leave the pane blank rather than
 * merely one pass behind.
 */
export function isStaleActivity(
  applied: number | undefined,
  incoming: number | undefined,
): boolean {
  if (incoming === undefined || applied === undefined) return false;
  // Equal means the same derivation delivered twice; there is nothing new to
  // apply either way.
  return incoming <= applied;
}
