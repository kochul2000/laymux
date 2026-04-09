import type { TerminalActivityInfo } from "@/stores/terminal-store";
import { ShellActivityHandler } from "./shell-activity-handler";
import { ClaudeActivityHandler } from "./claude-activity-handler";
import { CodexActivityHandler } from "./codex-activity-handler";

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
  shouldPreserveActivityOnTitleReset?(raw: RawTerminalState): boolean;
  shouldPreserveActivityOnExitCode?(raw: RawTerminalState): boolean;
  isActiveTitle?(title: string | undefined): boolean;
}

type InteractiveAppRegistration = {
  handler: ActivityHandler;
  commands?: string[];
  titlePatterns?: string[];
};

const defaultHandler = new ShellActivityHandler();
const interactiveApps = new Map<string, InteractiveAppRegistration>();

function registerInteractiveApp(
  activityName: string,
  registration: ActivityHandler | InteractiveAppRegistration,
): void {
  interactiveApps.set(
    activityName,
    "computeStatus" in registration ? { handler: registration } : registration,
  );
}

registerInteractiveApp("Claude", {
  handler: new ClaudeActivityHandler(),
  commands: ["claude"],
  titlePatterns: ["Claude Code"],
});
registerInteractiveApp("Codex", {
  handler: new CodexActivityHandler(),
  commands: ["codex"],
  titlePatterns: ["OpenAI Codex"],
});

export function getHandler(activity?: TerminalActivityInfo): ActivityHandler {
  if (activity?.type === "interactiveApp" && activity.name) {
    return interactiveApps.get(activity.name)?.handler ?? defaultHandler;
  }
  return defaultHandler;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchTitlePattern(title: string, pattern: string): boolean {
  if (title === pattern) return true;
  return new RegExp(`(?:^|[\\s\\-:])${escapeRegExp(pattern)}(?:$|[\\s\\-:])`).test(title);
}

function getBasename(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;

  let first = trimmed.split(/\s+/)[0];
  if (first === "sudo" && trimmed.split(/\s+/).length > 1) {
    first = trimmed.split(/\s+/)[1];
  }
  return first.split("/").pop() ?? first;
}

export function detectRegisteredActivityFromTitle(title: string): TerminalActivityInfo | undefined {
  if (!title || title.includes("/") || title.includes("\\")) return undefined;

  for (const [name, registration] of interactiveApps) {
    if (registration.titlePatterns?.some((pattern) => matchTitlePattern(title, pattern))) {
      return { type: "interactiveApp", name };
    }
  }
  return undefined;
}

export function detectRegisteredActivityFromCommand(
  command: string,
): TerminalActivityInfo | undefined {
  const basename = getBasename(command);
  if (!basename) return undefined;

  for (const [name, registration] of interactiveApps) {
    if (registration.commands?.includes(basename)) {
      return { type: "interactiveApp", name };
    }
  }
  return undefined;
}
