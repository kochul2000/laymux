/**
 * OS input-source switch chord vs. terminal PTY input.
 *
 * Issue #533. A user may bind an OS input-source switch (Windows/Linux "change
 * keyboard layout") to a chord the terminal also owns as text — Shift+Space and
 * Ctrl+Space are the common ones. Skipping only `keydown` is not enough: the
 * same physical press also produces a companion `keypress`, a non-composition
 * text insertion into the xterm helper textarea, and a `keyup`, and xterm feeds
 * PTY bytes from those paths too (`_keyPress` triggers a data event, and its
 * textarea `input` listener fires once `_keyDownSeen` has been cleared by
 * `_keyUp`). The result is a literal Space or digit leaking into the shell every
 * time the user switches input source.
 *
 * Design constraints this module encodes:
 * - **No hardcoded combo.** The chord comes from the keybinding registry, and the
 *   action ships unassigned. With nothing bound, every method returns `false` and
 *   terminal input is byte-for-byte unchanged.
 * - **No `preventDefault()` on the key events.** The OS decides the input-source
 *   switch from the key press itself; suppressing the default would break the
 *   very feature the user bound. We only stop the events from reaching xterm.
 *   (Text insertion is different — see `shouldBlockTextInput`.)
 * - **Physical-key scoped.** Arming is keyed on the physical key (`event.code`,
 *   falling back to `event.key`) so only events from the *same* press are
 *   swallowed. A different key **keydown** releases the guard rather than being
 *   swallowed with it; a different key **keyup** — the modifier's own release,
 *   which the DOM always emits — is neither blocked nor a release signal.
 * - **Modifier state may change mid-press.** Releasing Shift while Space is held
 *   produces Space keydowns that no longer match the chord. Identity, not the
 *   chord match, is what keeps the press together.
 * - **Composition is never touched**, and only the character the armed press
 *   itself would insert is cancelled — an IME commit that happens to overlap the
 *   press keeps its text.
 */

export type OsInputSourceChordKeyEvent = {
  type: "keydown" | "keypress" | "keyup";
  /** Physical key identity. Empty for synthetic events; then `key` identifies it. */
  code: string;
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  repeat?: boolean;
};

export type OsInputSourceChordTrace = (event: string, payload: Record<string, unknown>) => void;

export type OsInputSourceChordGuardOptions = {
  /**
   * True when the event matches the user-bound chord. Resolved from the
   * keybinding registry by the caller, so this module holds no key constants.
   * Must return `false` when the action is unassigned.
   */
  matchesChord: (event: OsInputSourceChordKeyEvent) => boolean;
  onTrace?: OsInputSourceChordTrace;
};

export type OsInputSourceChordGuard = {
  /** True when this key event must not reach xterm. Arms on a matching keydown. */
  shouldBlockKey: (event: OsInputSourceChordKeyEvent) => boolean;
  /**
   * True when a non-composition text insertion must not reach the helper
   * textarea. Unlike the key events this one *is* cancelled with
   * `preventDefault()` by the caller: the OS has already acted on the key press,
   * and letting the character land in the textarea is exactly the leak.
   */
  shouldBlockTextInput: (event: {
    isComposing: boolean;
    /** The text about to be inserted. Only the armed press own character is a leak. */
    data?: string | null;
    /** `InputEvent.inputType`. Anything other than a plain insertion is not ours. */
    inputType?: string;
  }) => boolean;
  /** True while a chord press is in flight. */
  isArmed: () => boolean;
  /** Drop any in-flight press (blur, unmount, pane handoff). */
  reset: (reason: string) => void;
};

/**
 * Identity used to tie companion events to the press that armed the guard.
 *
 * Both `code` and `key` are kept: an environment that fills `code` on `keydown`
 * but leaves it empty on `keypress` would otherwise split one press into two
 * identities and let the companion through. Either half matching is enough.
 */
type PressIdentity = { code: string; key: string };

function pressIdentity(event: OsInputSourceChordKeyEvent): PressIdentity {
  return { code: event.code, key: event.key };
}

function isSamePress(armed: PressIdentity | null, event: PressIdentity): boolean {
  if (!armed) return false;
  if (armed.code && event.code) return armed.code === event.code;
  return armed.key === event.key;
}

function describePress(identity: PressIdentity): string {
  return identity.code || `key:${identity.key}`;
}

export function createOsInputSourceChordGuard(
  options: OsInputSourceChordGuardOptions,
): OsInputSourceChordGuard {
  const trace: OsInputSourceChordTrace = (event, payload) => options.onTrace?.(event, payload);

  /** Identity of the physical key whose events are being swallowed, if any. */
  let armedPress: PressIdentity | null = null;
  /** `event.key` of the armed press — the only character it can insert. */
  let armedKey: string | null = null;

  const release = (reason: string) => {
    if (armedPress === null) return;
    armedPress = null;
    armedKey = null;
    trace("os-input-source-chord-released", { reason });
  };

  return {
    shouldBlockKey(event) {
      const identity = pressIdentity(event);

      if (event.type === "keydown") {
        if (options.matchesChord(event)) {
          if (!isSamePress(armedPress, identity)) {
            // Ownership moving to a different physical key still ends the old
            // press — trace it so a round trip is never silent.
            release("rearmed");
            armedPress = identity;
            armedKey = event.key;
            trace("os-input-source-chord-armed", { press: describePress(identity) });
          }
          return true;
        }
        // The *same* physical key with a changed modifier state is the press we
        // are already holding: releasing Shift while Space is down produces
        // repeating Space keydowns without `shiftKey`, and they no longer match
        // the chord. Disarming there would let the rest of the press through.
        if (isSamePress(armedPress, identity)) return true;
        // A genuinely different key means the chord press is over as far as we
        // can tell. Give up ownership instead of swallowing unrelated input.
        release("other-key");
        return false;
      }

      if (!isSamePress(armedPress, identity)) {
        // A companion of some other key — most often the modifier's own keyup,
        // which the DOM always emits. It is not ours to block, and crucially it
        // is **not** a release signal either: the chord key is still down.
        return false;
      }

      // Companion event of the armed press. The modifier state may already have
      // dropped (Shift released before Space), so identity — not the chord match
      // — is what keeps these together.
      if (event.type === "keyup") {
        release("keyup");
        return true;
      }
      return true;
    },

    shouldBlockTextInput(event) {
      if (armedPress === null) return false;
      // A composing insertion is the IME's, not the chord's.
      if (event.isComposing) return false;
      // The armed window stays open for as long as the chord key is held, so it
      // can overlap insertions that have nothing to do with the chord. The one
      // that matters is a Korean IME committing the syllable that was in flight
      // when the user hit the toggle: cancelling that would delete the user's
      // text. Only the character this press would itself produce is a leak.
      if (event.inputType !== undefined && event.inputType !== "insertText") return false;
      if (armedKey === null || event.data !== armedKey) return false;
      return true;
    },

    isArmed() {
      return armedPress !== null;
    },

    reset(reason) {
      release(reason);
    },
  };
}
