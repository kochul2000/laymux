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
 * - **Physical-key scoped.** Arming is keyed on `event.code` so only events from
 *   the *same* physical press are swallowed. Any other key releases the guard
 *   rather than being swallowed with it.
 * - **Composition is never touched.** A composing insertion belongs to the IME.
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
  shouldBlockTextInput: (event: { isComposing: boolean }) => boolean;
  /** True while a chord press is in flight. */
  isArmed: () => boolean;
  /** Drop any in-flight press (blur, unmount, pane handoff). */
  reset: (reason: string) => void;
};

/** Identity used to tie companion events to the press that armed the guard. */
function pressIdentity(event: OsInputSourceChordKeyEvent): string {
  return event.code || `key:${event.key}`;
}

export function createOsInputSourceChordGuard(
  options: OsInputSourceChordGuardOptions,
): OsInputSourceChordGuard {
  const trace: OsInputSourceChordTrace = (event, payload) => options.onTrace?.(event, payload);

  /** Identity of the physical key whose events are being swallowed, if any. */
  let armedPress: string | null = null;

  const release = (reason: string) => {
    if (armedPress === null) return;
    armedPress = null;
    trace("os-input-source-chord-released", { reason });
  };

  return {
    shouldBlockKey(event) {
      const identity = pressIdentity(event);

      if (event.type === "keydown") {
        if (options.matchesChord(event)) {
          if (armedPress !== identity) {
            armedPress = identity;
            trace("os-input-source-chord-armed", { press: identity });
          }
          return true;
        }
        // A different key during an armed press means we lost track of the
        // release. Give up ownership instead of swallowing unrelated input.
        release(identity === armedPress ? "keydown-no-longer-matching" : "other-key");
        return false;
      }

      if (armedPress === null || armedPress !== identity) {
        // Orphan keypress/keyup, or one from another key — never ours to block.
        if (armedPress !== null && event.type === "keyup") release("other-key-up");
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
