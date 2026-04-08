import type { TerminalActivityInfo } from "@/stores/terminal-store";
import { ShellActivityHandler } from "./shell-activity-handler";
import { ClaudeActivityHandler } from "./claude-activity-handler";

export interface StatusResult {
  icon: string;
  color: string;
}

export interface RawTerminalState {
  exitCode: number | undefined;
  outputActive: boolean;
  lastCommand: string | undefined;
  claudeMessage: string | undefined;
  activity: TerminalActivityInfo | undefined;
  title: string | undefined;
}

export interface ActivityHandler {
  computeStatus(raw: RawTerminalState): StatusResult;
  computeStatusMessage(raw: RawTerminalState): string | undefined;
  computeNotification(
    raw: RawTerminalState,
  ): { message: string; level: string } | null;
}

const handlers: Record<string, ActivityHandler> = {
  default: new ShellActivityHandler(),
  Claude: new ClaudeActivityHandler(),
};

export function getHandler(activity?: TerminalActivityInfo): ActivityHandler {
  return (activity?.name ? handlers[activity.name] : undefined) ?? handlers.default;
}
