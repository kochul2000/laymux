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
