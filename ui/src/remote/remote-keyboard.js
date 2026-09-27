// Remote device bindings live here, independently of the PC's keybindings.
// Both keyboard navigation and the touch Nav pad dispatch these same actions.
export const REMOTE_NAV_TARGETS = Object.freeze({
  up: ["spatial", "prev"],
  down: ["spatial", "next"],
  left: ["notification", "recent"],
  right: ["notification", "oldest"],
});

export const REMOTE_NAV_MODIFIERS = Object.freeze({
  alt: { label: "Alt", alt: true, ctrl: false, shift: false },
  ctrlAlt: { label: "Ctrl + Alt", alt: true, ctrl: true, shift: false },
  altShift: { label: "Alt + Shift", alt: true, ctrl: false, shift: true },
  ctrlShift: { label: "Ctrl + Shift", alt: false, ctrl: true, shift: true },
});

export const DEFAULT_REMOTE_KEYBOARD_SETTINGS = Object.freeze({
  hideFloatingWithKeyboard: true,
  useRemoteNavigationKeys: true,
  remoteNavigationModifiers: "alt",
});

export function normalizeRemoteNavigationModifiers(value) {
  return Object.hasOwn(REMOTE_NAV_MODIFIERS, value)
    ? value
    : DEFAULT_REMOTE_KEYBOARD_SETTINGS.remoteNavigationModifiers;
}

export function readPhysicalKeyboardConnected(bridge) {
  try {
    const connected = bridge?.isPhysicalKeyboardConnected?.();
    return typeof connected === "boolean" ? connected : null;
  } catch {
    return null;
  }
}

export function remoteKeyboardVisibility(connected, settings) {
  return {
    floating: !(connected === true && settings.hideFloatingWithKeyboard),
  };
}

function matchesModifiers(event, binding) {
  return (
    event.altKey === binding.alt &&
    event.ctrlKey === binding.ctrl &&
    event.shiftKey === binding.shift &&
    !event.metaKey
  );
}

export function resolveRemoteNavigationKey(event, settings) {
  if (
    !settings.useRemoteNavigationKeys ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.getModifierState?.("AltGraph")
  )
    return null;
  const direction = { ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right" }[
    event.key
  ];
  if (!direction) return null;
  const binding =
    REMOTE_NAV_MODIFIERS[normalizeRemoteNavigationModifiers(settings.remoteNavigationModifiers)];
  if (matchesModifiers(event, binding)) {
    const [kind, step] = REMOTE_NAV_TARGETS[direction];
    return { kind, direction: step };
  }
  // While Remote owns navigation, the old PC combinations must not leak to
  // the terminal. Non-selected combinations have no Remote action.
  if (["alt", "ctrlAlt"].some((name) => matchesModifiers(event, REMOTE_NAV_MODIFIERS[name]))) {
    return { blocked: true };
  }
  return null;
}
