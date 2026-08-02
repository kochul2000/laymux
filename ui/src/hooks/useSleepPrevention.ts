import { useEffect, useRef } from "react";
import { shouldInhibitSleep } from "@/lib/sleep-prevention";
import { setSleepInhibit } from "@/lib/tauri-api";
import { hasBusyTerminal } from "@/lib/terminal-busy";
import { useSettingsStore } from "@/stores/settings-store";
import { useSleepInhibitStore } from "@/stores/sleep-inhibit-store";
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
 * Requests are strictly serialized. The command is async on the Rust side, so
 * two overlapping calls could otherwise be applied out of order and leave the
 * OS in the state the *earlier* one asked for.
 */
export function useSleepPrevention(): void {
  /** What the OS should be in. */
  const desired = useRef<boolean | null>(null);
  /** What the backend confirmed. `null` means unknown — assume nothing. */
  const confirmed = useRef<boolean | null>(null);
  /**
   * A value the backend just refused. Re-sending it immediately would spin on a
   * machine that always refuses, so it is held back until the answer changes.
   */
  const refused = useRef<boolean | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    const report = useSleepInhibitStore.getState();

    /** Drive the backend towards `desired`, one call at a time. */
    const pump = () => {
      if (inFlight.current) return;
      const want = desired.current;
      if (want === null || want === confirmed.current || want === refused.current) return;

      inFlight.current = true;
      void setSleepInhibit(want)
        .then((active) => {
          confirmed.current = active;
          report.reportSuccess(active);
          // The backend answers with the state actually in effect. If that is
          // not what was asked for, asking again would just get the same answer
          // — hold the value back like a refusal instead of spinning on it.
          refused.current = active === want ? null : want;
        })
        .catch((error: unknown) => {
          // The mode is the user's choice and stays as configured — a machine
          // that cannot inhibit sleep should not silently rewrite their
          // settings. What the OS is doing is now unknown, so nothing may be
          // skipped as a duplicate later; in particular the release on unmount
          // must still be attempted.
          confirmed.current = null;
          refused.current = want;
          report.reportFailure();
          console.warn("[sleep-prevention] failed to update inhibitor", error);
        })
        .finally(() => {
          inFlight.current = false;
          // Values that came and went mid-flight are collapsed: only where the
          // user ended up is worth another round trip.
          pump();
        });
    };

    const sync = () => {
      const mode = useSettingsStore.getState().power.sleepPrevention;
      // "off" needs no answer from the terminals, which is the common case —
      // don't walk them on every store update to reach a foregone conclusion.
      desired.current =
        mode === "off"
          ? false
          : shouldInhibitSleep(mode, hasBusyTerminal(useTerminalStore.getState().instances));
      pump();
    };

    // A reloaded WebView cannot know what the backend still holds, so the first
    // derived value is always sent — even when it is the default "no".
    sync();
    const unsubscribeSettings = useSettingsStore.subscribe(sync);
    const unsubscribeTerminals = useTerminalStore.subscribe(sync);

    return () => {
      unsubscribeSettings();
      unsubscribeTerminals();
      // Release on unmount so a reloaded WebView never leaves it held. The
      // refusal hold-back is dropped here: this is the last chance to let go,
      // and it goes through the same queue so it cannot overtake a call still
      // in flight.
      desired.current = false;
      refused.current = null;
      pump();
    };
  }, []);
}
