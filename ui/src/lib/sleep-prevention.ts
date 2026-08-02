/**
 * Sleep prevention mode and its single derivation (ADR-0114).
 *
 * The mode is a raw user setting; "a terminal is busy" is raw runtime state.
 * Neither is the answer on its own — `shouldInhibitSleep` is the one place the
 * two are folded into the boolean the backend acts on (ADR-0005).
 */

/** Never inhibit / always inhibit / inhibit only while a terminal is busy. */
export type SleepPreventionMode = "off" | "always" | "whenBusy";

/** Click order of the top-bar toggle. */
export const SLEEP_PREVENTION_MODES: readonly SleepPreventionMode[] = ["off", "always", "whenBusy"];

export const DEFAULT_SLEEP_PREVENTION_MODE: SleepPreventionMode = "off";

/** Whether the OS should be kept awake right now. */
export function shouldInhibitSleep(
  mode: SleepPreventionMode,
  hasWorkingTerminal: boolean,
): boolean {
  switch (mode) {
    case "always":
      return true;
    case "whenBusy":
      return hasWorkingTerminal;
    default:
      return false;
  }
}

/** Next mode for a click on the top-bar toggle. */
export function cycleSleepPreventionMode(mode: SleepPreventionMode): SleepPreventionMode {
  const index = SLEEP_PREVENTION_MODES.indexOf(mode);
  // An unknown value (hand-edited settings.json) restarts the cycle rather than
  // leaving the button dead.
  return SLEEP_PREVENTION_MODES[(index + 1) % SLEEP_PREVENTION_MODES.length] ?? "off";
}

/** Coerce an arbitrary settings value to a known mode. */
export function normalizeSleepPreventionMode(value: unknown): SleepPreventionMode {
  return SLEEP_PREVENTION_MODES.includes(value as SleepPreventionMode)
    ? (value as SleepPreventionMode)
    : DEFAULT_SLEEP_PREVENTION_MODE;
}
