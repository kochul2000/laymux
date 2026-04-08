import type { ActivityHandler, RawTerminalState, StatusResult } from "./activity-handler";

export class ShellActivityHandler implements ActivityHandler {
  computeStatus(raw: RawTerminalState): StatusResult {
    if (raw.outputActive) return { icon: "⏳", color: "var(--yellow)" };
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
