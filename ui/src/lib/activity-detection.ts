import type { TerminalActivityInfo } from "@/stores/terminal-store";
import {
  detectRegisteredActivityFromCommand,
  detectRegisteredActivityFromTitle,
} from "./activity-handler";

export const CODEX_INPUT_PENDING_MARKER = "__codex_input_pending__";

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

/** Detect interactive app from terminal title (OSC 0/2). */
export function detectActivityFromTitle(title: string): TerminalActivityInfo | undefined {
  const registered = detectRegisteredActivityFromTitle(title);
  if (registered) return registered;

  // Skip path-like titles (e.g. "//wsl.localhost/.../python_projects")
  // These can false-positive on app names embedded in directory names
  if (title.includes("/") || title.includes("\\")) return undefined;

  for (const app of STATIC_INTERACTIVE_APPS) {
    // Use word boundary matching to avoid false positives
    // e.g. "vi" should not match "Review", "vim" should not match "environment"
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
  if (text.includes("OpenAI Codex")) {
    return { type: "interactiveApp", name: "Codex" };
  }
  return undefined;
}

export function detectCodexInputPendingFromOutput(text: string): boolean {
  return (
    text.includes("Would you like to run the following command?") ||
    text.includes("Press enter to confirm or esc to cancel") ||
    text.includes("Yes, proceed") ||
    text.includes("No, and tell Codex what to do differently")
  );
}

/** Detect interactive app from command text (OSC 133 E). */
export function detectActivityFromCommand(command: string): TerminalActivityInfo | undefined {
  const registered = detectRegisteredActivityFromCommand(command);
  if (registered) return registered;

  const trimmed = command.trim();
  if (!trimmed) return undefined;

  // Extract the binary name: strip sudo prefix, take basename of first token
  let first = trimmed.split(/\s+/)[0];
  if (first === "sudo" && trimmed.split(/\s+/).length > 1) {
    first = trimmed.split(/\s+/)[1];
  }
  // Strip path prefix: /usr/bin/vim -> vim
  const basename = first.split("/").pop() ?? first;

  for (const app of STATIC_INTERACTIVE_APPS) {
    if (basename === app.command) {
      return { type: "interactiveApp", name: app.name };
    }
  }
  return undefined;
}
