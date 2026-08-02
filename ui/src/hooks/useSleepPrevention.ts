import { useEffect } from "react";
import { releaseSleepInhibit, requestSleepInhibit } from "@/lib/sleep-inhibit-coordinator";
import { shouldInhibitSleep } from "@/lib/sleep-prevention";
import { hasBusyTerminal } from "@/lib/terminal-busy";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";

/**
 * Keep the OS sleep inhibitor in step with the user's mode and the terminals'
 * busy state (ADR-0113).
 *
 * Mount once, at the app root. It subscribes to the stores instead of selecting
 * from them: the host component renders nothing from this state, and a busy
 * flag that flips every few seconds would otherwise reconcile the whole app
 * tree for a value nobody displays.
 *
 * Everything about *talking* to the backend — ordering, dedupe, retries — lives
 * in `sleep-inhibit-coordinator`, which outlives any single mount. This hook
 * only derives the wanted state and reports it.
 */
export function useSleepPrevention(): void {
  useEffect(() => {
    const sync = () => {
      const mode = useSettingsStore.getState().power.sleepPrevention;
      // "off" needs no answer from the terminals, which is the common case —
      // don't walk them on every store update to reach a foregone conclusion.
      const want =
        mode === "off"
          ? false
          : shouldInhibitSleep(mode, hasBusyTerminal(useTerminalStore.getState().instances));
      requestSleepInhibit(want);
    };

    // A reloaded WebView cannot know what the backend still holds, so the first
    // derived value is always sent — even when it is the default "no".
    sync();
    const unsubscribeSettings = useSettingsStore.subscribe(sync);
    const unsubscribeTerminals = useTerminalStore.subscribe(sync);

    return () => {
      unsubscribeSettings();
      unsubscribeTerminals();
      // Nothing derives the wanted state any more, so let go rather than leave
      // the machine awake for a tree that no longer exists.
      releaseSleepInhibit();
    };
  }, []);
}
