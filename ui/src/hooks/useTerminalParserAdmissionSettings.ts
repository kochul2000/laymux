import { useEffect } from "react";
import { terminalWriteFairScheduler } from "@/lib/terminal-write-fair-scheduler";
import { useSettingsStore, type TerminalSettings } from "@/stores/settings-store";

/**
 * Keep the app-wide parser admission class shares in step with settings.json
 * (`terminal.parserAdmission`, ADR-0101). The scheduler clamps and fills in
 * anything the file omits, so a partial or invalid table still admits writes.
 */
export function useTerminalParserAdmissionSettings(): void {
  useEffect(() => {
    const apply = (terminal: TerminalSettings) => {
      const shares = terminal.parserAdmission;
      terminalWriteFairScheduler.setClassShare(
        shares
          ? {
              focused: shares.focusedShare,
              foreground: shares.visibleShare,
              background: shares.hiddenShare,
            }
          : undefined,
      );
    };
    apply(useSettingsStore.getState().terminal);
    return useSettingsStore.subscribe((state, previous) => {
      if (state.terminal.parserAdmission !== previous.terminal.parserAdmission) {
        apply(state.terminal);
      }
    });
  }, []);
}
