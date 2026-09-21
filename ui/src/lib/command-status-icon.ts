import type { StatusIconGlyph } from "./activity-markers";

export type CommandStatusIconKind = "working" | "success" | "failure" | "idle" | "waiting";

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
    case "—":
      return "idle";
  }
}
