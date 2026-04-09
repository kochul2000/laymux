import type { TerminalActivityInfo } from "@/stores/terminal-store";
import {
  detectRegisteredActivityFromCommand,
  detectRegisteredActivityFromTitle,
} from "./activity-handler";

export const CODEX_INPUT_PENDING_MARKER = "__codex_input_pending__";
const MIDDLE_DOT = "\u00b7";
const ASSISTANT_BULLET = "\u2022";

/** Known interactive apps without dedicated provider handlers. */
const STATIC_INTERACTIVE_APPS: { title: string; command: string; name: string }[] = [
  { title: "nvim", command: "nvim", name: "neovim" },
  { title: "vim", command: "vim", name: "vim" },
  { title: "vi", command: "vi", name: "vim" },
  { title: "nano", command: "nano", name: "nano" },
  { title: "htop", command: "htop", name: "htop" },
  { title: "btop", command: "btop", name: "btop" },
  { title: "less", command: "less", name: "less" },
  { title: "python3", command: "python3", name: "python" },
  { title: "python", command: "python", name: "python" },
  { title: "node", command: "node", name: "node" },
  { title: "ipython", command: "ipython", name: "ipython" },
];

function normalizeOutputLines(text: string): string[] {
  return text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function isCodexFooterStatusLine(line: string): boolean {
  const parts = line.split(new RegExp(`\\s+${MIDDLE_DOT}\\s+`));
  return (
    parts.length >= 3 &&
    /\b\d+% left\b/i.test(parts[1] ?? "") &&
    /(^gpt-|^o[134]\b|^codex\b)/i.test(parts[0] ?? "") &&
    Boolean(parts[2])
  );
}

export function isCodexAssistantMessage(line: string): boolean {
  if (!line.startsWith(`${ASSISTANT_BULLET} `)) return false;
  const message = line.slice(2).trim();
  if (!message) return false;
  if (
    message.startsWith("Ran ") ||
    message.startsWith("Running ") ||
    message.startsWith("Reason:") ||
    message.startsWith("Would you like to run") ||
    message.startsWith("Press enter to confirm") ||
    message.startsWith("Yes, proceed") ||
    message.startsWith("No, and tell Codex") ||
    message.startsWith("Tip:")
  ) {
    return false;
  }
  return true;
}

/** Detect interactive app from terminal title (OSC 0/2). */
export function detectActivityFromTitle(title: string): TerminalActivityInfo | undefined {
  const registered = detectRegisteredActivityFromTitle(title);
  if (registered) return registered;

  if (title.includes("/") || title.includes("\\")) return undefined;

  for (const app of STATIC_INTERACTIVE_APPS) {
    const pattern = new RegExp(
      `(?:^|[\\s\\-:])${app.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[\\s\\-:])`,
    );
    if (pattern.test(title) || title === app.title) {
      return { type: "interactiveApp", name: app.name };
    }
  }
  return undefined;
}

/** Detect interactive app from raw output text when command/title signals are unavailable. */
export function detectActivityFromOutput(text: string): TerminalActivityInfo | undefined {
  const lines = normalizeOutputLines(text);
  const hasCodexBanner = lines.some((line) => /^>[-\s]*OpenAI Codex \(v[^\s)]+\)$/i.test(line));
  const hasCodexSessionMetadata = lines.some(
    (line) => /^model:\s+/i.test(line) || /^directory:\s+/i.test(line),
  );
  if (hasCodexBanner && hasCodexSessionMetadata) {
    return { type: "interactiveApp", name: "Codex" };
  }
  return undefined;
}

export function detectCodexInputPendingFromOutput(text: string): boolean {
  return (
    text.includes("Would you like to run the following command?") ||
    text.includes("Press enter to confirm or esc to cancel") ||
    text.includes("command?") ||
    text.includes("confirm or esc to cancel") ||
    text.includes("esc to cancel") ||
    text.includes("to cancel") ||
    text.includes("Reason:") ||
    text.includes("Would you like to run") ||
    text.includes("Yes, proceed") ||
    text.includes("No, and tell Codex what to do differently") ||
    text.includes("tell Codex what to do differently")
  );
}

export function detectCodexConversationMessageFromOutput(text: string): string | undefined {
  const lines = normalizeOutputLines(text);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!isCodexAssistantMessage(line)) continue;
    return line.slice(2).trim();
  }
  return undefined;
}

export function detectCodexStatusMessageFromOutput(text: string): string | undefined {
  const lines = normalizeOutputLines(text);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (isCodexFooterStatusLine(line)) {
      return line;
    }
  }
  return undefined;
}

/** Detect interactive app from command text (OSC 133 E). */
export function detectActivityFromCommand(command: string): TerminalActivityInfo | undefined {
  const registered = detectRegisteredActivityFromCommand(command);
  if (registered) return registered;

  const trimmed = command.trim();
  if (!trimmed) return undefined;

  let first = trimmed.split(/\s+/)[0];
  if (first === "sudo" && trimmed.split(/\s+/).length > 1) {
    first = trimmed.split(/\s+/)[1];
  }
  const basename = first.split("/").pop() ?? first;

  for (const app of STATIC_INTERACTIVE_APPS) {
    if (basename === app.command) {
      return { type: "interactiveApp", name: app.name };
    }
  }
  return undefined;
}
