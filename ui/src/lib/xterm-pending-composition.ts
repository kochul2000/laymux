/**
 * The one place that reads xterm's pending-composition-send state.
 *
 * Issue #527. `CompositionHelper._finalizeComposition(true)` defers the actual
 * send to a `setTimeout(0)` and marks the window with `_isSendingComposition`.
 * That flag, the captured composition range and the already-sent length are not
 * public API, and there is no public equivalent — `Terminal` exposes nothing
 * about an in-flight composition send.
 *
 * Rather than spread `_core` reads across the view, every field this repository
 * depends on is named here and read defensively in one function. Two
 * consequences that matter:
 *
 * - A version bump that renames or removes a field makes this return `null`, and
 *   the caller's decision then defaults to **delivering** the keypress. The guard
 *   turns itself off instead of silently swallowing input.
 * - `XTERM_PENDING_COMPOSITION_FIELDS` is asserted by a contract test against a
 *   real `Terminal`, so the break is a failing test with a readable name rather
 *   than a behaviour regression nobody notices (issue #527 completion criterion:
 *   "xterm 버전 변경 시 패치 실패를 조용히 무시하지 않는다").
 */

import type { Terminal } from "@xterm/xterm";

import type { PendingCommitState } from "./composition-commit-race";

/** Private fields this module depends on, in read order. Asserted by tests. */
export const XTERM_PENDING_COMPOSITION_FIELDS = [
  "_compositionHelper",
  "_isSendingComposition",
  "_compositionPosition",
  "_dataAlreadySent",
  "_textarea",
] as const;

export type PendingCompositionSend = {
  /** xterm's own `_isSendingComposition`. */
  pending: boolean;
  /** Everything needed to reproduce the finalizer's slice, or null if unreadable. */
  state: PendingCommitState | null;
};

type CompositionHelperLike = {
  _isSendingComposition?: unknown;
  _compositionPosition?: { start?: unknown; end?: unknown };
  _dataAlreadySent?: unknown;
  _textarea?: { value?: unknown };
};

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read the in-flight composition send, or `null` when the shape is not what this
 * module was written against.
 */
export function readPendingCompositionSend(terminal: Terminal): PendingCompositionSend | null {
  const core = (terminal as Terminal & { _core?: Record<string, unknown> })._core;
  if (!core) return null;
  const helper = core["_compositionHelper"] as CompositionHelperLike | undefined;
  if (!helper) return null;

  const pendingFlag = helper._isSendingComposition;
  if (typeof pendingFlag !== "boolean") return null;

  const start = asNumber(helper._compositionPosition?.start);
  const alreadySent = typeof helper._dataAlreadySent === "string" ? helper._dataAlreadySent : null;
  const value = typeof helper._textarea?.value === "string" ? helper._textarea.value : null;
  if (start === null || alreadySent === null || value === null) {
    // The flag is readable but the slice inputs are not — report the flag and let
    // the caller default to delivering.
    return { pending: pendingFlag, state: null };
  }

  return {
    pending: pendingFlag,
    state: {
      textareaValue: value,
      compositionStart: start,
      dataAlreadySentLength: alreadySent.length,
    },
  };
}
