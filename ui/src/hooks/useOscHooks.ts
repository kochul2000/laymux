import { parseOsc, matchHook, type OscHook } from "@/lib/osc-parser";
import { parseIdeCommand, expandHookCommand } from "@/lib/ide-commands";
import { handleIdeMessage } from "@/lib/tauri-api";

/**
 * Regex to find all OSC sequences in terminal output.
 * OSC starts with ESC ] and ends with BEL (\x07) or ST (\x1b\\).
 */
const OSC_REGEX = /\x1b\]\d+;.*?(?:\x07|\x1b\\)/g;

/**
 * Process terminal output for OSC sequences and trigger matching hooks.
 * Called on each chunk of terminal output data.
 */
export function processOscInOutput(
  output: string,
  hooks: OscHook[],
  terminalId: string,
  groupId: string,
): void {
  if (hooks.length === 0) return;

  const matches = output.match(OSC_REGEX);
  if (!matches) return;

  for (const oscStr of matches) {
    const event = parseOsc(oscStr);
    if (!event) continue;

    const matched = matchHook(hooks, event);
    for (const hook of matched) {
      // Build variable context for expansion
      const vars: Record<string, string> = {
        path: event.data,
        data: event.data,
      };

      if (event.code === 133 && event.param === "D") {
        vars.exitCode = event.data;
      }
      if (event.code === 133 && event.param === "E") {
        vars.command = event.data;
        // Extract branch from git commands
        const parts = event.data.split(/\s+/);
        if (parts.length >= 3) {
          vars.branch = parts[parts.length - 1];
        }
      }
      // OSC 9: notification message or ConEmu/WSL CWD (sub-code 9)
      if (event.code === 9) {
        vars.message = event.data;
        // OSC 9;9;<path> is ConEmu/WSL CWD report — strip "9;" prefix for $path
        if (event.data.startsWith("9;")) {
          vars.path = event.data.substring(2);
        }
      }
      if (event.code === 99) {
        vars.message = event.data;
      }
      // OSC 777: format is "notify;title;body"
      if (event.code === 777) {
        const oscParts = event.data.split(";");
        vars.message = oscParts.slice(1).join(";") || event.data;
      }

      const expanded = expandHookCommand(hook.run, vars);
      const parsed = parseIdeCommand(expanded);
      if (!parsed) continue;

      // Convert parsed command to IdeMessage JSON and send via IPC
      const message = buildIdeMessage(parsed, terminalId, groupId);
      if (message) {
        handleIdeMessage(JSON.stringify(message)).catch(() => {});
      }
    }
  }
}

/**
 * Build an IdeMessage-compatible object from a parsed IDE command.
 */
function buildIdeMessage(
  cmd: { action: string; args: string[]; flags: Record<string, string | boolean> },
  terminalId: string,
  groupId: string,
): Record<string, unknown> | null {
  switch (cmd.action) {
    case "sync-cwd":
      return {
        action: "sync-cwd",
        path: cmd.args[0] ?? "",
        terminal_id: terminalId,
        group_id: groupId,
        all: cmd.flags.all === true,
        target_group: typeof cmd.flags.group === "string" ? cmd.flags.group : null,
      };
    case "sync-branch":
      return {
        action: "sync-branch",
        branch: cmd.args[0] ?? "",
        terminal_id: terminalId,
        group_id: groupId,
      };
    case "notify":
      return {
        action: "notify",
        message: cmd.args.join(" "),
        terminal_id: terminalId,
      };
    case "set-tab-title":
      return {
        action: "set-tab-title",
        title: cmd.args.join(" "),
        terminal_id: terminalId,
      };
    case "set-wsl-distro":
      return {
        action: "set-wsl-distro",
        path: cmd.args[0] ?? "",
        terminal_id: terminalId,
      };
    case "open-file":
      return {
        action: "open-file",
        path: cmd.args[0] ?? "",
        terminal_id: terminalId,
      };
    case "set-command-status": {
      const msg: Record<string, unknown> = {
        action: "set-command-status",
        terminal_id: terminalId,
      };
      if (typeof cmd.flags.command === "string") {
        msg.command = cmd.flags.command;
      }
      if (typeof cmd.flags["exit-code"] === "string") {
        msg.exit_code = parseInt(cmd.flags["exit-code"], 10);
      }
      return msg;
    }
    default:
      return null;
  }
}
