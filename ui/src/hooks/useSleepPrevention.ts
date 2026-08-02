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
 * The backend call is idempotent, but the last sent value is tracked here too
 * so a terminal streaming output does not produce one IPC round-trip per
 * activity update.
 */
export function useSleepPrevention(): void {
  const lastSent = useRef<boolean | null>(null);

  useEffect(() => {
    const sync = () => {
      const mode = useSettingsStore.getState().power.sleepPrevention;
      // "off" needs no answer from the terminals, which is the common case —
      // don't walk them on every store update to reach a foregone conclusion.
      const desired =
        mode === "off"
          ? false
          : shouldInhibitSleep(mode, hasBusyTerminal(useTerminalStore.getState().instances));

      if (lastSent.current === desired) return;
      lastSent.current = desired;
      void setSleepInhibit(desired).catch((error: unknown) => {
        // The mode is the user's choice and stays as configured — a machine
        // that cannot inhibit sleep (no systemd-inhibit, unsupported platform)
        // should not silently rewrite their settings. Forget what was sent so
        // the next change retries, unless a newer request already superseded
        // this one.
        if (lastSent.current === desired) lastSent.current = null;
        console.warn("[sleep-prevention] failed to update inhibitor", error);
      });
    };

    // A reloaded WebView cannot know what the backend still holds, so the first
    // derived value is always sent — even when it is the default "no".
    sync();
    const unsubscribeSettings = useSettingsStore.subscribe(sync);
    const unsubscribeTerminals = useTerminalStore.subscribe(sync);

    return () => {
      unsubscribeSettings();
      unsubscribeTerminals();
      // Release on unmount so a reloaded WebView never leaves it held.
      if (lastSent.current !== true) return;
      lastSent.current = null;
      void setSleepInhibit(false).catch(() => {});
    };
  }, []);
}
