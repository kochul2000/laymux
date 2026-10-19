import type { StatusIconGlyph } from "./activity-markers";
import type { TaskResult, TaskState } from "./terminal-task";

/**
 * Presentation only (ADR-0251/0254/0341); never feed this back into task or
 * safety policy. Each distinct meaning gets its own glyph: an ended task
 * without an observed result is not "no task", and no observation at all is
 * neither.
 */
export function taskStatusGlyph(
  state: TaskState | undefined,
  result: TaskResult | undefined,
  outputActive = false,
): StatusIconGlyph {
  if (state === "idle") return "—";
  if (state === "waiting") return "!";
  if (state === "running") return "⏳";
  if (state === "ended") {
    if (result === "success") return "✓";
    if (result === "failure") return "✗";
    if (result === "interrupted") return "⊘";
    return "○";
  }
  return outputActive ? "⏳" : "·";
}
