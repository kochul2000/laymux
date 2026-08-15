import type { ActivityHandler, RawTerminalState, StatusResult } from "./activity-handler";
import { STATUS_ICON_WORKING } from "./activity-markers";

export class ShellActivityHandler implements ActivityHandler {
  clearInput(shellClearCommand: string): string {
    return shellClearCommand;
  }

  isBusy(raw: RawTerminalState): boolean {
    return raw.outputActive || raw.activity?.type === "running";
  }

  computeStatus(raw: RawTerminalState): StatusResult {
    if (raw.outputActive) return { icon: STATUS_ICON_WORKING, color: "var(--yellow)" };
    // Activity === "running" means a command started but has not yet exited.
    // Preferred over a stale exitCode from the previous command so long-running
    // commands without DEC-2026 bursts (sleep, ssh, sparse scripts) still show
    // the running indicator instead of inheriting the prior ✓/✗.
    if (raw.activity?.type === "running")
      return { icon: STATUS_ICON_WORKING, color: "var(--yellow)" };
    if (raw.exitCode === 0) return { icon: "✓", color: "var(--green)" };
    if (raw.exitCode !== undefined) return { icon: "✗", color: "var(--red)" };
    return { icon: "—", color: "var(--text-secondary)" };
  }

  computeStatusMessage(_raw: RawTerminalState): string | undefined {
    return undefined;
  }

  computeNotification(_raw: RawTerminalState): null {
    return null;
  }
}
