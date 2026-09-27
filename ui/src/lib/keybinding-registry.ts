/**
 * Central keybinding registry.
 *
 * All keyboard shortcuts are defined in `keybinding-core.ts` (shared with the
 * Direct Remote page, ADR-0269). Components use `matchesKeybinding()` instead
 * of hardcoding key combos like `e.ctrlKey && e.key === 'c'`.
 * SettingsView imports `DEFAULT_KEYBINDINGS` to render the keybinding UI.
 *
 * User overrides from `settings.json` are automatically respected.
 */

import { useSettingsStore } from "@/stores/settings-store";
import { keybindingMatchesEvent, resolveKeybindingFrom } from "@/lib/keybinding-core";

export {
  DEFAULT_KEYBINDINGS,
  coerceArrowWildcard,
  isAssignedKeybinding,
  usesArrowWildcard,
  type KeybindingDef,
} from "@/lib/keybinding-core";

/**
 * Resolve the effective key combo string for an action (user override > default).
 * Returns undefined if action is not registered.
 */
export function resolveKeybinding(actionId: string): string | undefined {
  return resolveKeybindingFrom(useSettingsStore.getState().keybindings, actionId);
}

/**
 * React hook variant of `resolveKeybinding()`.
 * Subscribes to the settings store, so components re-render (and tooltips refresh)
 * when the user rebinds the action in Settings. (PR #331 review)
 */
export function useResolvedKeybinding(actionId: string): string | undefined {
  const userOverrides = useSettingsStore((s) => s.keybindings);
  return resolveKeybindingFrom(userOverrides, actionId);
}

/**
 * Check if a keyboard event matches a registered keybinding action.
 * Respects user overrides from settings.
 */
export function matchesKeybinding(
  e: KeyboardEvent | React.KeyboardEvent,
  actionId: string,
): boolean {
  return keybindingMatchesEvent(resolveKeybinding(actionId), e);
}
