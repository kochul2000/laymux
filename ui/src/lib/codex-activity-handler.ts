import type { RawTerminalState } from "./activity-handler";
import { CODEX_INPUT_PENDING_MARKER } from "./activity-detection";
import { ShellActivityHandler } from "./shell-activity-handler";

const BRAILLE_SPINNER_RANGE_START = 0x2800;
const BRAILLE_SPINNER_RANGE_END = 0x28ff;
const DEFAULT_STATUS_MESSAGE_DELIMITER = " · ";

function startsWithBrailleSpinner(title: string | undefined): boolean {
  if (!title) return false;
  const first = title.codePointAt(0) ?? 0;
  return first >= BRAILLE_SPINNER_RANGE_START && first <= BRAILLE_SPINNER_RANGE_END;
}

function isInputPending(activityMessage: string | undefined): boolean {
  return activityMessage === CODEX_INPUT_PENDING_MARKER;
}

export function extractCodexTitleMessage(title: string | undefined): string | undefined {
  if (!startsWithBrailleSpinner(title) || !title) return undefined;
  const stripped = title.slice(1).trim();
  return stripped || undefined;
}

export class CodexActivityHandler extends ShellActivityHandler {
  shouldPreserveActivityOnTitleReset(): boolean {
    return true;
  }

  shouldPreserveActivityOnExitCode(): boolean {
    return false;
  }

  isActiveTitle(title: string | undefined): boolean {
    return startsWithBrailleSpinner(title);
  }

  computeStatus(raw: RawTerminalState) {
    if (isInputPending(raw.activityMessage)) {
      return { icon: "✓", color: "var(--green)" };
    }
    if (!raw.outputActive && startsWithBrailleSpinner(raw.title)) {
      return { icon: "⏳", color: "var(--yellow)" };
    }
    return super.computeStatus(raw);
  }

  computeStatusMessage(raw: RawTerminalState): string | undefined {
    if (isInputPending(raw.activityMessage)) {
      return undefined;
    }
    const bullet = raw.activityMessage || undefined;
    const titleMsg = extractCodexTitleMessage(raw.title);
    const mode = raw.statusMessageMode ?? "title";
    const delimiter = raw.statusMessageDelimiter ?? DEFAULT_STATUS_MESSAGE_DELIMITER;

    if (bullet && titleMsg && bullet === titleMsg) {
      return bullet;
    }

    switch (mode) {
      case "bullet":
        return bullet;
      case "title":
        return titleMsg || bullet || undefined;
      case "bullet-title":
        if (bullet && titleMsg) return `${bullet}${delimiter}${titleMsg}`;
        return bullet || titleMsg || undefined;
      case "title-bullet":
        if (bullet && titleMsg) return `${titleMsg}${delimiter}${bullet}`;
        return titleMsg || bullet || undefined;
      default:
        return titleMsg || bullet || undefined;
    }
  }
}
