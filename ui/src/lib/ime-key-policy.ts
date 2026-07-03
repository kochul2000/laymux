export type ImeKeyPolicyEvent = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey"
>;

const IME_NAVIGATION_KEYS = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Enter",
  "Escape",
  "Backspace",
  "Delete",
  "Tab",
]);

// IME mode-switch keys (한/영 HangulMode, 한자 HanjaMode, Japanese
// Convert/Kana, generic ModeChange). xterm's CompositionHelper.keydown()
// only exempts keyCode 229/16/17/18/20 while composing — every other key
// force-finalizes the composition with a possibly stale textarea range and
// re-sends already-committed text (Korean syllable duplication). These keys
// must never reach xterm while a composition is active. Blocking them in
// attachCustomKeyEventHandler skips xterm's key pipeline without calling
// preventDefault, so the OS-level IME mode switch itself still works.
const IME_MODE_SWITCH_KEYS = new Set([
  "HangulMode",
  "HanjaMode",
  "JunjaMode",
  "KanaMode",
  "KanjiMode",
  "Convert",
  "NonConvert",
  "ModeChange",
]);

export function shouldBlockTerminalKeyDuringIme(
  compositionActive: boolean,
  event: ImeKeyPolicyEvent,
): boolean {
  if (!compositionActive) return false;
  return IME_MODE_SWITCH_KEYS.has(event.key);
}

export function shouldDeferTerminalKeyToIme(
  compositionActive: boolean,
  event: ImeKeyPolicyEvent,
): boolean {
  if (!compositionActive) return false;

  // Global shortcuts should keep working while composition is active.
  if (event.ctrlKey || event.altKey || event.metaKey) {
    return false;
  }

  // IME composition should own unmodified text/navigation keys.
  if (IME_NAVIGATION_KEYS.has(event.key)) {
    return true;
  }

  // Printable input, including space, should stay in the IME path.
  if (event.key.length === 1) {
    return true;
  }

  // Non-printable keys that are not explicitly navigation-related can flow through.
  return false;
}
