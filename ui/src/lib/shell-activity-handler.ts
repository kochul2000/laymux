import type { ActivityHandler, RawTerminalState } from "./activity-handler";

export class ShellActivityHandler implements ActivityHandler {
  clearInput(shellClearCommand: string): string {
    return shellClearCommand;
  }

  computeStatusMessage(_raw: RawTerminalState): string | undefined {
    return undefined;
  }
}
