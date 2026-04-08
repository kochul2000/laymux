import { ShellActivityHandler } from "./shell-activity-handler";
import type { RawTerminalState, StatusResult } from "./activity-handler";

/** U+2733 — Claude Code idle title prefix. */
const CLAUDE_IDLE_PREFIX = "\u2733";

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
   * Claude는 claudeMessage(white-● 상태 메시지)를 표시 텍스트로 반환.
   * 셸 명령 텍스트 대신 "Reading file src/main.rs" 같은 태스크 설명을 보여준다.
   */
  computeStatusMessage(raw: RawTerminalState): string | undefined {
    return raw.claudeMessage || undefined;
  }
}
