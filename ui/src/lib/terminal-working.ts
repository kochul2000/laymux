import type { TerminalInstance } from "@/stores/terminal-store";
import { terminalTaskPolicy } from "./terminal-task";

/** Automatic sleep policy; never infer work from an icon or a display message. */
export function isTerminalWorking(instance: TerminalInstance): boolean {
  return terminalTaskPolicy(instance).inhibitSleep;
}

export function hasWorkingTerminal(instances: readonly TerminalInstance[]): boolean {
  return instances.some(isTerminalWorking);
}
