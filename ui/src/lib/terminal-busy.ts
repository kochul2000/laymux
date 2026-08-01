import type { TerminalInstance } from "@/stores/terminal-store";

/**
 * Whether a terminal is doing work right now — the same condition the pane
 * shows an hourglass for.
 *
 * This is deliberately the only definition of "busy" in the app. The activity
 * widget's count and sleep prevention (ADR-0113) both read it, so the machine
 * can never fall asleep while a pane still shows the hourglass.
 */
export function isTerminalBusy(instance: TerminalInstance): boolean {
  return instance.activity?.type === "running" || instance.outputActive === true;
}

/** Whether any terminal in the list is busy. */
export function hasBusyTerminal(instances: readonly TerminalInstance[]): boolean {
  return instances.some(isTerminalBusy);
}
