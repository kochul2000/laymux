/**
 * The one place that turns xterm's own cursor off at the **renderer** level
 * (issue #598).
 *
 * Why not the options we used before: `hideNativeCursor` used to paint the
 * cursor in the theme background colour and force `cursorStyle = "bar"` +
 * `cursorWidth = 1`. Both premises belong to the application, not to us.
 *
 * - **Colour.** "cursor coloured like the theme background is invisible" only
 *   holds while the cell under the cursor still has the theme background. A TUI
 *   that paints its own background with SGR 48 breaks it: Codex draws its input
 *   box row in `rgb(41,41,41)`, so a `#0C0C0C` cursor stops disappearing and
 *   becomes a dark hole. A light scheme inverts the same failure.
 * - **Shape.** `options.cursorStyle` is not authoritative. Both renderers read
 *   `coreService.decPrivateModes.cursorStyle ?? options.cursorStyle`, and
 *   DECSCUSR (`CSI Ps SP q`) writes that DEC mode — so an app that emits
 *   DECSCUSR every frame owns the shape outright. When the resolved shape is
 *   `block`, the renderer fills the whole cell with the cursor colour and draws
 *   the glyph in `cursorAccent`; with both set to the background colour that is
 *   a solid background-coloured cell, which is exactly the artifact #598
 *   measured. `terminal.refresh()` cannot win that race — the next frame paints
 *   it again.
 *
 * The renderer instead gates the cursor entirely on `coreService.isCursorHidden`
 * (`isCursorInitialized && !isCursorHidden && …` in the WebGL addon's model
 * build, and the same field in the DOM renderer's row factory). Nothing an
 * application can send with SGR or DECSCUSR reaches that gate, so suppressing
 * there ends the competition instead of joining it. It also covers the unfocused
 * path, which `cursorInactiveStyle` would have to be kept in sync with.
 *
 * The field is not public API and DECTCEM (`CSI ?25h/l`) writes the very same
 * one, which the shadow cursor treats as the application's authoritative
 * "visible cursor is here" signal (ADR-0011). So this module must not clobber
 * it: it replaces the field with an accessor that **records** every application
 * write and **reports** hidden while laymux is suppressing. The app's own value
 * survives, is readable as `appCursorHidden`, and is restored verbatim on
 * `dispose()`.
 *
 * Failure policy, matching `xterm-pending-composition.ts`: when the shape is not
 * what this module was written against it returns `supported: false` and does
 * nothing. The native cursor then stays visible per the user's cursor settings —
 * a doubled caret, which is honest and reversible — instead of reviving the
 * background-colour disguise that produced #598. `XTERM_NATIVE_CURSOR_FIELDS` is
 * asserted by a contract test against a real `Terminal`, so an xterm bump breaks
 * loudly with a readable name rather than silently.
 */

import type { Terminal } from "@xterm/xterm";

/**
 * Private fields this module depends on, in read order — the last one is the
 * gate itself, the ones before it are the path to its owner. This is not
 * documentation: the resolver below walks exactly this list, and a contract test
 * walks it against a real `Terminal`, so an xterm bump that moves the field
 * fails with this name in the message instead of silently.
 */
export const XTERM_NATIVE_CURSOR_FIELDS = ["_core", "coreService", "isCursorHidden"] as const;

/** The object that owns the cursor gate, plus the gate's field name. */
export type NativeCursorGate = { owner: Record<string, unknown>; field: string };

/**
 * Walk `XTERM_NATIVE_CURSOR_FIELDS` to the object that owns the gate. Returns
 * `null` unless every hop is an object and the leaf is a boolean — the single
 * shape check both the installer and the tests use.
 */
export function resolveNativeCursorGate(terminal: Terminal): NativeCursorGate | null {
  const path = XTERM_NATIVE_CURSOR_FIELDS.slice(0, -1);
  const field = XTERM_NATIVE_CURSOR_FIELDS[XTERM_NATIVE_CURSOR_FIELDS.length - 1];
  let owner: unknown = terminal;
  for (const hop of path) {
    if (owner === null || typeof owner !== "object") return null;
    owner = (owner as Record<string, unknown>)[hop];
  }
  if (owner === null || typeof owner !== "object") return null;
  if (typeof (owner as Record<string, unknown>)[field] !== "boolean") return null;
  return { owner: owner as Record<string, unknown>, field };
}

export type NativeCursorSuppression = {
  /** Whether the renderer-level gate was actually installed. */
  readonly supported: boolean;
  /**
   * DECTCEM state the application itself set. Unaffected by suppression, so the
   * app keeps its authority over "is the cursor visible" (ADR-0011).
   */
  readonly appCursorHidden: boolean;
  /** Whether laymux is currently forcing the cursor off. */
  readonly suppressed: boolean;
  /** Force the native cursor off (`true`) or hand the field back to the app. */
  setSuppressed(suppressed: boolean): void;
  /** Restore the plain field with the application's own value. */
  dispose(): void;
};

const UNSUPPORTED: NativeCursorSuppression = {
  supported: false,
  appCursorHidden: false,
  suppressed: false,
  setSuppressed: () => {},
  dispose: () => {},
};

/**
 * Install the renderer-level cursor gate on `terminal`, or return an inert
 * `supported: false` handle when xterm's internals are not the expected shape.
 */
export function installNativeCursorSuppression(terminal: Terminal): NativeCursorSuppression {
  const gate = resolveNativeCursorGate(terminal);
  if (!gate) return UNSUPPORTED;
  const { owner: coreService, field } = gate;

  let appCursorHidden: boolean = coreService[field] === true;
  let suppressed = false;
  let disposed = false;

  try {
    Object.defineProperty(coreService, field, {
      configurable: true,
      enumerable: true,
      get: () => suppressed || appCursorHidden,
      // DECTCEM and softReset both assign here. Record, never reject: the app
      // stays the owner of its own visibility state.
      set: (value: unknown) => {
        appCursorHidden = value === true;
      },
    });
  } catch {
    return UNSUPPORTED;
  }

  return {
    get supported() {
      return !disposed;
    },
    get appCursorHidden() {
      return appCursorHidden;
    },
    get suppressed() {
      return suppressed;
    },
    setSuppressed(next: boolean) {
      if (disposed) return;
      suppressed = next;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      suppressed = false;
      try {
        Object.defineProperty(coreService, field, {
          configurable: true,
          enumerable: true,
          writable: true,
          value: appCursorHidden,
        });
      } catch {
        /* the terminal is being torn down; a stale accessor cannot outlive it */
      }
    },
  };
}
