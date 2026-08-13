import type { RawTerminalState } from "./activity-handler";
import { STATUS_ICON_WORKING } from "./activity-markers";
import { ShellActivityHandler } from "./shell-activity-handler";

const BRAILLE_SPINNER_RANGE_START = 0x2800;
const BRAILLE_SPINNER_RANGE_END = 0x28ff;
const GROK_SUFFIX = " - grok";
const RUNNING_MARKER = "- Running:";
const DEFAULT_STATUS_MESSAGE_DELIMITER = " · ";

function startsWithBrailleSpinner(title: string | undefined): boolean {
  if (!title) return false;
  const first = title.codePointAt(0) ?? 0;
  return first >= BRAILLE_SPINNER_RANGE_START && first <= BRAILLE_SPINNER_RANGE_END;
}

function hasGrokSuffix(title: string | undefined): boolean {
  if (!title) return false;
  const trimmed = title.trimEnd();
  if (trimmed.length < GROK_SUFFIX.length) return false;
  return trimmed.slice(-GROK_SUFFIX.length).toLowerCase() === GROK_SUFFIX;
}

export function isGrokTitle(title: string | undefined): boolean {
  if (!title) return false;
  return title.includes("Grok Build") || hasGrokSuffix(title);
}

export function isGrokWorkingTitle(title: string | undefined): boolean {
  return !!title && isGrokTitle(title) && (startsWithBrailleSpinner(title) || title.includes(RUNNING_MARKER));
}

export function extractGrokTitleMessage(title: string | undefined): string | undefined {
  if (!title) return undefined;
  let rest = title.trim();
  if (startsWithBrailleSpinner(rest)) {
    rest = rest.slice([...rest][0]?.length ?? 1).trimStart();
  }
  if (rest.startsWith(RUNNING_MARKER)) {
    rest = rest.slice(RUNNING_MARKER.length).trimStart();
  }
  if (hasGrokSuffix(rest)) {
    rest = rest.slice(0, -GROK_SUFFIX.length).trimEnd();
  }
  if (!rest || rest.toLowerCase() === "grok") return undefined;
  return rest;
}

export class GrokActivityHandler extends ShellActivityHandler {
  shouldPreserveActivityOnTitleReset(): boolean {
    return true;
  }

  shouldPreserveActivityOnExitCode(): boolean {
    return false;
  }

  isActiveTitle(title: string | undefined): boolean {
    return isGrokWorkingTitle(title);
  }

  computeStatus(raw: RawTerminalState) {
    if (!raw.outputActive && isGrokWorkingTitle(raw.title)) {
      return { icon: STATUS_ICON_WORKING, color: "var(--yellow)" };
    }
    return super.computeStatus(raw);
  }

  computeStatusMessage(raw: RawTerminalState): string | undefined {
    const bullet = raw.activityMessage || undefined;
    const titleMsg = extractGrokTitleMessage(raw.title);
    const mode = raw.statusMessageMode ?? "title";
    const delimiter = raw.statusMessageDelimiter ?? DEFAULT_STATUS_MESSAGE_DELIMITER;

    if (bullet && titleMsg && bullet === titleMsg) {
      return bullet;
    }

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
        return titleMsg || bullet || undefined;
    }
  }
}
