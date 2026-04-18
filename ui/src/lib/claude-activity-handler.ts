import { ShellActivityHandler } from "./shell-activity-handler";
import type { RawTerminalState, StatusResult } from "./activity-handler";

const WORKING_STAR_SPINNERS = ["\u2736", "\u273B", "\u273D", "\u2722"];
const CLAUDE_IDLE_PREFIX = "\u2733"; // ✳
const DEFAULT_STATUS_MESSAGE_DELIMITER = " \u00b7 ";

function isBraille(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x2800 && code <= 0x28ff;
}

function extractTitleMessage(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const first = title.charAt(0);
  if (!WORKING_STAR_SPINNERS.includes(first) && !isBraille(first)) return undefined;

  const stripped = title.slice(1).trim();
  if (!stripped || stripped === "Claude Code") return undefined;
  return stripped;
}

export class ClaudeActivityHandler extends ShellActivityHandler {
  shouldPreserveActivityOnExitCode(): boolean {
    return true;
  }

  computeStatus(raw: RawTerminalState): StatusResult {
    if (raw.outputActive) return { icon: "⏳", color: "var(--yellow)" };
    // Claude keeps its process alive after finishing a task and switches its
    // title to the idle marker (✳ U+2733). A synthetic exitCode=0 is emitted
    // on task completion, but the claude process itself never exits, so on a
    // fresh task the workspace icon must still reflect the idle/completed
    // state instead of falling through to the gray dash. Treat idle title as
    // success.
    if (raw.title?.startsWith(CLAUDE_IDLE_PREFIX)) {
      return { icon: "✓", color: "var(--green)" };
    }
    return super.computeStatus(raw);
  }

  computeStatusMessage(raw: RawTerminalState): string | undefined {
    const bullet = raw.activityMessage || undefined;
    const titleMsg = extractTitleMessage(raw.title);
    const mode = raw.statusMessageMode ?? "bullet-title";
    const delimiter = raw.statusMessageDelimiter ?? DEFAULT_STATUS_MESSAGE_DELIMITER;

    switch (mode) {
      case "bullet":
        return bullet;
      case "title":
        return titleMsg;
      case "bullet-title":
        if (bullet && titleMsg) return `${bullet}${delimiter}${titleMsg}`;
        return bullet || titleMsg || undefined;
      case "title-bullet":
        if (bullet && titleMsg) return `${titleMsg}${delimiter}${bullet}`;
        return titleMsg || bullet || undefined;
      default:
        return bullet || titleMsg || undefined;
    }
  }
}
