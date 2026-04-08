import { ShellActivityHandler } from "./shell-activity-handler";
import type { RawTerminalState, StatusResult } from "./activity-handler";

/** U+2733 — Claude Code idle title prefix. */
const CLAUDE_IDLE_PREFIX = "\u2733";

/** Star-based working spinner prefixes (✶✻✽✢). */
const WORKING_STAR_SPINNERS = ["\u2736", "\u273B", "\u273D", "\u2722"];

/** Check if char is a Braille pattern (U+2800..U+28FF). */
function isBraille(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x2800 && code <= 0x28ff;
}

/**
 * Extract a meaningful message from a Claude Code title by stripping spinner prefix.
 * Returns undefined for idle titles (✳), non-Claude titles, or "Claude Code" text.
 */
function extractTitleMessage(title: string | undefined): string | undefined {
  if (!title) return undefined;
  const first = title.charAt(0);
  // Must start with a working spinner (not idle ✳)
  if (!WORKING_STAR_SPINNERS.includes(first) && !isBraille(first)) return undefined;
  const stripped = title.slice(1).trim();
  // Skip if the stripped text is just "Claude Code" — not informative
  if (!stripped || stripped === "Claude Code") return undefined;
  return stripped;
}

/**
 * Claude Code 전용 ActivityHandler.
 *
 * 셸 기본 4-state 규칙을 상속하되, Claude 전용 분기를 오버라이드한다:
 * - computeStatus: idle 상태(✳ 타이틀)에서 전용 아이콘/색상 표시
 * - computeStatusMessage: claudeMessage(white-● 상태 메시지) 반환
 */
export class ClaudeActivityHandler extends ShellActivityHandler {
  /**
   * Claude 전용 status 계산.
   *
   * 우선순위:
   * 1. outputActive → ⏳ yellow (working, 셸과 동일)
   * 2. exitCode=0 → ✓ green (task completed)
   * 3. exitCode≠0 → ✗ red (error)
   * 4. title starts with ✳ → ✳ Claude accent (idle, waiting for input)
   * 5. fallback → — gray
   */
  computeStatus(raw: RawTerminalState): StatusResult {
    // Priority 1-3: delegate to shell handler (outputActive, exitCode)
    if (raw.outputActive || raw.exitCode !== undefined) {
      return super.computeStatus(raw);
    }

    // Priority 4: Claude idle — title starts with ✳
    if (raw.title?.startsWith(CLAUDE_IDLE_PREFIX)) {
      return { icon: "\u2733", color: "var(--claude)" };
    }

    // Priority 5: fallback
    return super.computeStatus(raw);
  }

  /**
   * Claude 상태 메시지: statusMessageMode 설정에 따라 bullet/title을 조합.
   * - "bullet": bullet만
   * - "title": title만
   * - "bullet-title": bullet + delimiter + title (기본)
   * - "title-bullet": title + delimiter + bullet
   */
  computeStatusMessage(raw: RawTerminalState): string | undefined {
    const bullet = raw.claudeMessage || undefined;
    const titleMsg = extractTitleMessage(raw.title);
    const mode = raw.statusMessageMode ?? "bullet-title";
    const delimiter = raw.statusMessageDelimiter ?? " · ";

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
