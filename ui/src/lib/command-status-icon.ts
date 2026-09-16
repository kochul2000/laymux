import type { StatusIconGlyph } from "./activity-markers";

export type CommandStatusIconKind =
  | "working"
  | "success"
  | "failure"
  | "idle"
  | "waiting"
  | "interrupted"
  | "ended"
  | "unknown";

export function getCommandStatusIconKind(status: StatusIconGlyph): CommandStatusIconKind {
  switch (status) {
    case "⏳":
      return "working";
    case "✓":
      return "success";
    case "✗":
      return "failure";
    case "!":
      return "waiting";
    case "⊘":
      return "interrupted";
    case "□":
      return "ended";
    case "?":
      return "unknown";
    case "—":
      return "idle";
  }
}
