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
    if (title.includes(app.title)) {
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
