/**
 * Internal sentinel values written to `instance.activityMessage` when a TUI
 * provider is waiting for user input. They are *internal* state, never
 * user-facing strings — the activity handlers swap them out for the
 * appropriate icon and (optionally) a derived display message.
 *
 * Lives in its own module so both `activity-detection.ts` (the writer) and
 * the per-provider handlers (the readers) can import from a leaf with no
 * back-edges to `activity-handler.ts`. Importing the markers from
 * `activity-detection.ts` would create a load-order cycle
 * (`activity-handler` → `claude-activity-handler` → `activity-detection`
 * → `activity-handler`) that races `new ClaudeActivityHandler()` against
 * the partial activity-handler module.
 */
export const CODEX_INPUT_PENDING_MARKER = "__codex_input_pending__";
export const CLAUDE_INPUT_PENDING_MARKER = "__claude_input_pending__";

/**
 * The hourglass a pane shows while it is doing work.
 *
 * Named because it is not only drawn: sleep prevention treats "the status a
 * handler computed is this icon" as the definition of a busy terminal
 * (ADR-0114), so the same value has to come from one place. It lives in this
 * leaf for the same load-order reason as the markers above — the handlers are
 * loaded *by* `activity-handler.ts` and cannot import values back out of it.
 */
export const STATUS_ICON_WORKING = "⏳";
