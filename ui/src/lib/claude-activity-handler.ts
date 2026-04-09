import { ShellActivityHandler } from "./shell-activity-handler";
import type { RawTerminalState, StatusResult } from "./activity-handler";

const CLAUDE_IDLE_PREFIX = "\u2733";
const WORKING_STAR_SPINNERS = ["\u2736", "\u273B", "\u273D", "\u2722"];
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
  computeStatus(raw: RawTerminalState): StatusResult {
    if (raw.outputActive || raw.exitCode !== undefined) {
      return super.computeStatus(raw);
    }

    if (raw.title?.startsWith(CLAUDE_IDLE_PREFIX)) {
      return { icon: "\u2733", color: "var(--claude)" };
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
