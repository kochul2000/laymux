import type { TerminalInstance } from "@/stores/terminal-store";
import { getHandler, STATUS_ICON_WORKING } from "./activity-handler";

/**
 * Whether a terminal is doing work right now — the hourglass condition, run
 * over the terminal store's live state.
 *
 * This does not re-derive "busy" from raw fields. `outputActive` and
 * `activity.type === "running"` are only two of the signals: Claude's
 * local-agent path (issue #225) and Codex's Braille spinner both keep the
 * hourglass up with `outputActive === false` and an `interactiveApp` activity,
 * and only their handlers know that. Asking the same handler that draws the
 * icon is what keeps sleep prevention (ADR-0113) from letting the machine doze
 * off while a pane still says work is in progress.
 *
 * The status *function* is shared with what the UI renders; the input is not
 * always. `WorkspaceSelectorView` feeds it a backend snapshot whose
 * `outputActive` is pinned to `false` (that flag is a frontend DEC-2026 signal,
 * see `computeWorkspaceSummaryFromBackend`), so a bare shell streaming output
 * counts as busy here while that row still shows the previous result. Erring
 * towards awake is the right side of that gap.
 */
export function isTerminalBusy(instance: TerminalInstance): boolean {
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
export function hasBusyTerminal(instances: readonly TerminalInstance[]): boolean {
  return instances.some(isTerminalBusy);
}
