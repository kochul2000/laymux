import { ShellActivityHandler } from "./shell-activity-handler";

/**
 * Claude Code 전용 ActivityHandler.
 *
 * 현재는 ShellActivityHandler와 동일하지만, activity 타입에 따라
 * 핸들러가 교체되는 seam을 제공한다. 향후 Claude 전용 분기가 필요하면
 * 해당 메서드만 오버라이드한다.
 */
export class ClaudeActivityHandler extends ShellActivityHandler {}
