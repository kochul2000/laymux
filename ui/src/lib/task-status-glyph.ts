import type { StatusIconGlyph } from "./activity-markers";
import type { TaskResult, TaskState } from "./terminal-task";

/** Presentation only (ADR-0251); never feed this back into task or safety policy. */
export function taskStatusGlyph(
  state: TaskState | undefined,
  result: TaskResult | undefined,
  outputActive = false,
): StatusIconGlyph {
  if (state === "waiting") return "!";
  if (state === "running") return "⏳";
  if (state === "ended") {
    if (result === "success") return "✓";
    if (result === "failure") return "✗";
    return "—";
  }
  return outputActive ? "⏳" : "—";
}
