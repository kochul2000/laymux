/**
 * Encodes a browser KeyboardEvent into the byte sequence a PTY expects, so the
 * detached Composer can pass non-text keys (arrows, Esc, Tab, Enter, …) straight
 * to the terminal when its draft is empty, and pass everything through while a
 * full-screen (alternate-screen) app is running.
 *
 * Arrow/Home/End honor the terminal's DECCKM (application cursor keys) mode — the
 * caller reads it from xterm (`terminal.modes.applicationCursorKeysMode`) so we
 * defer to xterm's own state instead of guessing.
 */

export interface EncodeTerminalKeyOptions {
  /** xterm `terminal.modes.applicationCursorKeysMode` — flips CSI (`\x1b[`) to SS3 (`\x1bO`). */
  applicationCursor?: boolean;
}

/** Keys that carry no character and are safe to forward at an empty prompt. */
const PASSTHROUGH_NAV_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Escape",
  "Tab",
  "Enter",
]);

const MODIFIER_ONLY_KEYS = new Set([
  "Shift",
  "Control",
  "Alt",
  "Meta",
  "CapsLock",
  "NumLock",
  "ScrollLock",
  "Dead",
  "Unidentified",
]);

/**
 * True for non-character navigation/control keys the empty Composer forwards to
 * the terminal (so shell history / inline menus work). Printable characters are
 * excluded — those keep editing the draft.
 */
export function isPassthroughNavKey(event: Pick<KeyboardEvent, "key">): boolean {
  return PASSTHROUGH_NAV_KEYS.has(event.key);
}

/**
 * Control chords an empty Composer forwards so a running activity stays
 * controllable: Ctrl+C (SIGINT), Ctrl+D (EOF), Ctrl+Z (SIGTSTP), Ctrl+L
 * (repaint). Deliberately NOT every Ctrl+letter — e.g. Ctrl+V must keep
 * pasting into the draft. Callers must check laymux keybindings first
 * (`matchesGlobalShortcut`), so a user who rebinds one of these to a laymux
 * action keeps the laymux behavior.
 */
const PASSTHROUGH_CTRL_KEYS = new Set(["c", "d", "z", "l"]);

export function isPassthroughControlChord(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">,
): boolean {
  return (
    event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    !event.shiftKey &&
    PASSTHROUGH_CTRL_KEYS.has(event.key.toLowerCase())
  );
}

/** Returns the PTY byte sequence for the event, or null when it should not be forwarded. */
export function encodeTerminalKey(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">,
  options: EncodeTerminalKeyOptions = {},
): string | null {
  const { key } = event;
  if (MODIFIER_ONLY_KEYS.has(key)) return null;

  // xterm modifier parameter: 1 + Shift(1) + Alt(2) + Ctrl(4) + Meta(8).
  // Modified navigation keys always use the CSI `1;<mod>` form regardless of
  // DECCKM (per xterm); unmodified ones honor application-cursor mode.
  const modifierCode =
    1 +
    (event.shiftKey ? 1 : 0) +
    (event.altKey ? 2 : 0) +
    (event.ctrlKey ? 4 : 0) +
    (event.metaKey ? 8 : 0);
  const cursor = (letter: string, normal: string, application: string) =>
    modifierCode > 1
      ? `\x1b[1;${modifierCode}${letter}`
      : options.applicationCursor
        ? application
        : normal;
  const tilde = (code: number) =>
    modifierCode > 1 ? `\x1b[${code};${modifierCode}~` : `\x1b[${code}~`;

  switch (key) {
    case "ArrowUp":
      return cursor("A", "\x1b[A", "\x1bOA");
    case "ArrowDown":
      return cursor("B", "\x1b[B", "\x1bOB");
    case "ArrowRight":
      return cursor("C", "\x1b[C", "\x1bOC");
    case "ArrowLeft":
      return cursor("D", "\x1b[D", "\x1bOD");
    case "Home":
      return cursor("H", "\x1b[H", "\x1bOH");
    case "End":
      return cursor("F", "\x1b[F", "\x1bOF");
    case "PageUp":
      return tilde(5);
    case "PageDown":
      return tilde(6);
    case "Insert":
      return tilde(2);
    case "Delete":
      return tilde(3);
    case "Escape":
      return "\x1b";
    case "Tab":
      return event.shiftKey ? "\x1b[Z" : "\t";
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
  }

  // Ctrl+letter → C0 control code (Ctrl+A = 0x01 … Ctrl+Z = 0x1a).
  if (event.ctrlKey && !event.altKey && !event.metaKey && key.length === 1) {
    const lower = key.toLowerCase();
    if (lower >= "a" && lower <= "z") {
      return String.fromCharCode(lower.charCodeAt(0) - 96);
    }
    return null;
  }

  // Plain printable character (Alt prefixes it with ESC, as terminals expect).
  if (!event.ctrlKey && !event.metaKey && key.length === 1) {
    return event.altKey ? `\x1b${key}` : key;
  }

  return null;
}
