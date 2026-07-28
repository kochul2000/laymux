import { isCompositionSideInput, isCompositionSideKey } from "./ime-composition-events";

/**
 * Linux IME candidate-selection key guard.
 *
 * Issue #528. Sogou/fcitx-family IMEs on Linux emit the key that *selected* a
 * candidate as ordinary key events around `compositionend` — either a full
 * `keydown → keypress → keyup` for Space/a digit, or an orphan `keyup` with no
 * preceding `keydown`. xterm's own composition guard is already finished by
 * then (`_isComposing` is false once `compositionend` has run), so those events
 * take the normal path and a literal Space or digit lands in the PTY every time
 * the user picks a candidate.
 *
 * ADR-0053 deliberately deferred "post-composition suppression" to a PR that
 * adds the event-sequence tests first, because the naive version — discard the
 * first printable key after every composition — throws away the character a
 * user genuinely typed next. This module is that PR, and it avoids the naive
 * rule by never using "first key after composition" as the discriminator.
 *
 * ## What separates a leftover from a real key press
 *
 * Two signals, each independently sufficient, both bounded by a short
 * post-composition window:
 *
 * 1. **IME-consumed marker.** A key the IME processed is reported with
 *    `keyCode === 229` (or `key === "Process"`). A key the user actually pressed
 *    reports its own code (Space = 32, digits = 48–57). This is the same marker
 *    xterm's composition path keys off, so it is not a laymux-specific guess.
 * 2. **Orphan companion.** A `keypress`/`keyup` for a physical key whose
 *    `keydown` was never observed in this window cannot belong to a press that
 *    started here — it is the tail of the press the IME consumed.
 *
 * Anything else — a complete `keydown(keyCode 32) → keypress → keyup` — is a
 * real press and passes through untouched. That is what keeps "the Space the
 * user typed right after confirming a candidate is not lost" true.
 *
 * The window is a **safety bound, not the discriminator**: it closes on the
 * first real non-composition text input, on a real candidate keydown, on
 * blur/unmount, and on a timeout. No behaviour depends on guessing how many
 * milliseconds an IME takes.
 *
 * Platform gating is the caller's job (`enabled`), so this file holds no
 * `navigator` access and stays a pure state machine.
 */

export type LinuxImeCandidateKeyEvent = {
  type: "keydown" | "keypress" | "keyup";
  /** Physical key identity. Empty for synthetic events; then `key` identifies it. */
  code: string;
  key: string;
  /** 229 (or `key === "Process"`) means the IME consumed this key. */
  keyCode?: number;
  repeat?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  metaKey?: boolean;
};

export type LinuxImeCandidateDecision = {
  /** True when the event must not reach xterm (no PTY bytes). */
  block: boolean;
  /**
   * True when the caller must also call `preventDefault()`.
   *
   * Only set for events that would otherwise mutate the helper textarea: a
   * blocked candidate `keydown`, and a blocked *orphan* `keypress` (an orphan
   * has no keydown left to cancel, so its own default is the only place the
   * insertion can be stopped). Never set for `keyup`.
   */
  preventDefault: boolean;
  /** Why the decision was made — surfaced through the trace channel. */
  reason: string;
};

export type LinuxImeCandidateTrace = (event: string, payload: Record<string, unknown>) => void;

export type LinuxImeCandidateGuardOptions = {
  /**
   * Linux-only. When false every method is a no-op and returns "don't block",
   * so Windows/macOS input is byte-for-byte unchanged.
   */
  enabled: boolean;
  /** Monotonic clock in ms. Injected so tests never depend on wall time. */
  now: () => number;
  /**
   * Outer bound on the post-composition window. A safety net only — the window
   * normally closes earlier on a real key or a real text insertion.
   */
  windowMs?: number;
  onTrace?: LinuxImeCandidateTrace;
};

export type LinuxImeCandidateGuard = {
  noteCompositionStart: () => void;
  /**
   * A `compositionupdate` of any shape — including an **empty** `data`, which
   * several IMEs emit when clearing the preedit. It is not an end marker, so the
   * payload is deliberately not inspected: treating an empty update as the end
   * would open the window while the user is still composing.
   */
  noteCompositionUpdate: () => void;
  noteCompositionEnd: () => void;
  /**
   * An input-like event on the helper textarea. Only a **real** insertion closes
   * the window; the composition commit itself must not, and that commit can
   * arrive after `compositionend` reporting `isComposing === false` — which is
   * why `inputType` has to come along.
   */
  noteTextInput: (event: { isComposing: boolean; inputType?: string }) => void;
  decideKey: (event: LinuxImeCandidateKeyEvent) => LinuxImeCandidateDecision;
  isWindowOpen: () => boolean;
  reset: (reason: string) => void;
};

/** Default outer bound. Deliberately short: it must not span a human keystroke. */
export const DEFAULT_CANDIDATE_WINDOW_MS = 120;

const DIGIT_CODE = /^(Digit|Numpad)[0-9]$/;

const PASS: LinuxImeCandidateDecision = { block: false, preventDefault: false, reason: "pass" };

/** Space and digits are the only keys an IME uses to pick a candidate. */
export function isCandidateKey(event: LinuxImeCandidateKeyEvent): boolean {
  // A modified combo is a shortcut, never a candidate selection.
  if (event.ctrlKey || event.altKey || event.metaKey) return false;
  if (event.code) return event.code === "Space" || DIGIT_CODE.test(event.code);
  return event.key === " " || /^[0-9]$/.test(event.key);
}

/** True when the platform reports that the IME already consumed this key. */
export function isImeConsumedKey(event: LinuxImeCandidateKeyEvent): boolean {
  return isCompositionSideKey(event);
}

function pressIdentity(event: LinuxImeCandidateKeyEvent): string {
  return event.code || `key:${event.key}`;
}

export function createLinuxImeCandidateGuard(
  options: LinuxImeCandidateGuardOptions,
): LinuxImeCandidateGuard {
  const trace: LinuxImeCandidateTrace = (event, payload) => options.onTrace?.(event, payload);
  const windowMs = options.windowMs ?? DEFAULT_CANDIDATE_WINDOW_MS;

  let composing = false;
  /** Absolute deadline of the post-composition window, or null when closed. */
  let windowClosesAt: number | null = null;
  /** Physical keys whose keydown was observed since the window opened. */
  const observedKeyDowns = new Set<string>();

  const closeWindow = (reason: string) => {
    if (windowClosesAt === null) return;
    windowClosesAt = null;
    observedKeyDowns.clear();
    trace("linux-ime-candidate-window-closed", { reason });
  };

  /** Window state with the timeout applied. */
  const windowOpen = (): boolean => {
    if (windowClosesAt === null) return false;
    if (options.now() > windowClosesAt) {
      closeWindow("timeout");
      return false;
    }
    return true;
  };

  return {
    noteCompositionStart() {
      if (!options.enabled) return;
      composing = true;
      // Observed keydowns are cleared here, not at `compositionend`. What that
      // preserves is a press that started **during** the composition (recorded
      // by the `composing` branch of `decideKey`): its keyup arrives after the
      // end, and clearing at `compositionend` would misread that legitimate
      // release as the IME's orphan tail. A press from before the composition
      // is never recorded at all — `decideKey` returns early outside a window.
      observedKeyDowns.clear();
      // A new composition supersedes any pending window from the previous one.
      closeWindow("composition-restart");
    },

    noteCompositionUpdate() {
      if (!options.enabled) return;
      // No payload inspection on purpose — see the type. Any update, empty or
      // not, means the composition is still running.
      composing = true;
    },

    noteCompositionEnd() {
      if (!options.enabled) return;
      composing = false;
      windowClosesAt = options.now() + windowMs;
      trace("linux-ime-candidate-window-opened", { closesAt: windowClosesAt });
    },

    noteTextInput(event) {
      if (!options.enabled) return;
      // The commit that lands the confirmed text in the textarea belongs to the
      // composition, not to the user typing something new — and Chromium can
      // deliver it *after* `compositionend`, where `isComposing` is already
      // false. Closing the window there would make this guard a no-op for
      // exactly the platforms it targets. The judgement is shared with
      // `ime-composition-controller.ts` so the two cannot drift.
      if (isCompositionSideInput(event)) return;
      // Real typed text means the IME is done with this press; anything still
      // arriving belongs to the user.
      closeWindow("real-text-input");
    },

    decideKey(event) {
      if (!options.enabled) return PASS;

      const candidate = isCandidateKey(event);
      const imeConsumed = isImeConsumedKey(event);
      const identity = pressIdentity(event);

      // While composing, xterm's own CompositionHelper owns the key. Recording
      // the keydown here keeps a press that *starts* during composition from
      // looking like an orphan once the composition ends.
      if (composing) {
        if (event.type === "keydown" && !imeConsumed) observedKeyDowns.add(identity);
        return PASS;
      }

      if (!windowOpen()) return PASS;

      if (!candidate) {
        // Any other real key means the user moved on.
        if (event.type === "keydown" && !imeConsumed) closeWindow("other-key");
        return PASS;
      }

      // Signal 1: the platform says the IME consumed this key.
      if (imeConsumed) {
        const decision: LinuxImeCandidateDecision = {
          block: true,
          preventDefault: event.type !== "keyup",
          reason: "ime-consumed",
        };
        trace("linux-ime-candidate-blocked", { ...decision, type: event.type, identity });
        return decision;
      }

      if (event.type === "keydown") {
        // A real candidate keydown inside the window is the user pressing Space
        // or a digit right after confirming. It must reach the terminal, and
        // closing the window is what lets its own keypress/keyup through: they
        // return early at `!windowOpen()` instead of being judged as orphans.
        closeWindow("real-candidate-keydown");
        return PASS;
      }

      // Signal 2: orphan companion — no keydown for this physical key in this
      // window, so it cannot belong to a press that started here.
      if (!observedKeyDowns.has(identity)) {
        const decision: LinuxImeCandidateDecision = {
          block: true,
          preventDefault: event.type === "keypress",
          reason: "orphan-companion",
        };
        trace("linux-ime-candidate-blocked", { ...decision, type: event.type, identity });
        if (event.type === "keyup") closeWindow("orphan-keyup");
        return decision;
      }

      return PASS;
    },

    isWindowOpen() {
      return windowOpen();
    },

    reset(reason) {
      composing = false;
      closeWindow(reason);
    },
  };
}
