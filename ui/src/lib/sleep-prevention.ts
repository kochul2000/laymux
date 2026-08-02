/**
 * Sleep prevention's two axes and their single derivation (ADR-0116).
 *
 * The user has two independent reasons to keep the machine awake: a manual
 * switch they flip for the session, and a standing policy that follows the
 * terminals. Both are raw settings; "a terminal is busy" is raw runtime state.
 * None of the three is the answer on its own — `shouldInhibitSleep` is the one
 * place they are folded into the boolean the backend acts on (ADR-0005).
 */

/** The two independent user-owned axes of sleep prevention. */
export interface SleepPreventionAxes {
  /** Manual switch, owned by the top-bar button: stay awake no matter what. */
  keepAwake: boolean;
  /** Standing policy, owned by Settings: stay awake while a terminal works. */
  keepAwakeWhenBusy: boolean;
}

/** The app must not change the machine's power behavior until asked. */
export const DEFAULT_SLEEP_PREVENTION_AXES: SleepPreventionAxes = {
  keepAwake: false,
  keepAwakeWhenBusy: false,
};

/** Whether the OS should be kept awake right now. */
export function shouldInhibitSleep(
  axes: SleepPreventionAxes,
  hasWorkingTerminal: boolean,
): boolean {
  // The axes are independent, so either one asking is enough — this OR *is* the
  // definition, not a shortcut over some priority between them.
  return axes.keepAwake || (axes.keepAwakeWhenBusy && hasWorkingTerminal);
}

/** Coerce an arbitrary settings value to the two axes. */
export function normalizeSleepPreventionAxes(value: unknown): SleepPreventionAxes {
  // A hand-edited value has to land on `false` rather than be read for
  // truthiness: `"false"` and `0` would otherwise disagree with each other, and
  // the wrong answer here acquires an OS inhibitor nobody asked for.
  const source = (typeof value === "object" && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    keepAwake: source.keepAwake === true,
    keepAwakeWhenBusy: source.keepAwakeWhenBusy === true,
  };
}
