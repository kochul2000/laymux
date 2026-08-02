import { useEffect, useRef } from "react";
import { shouldInhibitSleep } from "@/lib/sleep-prevention";
import { setSleepInhibit } from "@/lib/tauri-api";
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
 * Requests are strictly serialized. The command is async on the Rust side, so
 * two overlapping calls could otherwise be applied out of order and leave the
 * OS in the state the *earlier* one asked for.
 */
export function useSleepPrevention(): void {
  /** What the OS should be in. */
  const desired = useRef<boolean | null>(null);
  /** What was last handed to the backend, successfully or not. */
  const applied = useRef<boolean | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    /** Drive `applied` towards `desired`, one call at a time. */
    const pump = () => {
      if (inFlight.current) return;
      const want = desired.current;
      if (want === null || want === applied.current) return;

      inFlight.current = true;
      applied.current = want;
      void setSleepInhibit(want)
        .catch((error: unknown) => {
          // The mode is the user's choice and stays as configured — a machine
          // that cannot inhibit sleep (no systemd-inhibit, unsupported
          // platform) should not silently rewrite their settings.
          //
          // The attempt still counts as applied. Clearing it here would make
          // the pump below immediately re-send the same value, and a backend
          // that always fails would spin. The next *different* value is sent
          // normally, which is the only retry that can succeed anyway.
          console.warn("[sleep-prevention] failed to update inhibitor", error);
        })
        .finally(() => {
          inFlight.current = false;
          // Intermediate values that arrived mid-flight are collapsed: only the
          // latest `desired` is worth another round trip.
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
      // Release on unmount so a reloaded WebView never leaves it held. This
      // goes through the same queue, so it cannot overtake a call still in
      // flight.
      desired.current = false;
      pump();
    };
  }, []);
}
