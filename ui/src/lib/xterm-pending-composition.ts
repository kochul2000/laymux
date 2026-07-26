/**
 * The one place that reads xterm's pending-composition-send state.
 *
 * Issue #527. `CompositionHelper._finalizeComposition(true)` defers the actual
 * send to a `setTimeout(0)` and marks the window with `_isSendingComposition`.
 * That flag, the captured composition range and the already-sent length are not
 * public API, and there is no public equivalent — `Terminal` exposes nothing
 * about an in-flight composition send.
 *
 * Two details of the finalizer decide what may and may not be read here:
 *
 * - It closes over `range.start` at `compositionend`, then adds
 *   `_dataAlreadySent.length` **inside the timer**. So `compositionStart` must be
 *   *captured* by the caller at `compositionend` (`readCompositionStart`) while
 *   `dataAlreadySentLength` is read **live** — matching each value's real timing.
 *   Reading `_compositionPosition.start` late is simply wrong:
 *   `compositionstart` overwrites it with `textarea.value.length`.
 * - If `_isComposing` is true again when the timer fires, it sends a **bounded**
 *   slice instead. That upper bound is unknowable at keypress time, so
 *   `composing` is surfaced and the caller must decline to judge.
 *
 * Every field this repository depends on is named in
 * `XTERM_PENDING_COMPOSITION_FIELDS` and read defensively in one place. Two
 * consequences that matter:
 *
 * - A version bump that renames or removes a field makes this return `null`, and
 *   the caller's decision then defaults to **delivering** the keypress. The guard
 *   turns itself off instead of silently swallowing input.
 * - The field list is asserted by a contract test against a real `Terminal`, so
 *   the break is a failing test with a readable name rather than a behaviour
 *   regression nobody notices (issue #527 completion criterion: "xterm 버전
 *   변경 시 패치 실패를 조용히 무시하지 않는다").
  *
 * Policy when a read fails (`null`): **do not act**. Both consumers follow it, even
 * though the visible outcomes look opposite — issue #527's guard suppresses input, so
 * turning it off lets the keypress through; issue #555's blur commit injects text, so
 * turning it off lets the syllable drop. Each reverts to the behaviour from before its
 * own intervention rather than guessing with an unreadable xterm. #527's loss was bad
 * because our guard caused it; #555's loss is xterm's and our injection is the cure.
 * A duplicated syllable can run the wrong shell command, so acting blind is worse.
 */

import type { Terminal } from "@xterm/xterm";

/** Private fields this module depends on, in read order. Asserted by tests. */
export const XTERM_PENDING_COMPOSITION_FIELDS = [
  "_compositionHelper",
  "_isSendingComposition",
  "_isComposing",
  "_compositionPosition",
  "_dataAlreadySent",
  "_textarea",
] as const;

export type PendingCompositionSend = {
  /** xterm's own `_isSendingComposition` — a deferred send is in flight. */
  pending: boolean;
  /**
   * xterm's own `_isComposing`. When a **new** composition has already started,
   * the finalizer takes its other branch and sends a bounded slice whose upper
   * bound cannot be known at keypress time. The caller must not judge then.
   */
  composing: boolean;
  /** Live values, to be combined with a `compositionStart` captured earlier. */
  live: { textareaValue: string; dataAlreadySentLength: number } | null;
};

type CompositionHelperLike = {
  _isSendingComposition?: unknown;
  _isComposing?: unknown;
  _compositionPosition?: { start?: unknown; end?: unknown };
  _dataAlreadySent?: unknown;
  _textarea?: { value?: unknown };
};

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

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
  const composingFlag = helper._isComposing;
  if (typeof pendingFlag !== "boolean" || typeof composingFlag !== "boolean") return null;

  const alreadySent = typeof helper._dataAlreadySent === "string" ? helper._dataAlreadySent : null;
  const value = typeof helper._textarea?.value === "string" ? helper._textarea.value : null;
  if (alreadySent === null || value === null) {
    // The flags are readable but the slice inputs are not — report the flags and
    // let the caller default to delivering.
    return { pending: pendingFlag, composing: composingFlag, live: null };
  }

  return {
    pending: pendingFlag,
    composing: composingFlag,
    live: { textareaValue: value, dataAlreadySentLength: alreadySent.length },
  };
}

/**
 * `_compositionPosition.start` at this moment, for the caller to snapshot on
 * `compositionend` — the same moment the finalizer closes over it.
 */
export function readCompositionStart(terminal: Terminal): number | null {
  const helper = readHelper(terminal);
  if (!helper) return null;
  return asNumber(helper._compositionPosition?.start);
}
