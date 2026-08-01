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
 * Mount once, at the app root. The backend call is idempotent, but this hook
 * also skips it when the derived boolean has not changed so a busy terminal
 * producing output does not generate one IPC round-trip per activity update.
 */
export function useSleepPrevention(): void {
  const mode = useSettingsStore((s) => s.power.sleepPrevention);
  // A boolean selector: the hook re-renders when the *answer* flips, not on
  // every activity update in every terminal.
  const busy = useTerminalStore((s) => hasBusyTerminal(s.instances));

  const lastSent = useRef<boolean | null>(null);

  useEffect(() => {
    const desired = shouldInhibitSleep(mode, busy);
    if (lastSent.current === desired) return;
    lastSent.current = desired;
    void setSleepInhibit(desired).catch((error: unknown) => {
      // The mode is the user's choice and stays as configured — a machine that
      // cannot inhibit sleep (no systemd-inhibit, unsupported platform) should
      // not silently rewrite their settings. Forget what was sent so the next
      // transition retries, unless a newer request already superseded this one.
      if (lastSent.current === desired) lastSent.current = null;
      console.warn("[sleep-prevention] failed to update inhibitor", error);
    });
  }, [mode, busy]);

  // Release on unmount so a reloaded WebView never leaves the inhibitor held.
  useEffect(() => {
    return () => {
      if (lastSent.current !== true) return;
      lastSent.current = null;
      void setSleepInhibit(false).catch(() => {});
    };
  }, []);
}
