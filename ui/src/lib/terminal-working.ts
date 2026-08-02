import type { TerminalInstance } from "@/stores/terminal-store";
import { getHandler, STATUS_ICON_WORKING } from "./activity-handler";

/**
 * Whether a terminal is doing work right now — literally the condition under
 * which its pane shows the hourglass.
 *
 * This does not re-derive "busy" from raw fields. `outputActive` and
 * `activity.type === "running"` are only two of the signals: Claude's
 * local-agent path (issue #225) and Codex's Braille spinner both keep the
 * hourglass up with `outputActive === false` and an `interactiveApp` activity,
 * and only their handlers know that. Asking the same handler that draws the
 * icon is what keeps sleep prevention (ADR-0114) from letting the machine doze
 * off while a pane still says work is in progress.
 *
 * `WorkspaceSelectorView` renders the same status from the same live store
 * state, so the two agree by construction rather than by convention.
 */
export function isTerminalWorking(instance: TerminalInstance): boolean {
  const status = getHandler(instance.activity).computeStatus({
    exitCode: instance.lastExitCode,
    outputActive: instance.outputActive ?? false,
    lastCommand: instance.lastCommand,
    activityMessage: instance.activityMessage,
    activity: instance.activity,
    title: instance.title,
  });
  return status.icon === STATUS_ICON_WORKING;
}

/** Whether any terminal in the list is busy. */
export function hasWorkingTerminal(instances: readonly TerminalInstance[]): boolean {
  return instances.some(isTerminalWorking);
}
