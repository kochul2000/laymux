import { parseOsc, matchHook, type OscHook } from "@/lib/osc-parser";
import { parseLxCommand, expandHookCommand } from "@/lib/lx-commands";
import { handleLxMessage } from "@/lib/tauri-api";

/**
 * Regex to find all OSC sequences in terminal output.
 * OSC starts with ESC ] and ends with BEL (\x07) or ST (\x1b\\).
 */
const OSC_REGEX = /\x1b\]\d+;.*?(?:\x07|\x1b\\)/g;

/**
 * Process terminal output for OSC sequences and trigger matching hooks.
 * Called on each chunk of terminal output data.
 *
 * `notifyGate` controls notification suppression: when provided, notify
 * actions are only dispatched after a user command has been observed
 * (OSC 133;C or 133;E). This prevents shell-init OSC 133;D sequences
 * from flooding notifications on startup (see issue #111).
 */
export function processOscInOutput(
  output: string,
  hooks: OscHook[],
  terminalId: string,
  groupId: string,
  options?: { skipSyncCwd?: boolean; notifyGate?: NotifyGate },
): void {
  if (hooks.length === 0) return;

  const matches = output.match(OSC_REGEX);
  if (!matches) return;

  for (const oscStr of matches) {
    const event = parseOsc(oscStr);
    if (!event) continue;

    // Track user command execution: OSC 133;C (preexec) or 133;E (command text)
    // signals a real user command, which arms the notify gate.
    if (
      options?.notifyGate &&
      !options.notifyGate.armed &&
      event.code === 133 &&
      (event.param === "C" || event.param === "E")
    ) {
      options.notifyGate.armed = true;
      if (options.notifyGate.fallbackTimer !== undefined) {
        clearTimeout(options.notifyGate.fallbackTimer);
        options.notifyGate.fallbackTimer = undefined;
      }
    }

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
      const parsed = parseLxCommand(expanded);
      if (!parsed) continue;

      // Convert parsed command to LxMessage JSON and send via IPC
      const message = buildLxMessage(parsed, terminalId, groupId);
      if (message) {
        if (options?.skipSyncCwd && message.action === "sync-cwd") continue;
        if (options?.notifyGate && !options.notifyGate.armed && message.action === "notify")
          continue;
        handleLxMessage(JSON.stringify(message)).catch(() => {});
      }
    }
  }
}

/**
 * Mutable gate object: notify actions are suppressed until `armed` becomes true.
 * Armed by either:
 * - OSC 133;C/E (user command execution) — immediate, cancels fallback timer
 * - Fallback timer — for shells without preexec (e.g. PowerShell)
 */
export interface NotifyGate {
  armed: boolean;
  fallbackTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Build an LxMessage-compatible object from a parsed IDE command.
 */
function buildLxMessage(
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
    case "notify": {
      const notifyMsg: Record<string, unknown> = {
        action: "notify",
        message: cmd.args.join(" "),
        terminal_id: terminalId,
      };
      if (typeof cmd.flags.level === "string") {
        notifyMsg.level = cmd.flags.level;
      }
      return notifyMsg;
    }
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
