import { ShellActivityHandler } from "./shell-activity-handler";
import type { RawTerminalState } from "./activity-handler";

const BRAILLE_SPINNER_RANGE_START = 0x2800;
const BRAILLE_SPINNER_RANGE_END = 0x28ff;

function startsWithBrailleSpinner(title: string | undefined): boolean {
  if (!title) return false;
  const first = title.codePointAt(0) ?? 0;
  return first >= BRAILLE_SPINNER_RANGE_START && first <= BRAILLE_SPINNER_RANGE_END;
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
    if (!raw.outputActive && startsWithBrailleSpinner(raw.title)) {
      return { icon: "⏳", color: "var(--yellow)" };
    }
    return super.computeStatus(raw);
  }
}
