/**
 * The one place outside xterm that reads its pending-composition-send flag.
 *
 * Issue #527. `CompositionHelper._finalizeComposition(true)` defers the actual
 * send to a `setTimeout(0)` and marks the window with `_isSendingComposition`.
 * That flag, the captured composition range and the already-sent length are not
 * public API, and there is no public equivalent — `Terminal` exposes nothing
 * about an in-flight composition send.
 *
 * The duplicate-keypress decision used to live in TerminalView and required
 * five additional private fields plus a compositionend-time start snapshot.
 * Issue #660 moves that responsibility into the patched CompositionHelper, the
 * owner of the pending finalizer. This adapter remains only for issue #555's
 * blur recovery: when xterm already has a deferred send in flight, laymux must
 * not inject the same preview text from its blur fallback.
 *
 * Every field this adapter depends on is named in
 * `XTERM_PENDING_COMPOSITION_FIELDS` and read defensively in one place:
 *
 * - A version bump that renames or removes a field makes this return `null`.
 * - The field list is asserted by a contract test against a real `Terminal`, so
 *   the break is a failing test with a readable name rather than a behaviour
 *   regression nobody notices (issue #527 completion criterion: "xterm 버전
 *   변경 시 패치 실패를 조용히 무시하지 않는다").
 *
 * Policy when a read fails (`null`): issue #555's blur fallback treats it as
 * "not pending" and does not guess at xterm internals. The installed-bundle
 * contract test makes that dependency break visible before shipping.
 */

import type { Terminal } from "@xterm/xterm";

/** Private fields this module depends on, in read order. Asserted by tests. */
export const XTERM_PENDING_COMPOSITION_FIELDS = [
  "_compositionHelper",
  "_isSendingComposition",
] as const;

export type PendingCompositionSend = {
  /** xterm's own `_isSendingComposition` — a deferred send is in flight. */
  pending: boolean;
};

type CompositionHelperLike = {
  _isSendingComposition?: unknown;
};

function readHelper(terminal: Terminal): CompositionHelperLike | null {
  const core = (terminal as Terminal & { _core?: Record<string, unknown> })._core;
  if (!core) return null;
  return (core["_compositionHelper"] as CompositionHelperLike | undefined) ?? null;
}

/**
 * Read the in-flight composition send, or `null` when the shape is not what this
 * module was written against.
 */
export function readPendingCompositionSend(terminal: Terminal): PendingCompositionSend | null {
  const helper = readHelper(terminal);
  if (!helper) return null;

  const pendingFlag = helper._isSendingComposition;
  return typeof pendingFlag === "boolean" ? { pending: pendingFlag } : null;
}
