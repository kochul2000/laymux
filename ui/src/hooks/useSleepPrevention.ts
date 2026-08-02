import { useEffect } from "react";
import {
  observeSleepInhibitState,
  releaseSleepInhibit,
  requestSleepInhibit,
} from "@/lib/sleep-inhibit-coordinator";
import { shouldInhibitSleep } from "@/lib/sleep-prevention";
import { onSleepInhibitChanged } from "@/lib/tauri-api";
import { hasWorkingTerminal } from "@/lib/terminal-working";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";

/**
 * Keep the OS sleep inhibitor in step with the user's two axes and the
 * terminals' busy state (ADR-0115).
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
      const axes = useSettingsStore.getState().power;
      // With the policy off the terminals cannot change the answer, which is
      // the common case — don't walk them on every store update to reach a
      // foregone conclusion.
      const hasBusy =
        axes.keepAwakeWhenBusy && hasWorkingTerminal(useTerminalStore.getState().instances);
      requestSleepInhibit(shouldInhibitSleep(axes, hasBusy));
    };

    // A reloaded WebView cannot know what the backend still holds, so the first
    // derived value is always sent — even when it is the default "no".
    sync();
    const unsubscribeSettings = useSettingsStore.subscribe(sync);
    const unsubscribeTerminals = useTerminalStore.subscribe(sync);

    // The backend's watchdog can acquire or lose an inhibitor with no request
    // behind it. Nothing else would notice: this hook only reports changes.
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onSleepInhibitChanged(({ active, satisfied }) => {
      observeSleepInhibitState(active, satisfied);
    })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch((error: unknown) => {
        console.warn("[sleep-prevention] failed to follow inhibitor changes", error);
      });

    return () => {
      cancelled = true;
      unlisten?.();
      unsubscribeSettings();
      unsubscribeTerminals();
      // Nothing derives the wanted state any more, so let go rather than leave
      // the machine awake for a tree that no longer exists.
      releaseSleepInhibit();
    };
  }, []);
}
