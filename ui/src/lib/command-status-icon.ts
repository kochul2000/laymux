import type { StatusIconGlyph } from "./activity-markers";

export type CommandStatusIconKind =
  "working" | "success" | "failure" | "interrupted" | "ended" | "idle" | "unknown" | "waiting";

export function getCommandStatusIconKind(status: StatusIconGlyph): CommandStatusIconKind {
  switch (status) {
    case "⏳":
      return "working";
    case "✓":
      return "success";
    case "✗":
      return "failure";
    case "⊘":
      return "interrupted";
    case "○":
      return "ended";
    case "!":
      return "waiting";
    case "—":
      return "idle";
    case "·":
      return "unknown";
  }
}
