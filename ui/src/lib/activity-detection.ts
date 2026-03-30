import type { TerminalActivityInfo } from "@/stores/terminal-store";

/** Known interactive apps: [titlePattern, displayName, commandName?] */
const INTERACTIVE_APPS: { title: string; command: string; name: string }[] = [
  { title: "Claude Code", command: "claude", name: "Claude" },
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
  // Skip path-like titles (e.g. "//wsl.localhost/.../python_projects")
  // These can false-positive on app names embedded in directory names
  if (title.includes("/") || title.includes("\\")) return undefined;

  for (const app of INTERACTIVE_APPS) {
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

/** Detect interactive app from command text (OSC 133 E). */
export function detectActivityFromCommand(command: string): TerminalActivityInfo | undefined {
  const trimmed = command.trim();
  if (!trimmed) return undefined;

  // Extract the binary name: strip sudo prefix, take basename of first token
  let first = trimmed.split(/\s+/)[0];
  if (first === "sudo" && trimmed.split(/\s+/).length > 1) {
    first = trimmed.split(/\s+/)[1];
  }
  // Strip path prefix: /usr/bin/vim → vim
  const basename = first.split("/").pop() ?? first;

  for (const app of INTERACTIVE_APPS) {
    if (basename === app.command) {
      return { type: "interactiveApp", name: app.name };
    }
  }
  return undefined;
}

export type ClaudeMode = "idle" | "working" | "plan" | "danger";

/**
 * Parse Claude Code mode from terminal title.
 *
 * Claude Code embeds status in its terminal title:
 * - ✳ prefix = idle (accept edits)
 * - spinner prefix = working
 * - Title may contain mode keywords: "Plan mode", "Danger", etc.
 *
 * Returns undefined if not a Claude terminal.
 */
export function parseClaudeMode(
  title: string | undefined,
  activity: TerminalActivityInfo | undefined,
): ClaudeMode | undefined {
  if (activity?.type !== "interactiveApp" || activity.name !== "Claude") return undefined;
  if (!title) return "idle";

  // Priority: plan > danger > idle/working.
  // Claude Code title may contain both mode keywords and idle/working prefix.
  // We check mode keywords first so "✳ Plan: approach" returns "plan", not "idle".
  if (/\bplan\b/i.test(title)) return "plan";
  if (/\bdanger\b/i.test(title)) return "danger";

  // Idle vs working based on prefix character
  if (isClaudeIdle(title)) return "idle";
  return "working";
}

/**
 * Check if the title indicates Ralph (autonomous loop) is active.
 * Ralph loop sets titles like "✶ Ralph: fixing bugs" or "✳ Ralph loop active".
 * We match "Ralph:" or "Ralph loop" to avoid false positives from file/variable names.
 */
export function isRalphActive(title: string | undefined): boolean {
  if (!title) return false;
  return /\bRalph[:\s]+(loop\b|[^)]*)/i.test(title);
}

export type ClaudeTaskTransition = "started" | "completed";

/** Claude Code idle prefix: ✳ (U+2733) */
const CLAUDE_IDLE_CHAR = "\u2733";
/** Garbled ✳ when UTF-8 E2 9C B3 is mis-decoded (Windows CP949 path) */
const CLAUDE_IDLE_GARBLED = "\udce2\uc454";

/** Check if a title represents Claude Code idle state. */
export function isClaudeIdle(title: string): boolean {
  return title.startsWith(CLAUDE_IDLE_CHAR) || title.startsWith(CLAUDE_IDLE_GARBLED);
}

/** Strip the prefix character (✳ or spinner) from a Claude title to extract the task description. */
export function extractClaudeTaskDesc(title: string): string {
  // Strip idle prefix (correct or garbled)
  let result = title.replace(/^\u2733\s*/, ""); // ✳ (correct UTF-8)
  result = result.replace(/^\udce2\uc454\s*/, ""); // garbled ✳
  // If still has a single non-ASCII prefix char (spinner like ✶✻✽✢·), strip it
  if (result === title) {
    result = result.replace(/^[^\x20-\x7E]\s*/, ""); // strip one non-ASCII char + space
  }
  return result.trim();
}

/** Generic idle titles that don't represent a real task. */
const GENERIC_IDLE_TITLES = ["Claude Code", "claude", ""];

/** Check if a title is a generic idle title (not a task description). */
export function isGenericClaudeTitle(taskDesc: string): boolean {
  return GENERIC_IDLE_TITLES.includes(taskDesc);
}

/**
 * Extract a meaningful notification message for Claude task completion.
 *
 * Tries the previous title first (contains the actual task description from the spinner),
 * falls back to the new title, then to a default message.
 */
export function getClaudeCompletionMessage(
  previousTitle: string | undefined,
  newTitle: string,
): string {
  if (previousTitle) {
    const prevDesc = extractClaudeTaskDesc(previousTitle);
    if (!isGenericClaudeTitle(prevDesc)) return prevDesc;
  }
  const newDesc = extractClaudeTaskDesc(newTitle);
  if (!isGenericClaudeTitle(newDesc)) return newDesc;
  return "Claude task completed";
}

/**
 * Detect Claude Code task state transitions from title changes.
 *
 * Claude Code uses spinner characters (✶✻✽✢*·) while working and ✳ when idle.
 * Returns "started" when idle→working, "completed" when working→idle, null otherwise.
 */
export function detectClaudeTaskTransition(
  previousTitle: string | undefined,
  newTitle: string,
  activity: TerminalActivityInfo | undefined,
): ClaudeTaskTransition | null {
  if (activity?.type !== "interactiveApp" || activity.name !== "Claude") return null;
  if (previousTitle === undefined) return null;

  const wasIdle = isClaudeIdle(previousTitle);
  const nowIdle = isClaudeIdle(newTitle);

  if (!wasIdle && nowIdle) return "completed";
  if (wasIdle && !nowIdle) return "started";

  return null;
}
