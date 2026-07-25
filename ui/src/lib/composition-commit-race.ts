/**
 * Composition commit vs. pending `keypress` — duplicate/loss decision.
 *
 * Issue #527. xterm's `CompositionHelper._finalizeComposition(true)` does not
 * send the committed text inline. It captures the composition range, sets
 * `_isSendingComposition = true`, and defers the actual read to a
 * `setTimeout(0)`:
 *
 * ```js
 * this._isSendingComposition = true;
 * setTimeout(() => {
 *   if (this._isSendingComposition) {
 *     this._isSendingComposition = false;
 *     range.start += this._dataAlreadySent.length;
 *     const text = this._textarea.value.substring(range.start);
 *     if (text.length > 0) this._coreService.triggerDataEvent(text, true);
 *   }
 * }, 0);
 * ```
 *
 * `_keyPress` has no idea that window is open — it triggers its own data event
 * for whatever character it carries. So a `keypress` that lands between
 * `compositionend` and that timeout sends the committed syllable a **second**
 * time. Reproduced against the real xterm code path (see
 * `composition-commit-race.test.ts`): one committed `가` yields `["가", "가"]`
 * with a racing keypress and `["가"]` without.
 *
 * This module owns only the **decision**: given the text the pending commit is
 * about to send and the character a `keypress` would send, is the keypress a
 * duplicate of that commit? Reading xterm's state and acting on the answer is
 * the caller's job, which keeps the judgement testable in isolation and keeps
 * the private-field access in exactly one place.
 *
 * The decision is deliberately **conservative in the direction of delivery**: it
 * only reports "duplicate" when the pending commit demonstrably already carries
 * the character. Anything ambiguous is delivered, because a character the user
 * typed during the pending window must not be swallowed.
 */

export type PendingCommitState = {
  /** `textarea.value` at the moment the keypress arrives. */
  textareaValue: string;
  /** `_compositionPosition.start` captured by the finalizer. */
  compositionStart: number;
  /** `_dataAlreadySent.length` the finalizer will add to `start`. */
  dataAlreadySentLength: number;
};

/**
 * The text xterm's deferred finalizer will send, computed the same way it does.
 *
 * Mirroring the slice exactly is the point: a different derivation would make
 * the duplicate test compare against text that never gets sent.
 */
export function resolvePendingCommitText(state: PendingCommitState): string {
  const start = state.compositionStart + state.dataAlreadySentLength;
  if (!Number.isFinite(start) || start < 0) return "";
  return state.textareaValue.slice(start);
}

/**
 * True when a `keypress` would re-send text the pending commit already carries.
 *
 * Three shapes count, all of which the upstream reports describe:
 * - **identical** — the keypress carries exactly the committed text (the common
 *   single-syllable case).
 * - **contained** — the committed text contains the keypress character, which is
 *   what happens when several syllables commit at once and the IME still emits a
 *   keypress for the last one.
 * - **boundary overlap** — the committed text ends with the keypress character.
 *   Called out separately because it is the case a naive `===` check misses.
 *
 * Everything else is delivered. In particular an empty pending commit never
 * suppresses anything: with nothing to duplicate, suppressing would be pure loss.
 */
export function isDuplicateOfPendingCommit(
  pendingCommitText: string,
  keypressText: string,
): boolean {
  if (!pendingCommitText || !keypressText) return false;
  if (pendingCommitText === keypressText) return true;
  return pendingCommitText.includes(keypressText);
}

/** The character a `keypress` event would send, or `""` when it sends nothing. */
export function keypressText(event: { key?: string; charCode?: number }): string {
  // `key` is the reliable source in every browser laymux targets; `charCode` is
  // the legacy fallback and only meaningful when it is a real code point.
  if (event.key && event.key.length > 0 && event.key !== "Unidentified") {
    // Named keys ("Enter", "Backspace", …) are not text.
    return event.key.length === 1 || Array.from(event.key).length === 1 ? event.key : "";
  }
  if (typeof event.charCode === "number" && event.charCode > 0) {
    return String.fromCodePoint(event.charCode);
  }
  return "";
}

export type CommitRaceDecision = {
  /** True when the keypress must not reach xterm's data path. */
  suppress: boolean;
  reason: string;
};

const DELIVER = (reason: string): CommitRaceDecision => ({ suppress: false, reason });

/**
 * Whole decision for one `keypress` while a composition commit may be pending.
 *
 * `pending` is xterm's own `_isSendingComposition`. When it is false there is no
 * race and nothing is suppressed — this guard never affects ordinary typing.
 */
export function decideCommitRace(input: {
  pending: boolean;
  state: PendingCommitState | null;
  keypress: { key?: string; charCode?: number };
}): CommitRaceDecision {
  if (!input.pending) return DELIVER("no-pending-commit");
  if (!input.state) return DELIVER("pending-state-unavailable");

  const text = keypressText(input.keypress);
  if (!text) return DELIVER("keypress-sends-no-text");

  const commitText = resolvePendingCommitText(input.state);
  if (!isDuplicateOfPendingCommit(commitText, text)) {
    // A character the user typed during the pending window. Delivering it is the
    // only safe choice — the commit will still send its own text.
    return DELIVER("not-in-pending-commit");
  }
  return { suppress: true, reason: "duplicate-of-pending-commit" };
}
