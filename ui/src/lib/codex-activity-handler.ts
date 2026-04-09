import type { RawTerminalState } from "./activity-handler";
import { CODEX_INPUT_PENDING_MARKER } from "./activity-detection";
import { ShellActivityHandler } from "./shell-activity-handler";

const BRAILLE_SPINNER_RANGE_START = 0x2800;
const BRAILLE_SPINNER_RANGE_END = 0x28ff;

function startsWithBrailleSpinner(title: string | undefined): boolean {
  if (!title) return false;
  const first = title.codePointAt(0) ?? 0;
  return first >= BRAILLE_SPINNER_RANGE_START && first <= BRAILLE_SPINNER_RANGE_END;
}

function isInputPending(activityMessage: string | undefined): boolean {
  return activityMessage === CODEX_INPUT_PENDING_MARKER;
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
    return super.computeStatusMessage(raw);
  }
}
