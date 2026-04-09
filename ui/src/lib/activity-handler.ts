import type { TerminalActivityInfo } from "@/stores/terminal-store";
import { ShellActivityHandler } from "./shell-activity-handler";
import { ClaudeActivityHandler } from "./claude-activity-handler";

export interface StatusResult {
  icon: string;
  color: string;
}

export type ActivityStatusMessageMode = "bullet" | "title" | "title-bullet" | "bullet-title";

export interface RawTerminalState {
  exitCode: number | undefined;
  outputActive: boolean;
  lastCommand: string | undefined;
  activityMessage: string | undefined;
  activity: TerminalActivityInfo | undefined;
  title: string | undefined;
  /** Activity status message display mode. */
  statusMessageMode?: ActivityStatusMessageMode;
  /** Delimiter between bullet and title. */
  statusMessageDelimiter?: string;
}

export interface ActivityHandler {
  computeStatus(raw: RawTerminalState): StatusResult;
  computeStatusMessage(raw: RawTerminalState): string | undefined;
  computeNotification(raw: RawTerminalState): { message: string; level: string } | null;
}

const defaultHandler = new ShellActivityHandler();
const interactiveAppHandlers = new Map<string, ActivityHandler>();

export function registerActivityHandler(activityName: string, handler: ActivityHandler): void {
  interactiveAppHandlers.set(activityName, handler);
}

registerActivityHandler("Claude", new ClaudeActivityHandler());

export function getHandler(activity?: TerminalActivityInfo): ActivityHandler {
  if (activity?.type === "interactiveApp" && activity.name) {
    return interactiveAppHandlers.get(activity.name) ?? defaultHandler;
  }
  return defaultHandler;
}
