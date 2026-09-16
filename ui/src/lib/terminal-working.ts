import type { TerminalInstance } from "@/stores/terminal-store";
import { terminalTaskPolicy } from "./terminal-task";

/** Displayed work count follows the task, not the sleep grace period or output. */
export function isTerminalWorking(instance: TerminalInstance): boolean {
  return instance.task?.state === "running";
}

export function hasSleepInhibitingTerminal(instances: readonly TerminalInstance[]): boolean {
  return instances.some((instance) => terminalTaskPolicy(instance).inhibitSleep);
}
