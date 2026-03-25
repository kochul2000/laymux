import { describe, it, expect, vi, beforeEach } from "vitest";
import { processOscInOutput } from "./useOscHooks";
import type { OscHook } from "@/lib/osc-parser";

vi.mock("@/lib/tauri-api", () => ({
  handleIdeMessage: vi.fn().mockResolvedValue({ success: true }),
}));

import { handleIdeMessage } from "@/lib/tauri-api";
const mockHandleIdeMessage = vi.mocked(handleIdeMessage);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processOscInOutput", () => {
  const hooks: OscHook[] = [
    {
      osc: 7,
      run: "ide sync-cwd $path",
    },
    {
      osc: 133,
      param: "D",
      when: "exitCode !== '0'",
      run: "ide notify 'Command failed (exit $exitCode)'",
    },
    {
      osc: 133,
      param: "E",
      when:
        "command.startsWith('git switch') || command.startsWith('git checkout')",
      run: "ide sync-branch $branch",
    },
  ];

  it("detects OSC 7 in output and triggers sync-cwd", () => {
    const output = "some text\x1b]7;file://localhost/home/user\x07more text";
    processOscInOutput(output, hooks, "t1", "g1");

    expect(mockHandleIdeMessage).toHaveBeenCalledTimes(1);
    const call = JSON.parse(mockHandleIdeMessage.mock.calls[0][0]);
    expect(call.action).toBe("sync-cwd");
    expect(call.path).toBe("file://localhost/home/user");
  });

  it("detects OSC 133 D with non-zero exit and triggers notify", () => {
    const output = "\x1b]133;D;1\x07";
    processOscInOutput(output, hooks, "t1", "g1");

    expect(mockHandleIdeMessage).toHaveBeenCalledTimes(1);
    const call = JSON.parse(mockHandleIdeMessage.mock.calls[0][0]);
    expect(call.action).toBe("notify");
    expect(call.message).toContain("Command failed");
  });

  it("passes --level flag in notify message", () => {
    const levelHooks: OscHook[] = [
      { osc: 133, param: "D", when: "exitCode === '0'", run: "ide notify --level success 'Command completed'" },
      { osc: 133, param: "D", when: "exitCode !== '0'", run: "ide notify --level error 'Command failed (exit $exitCode)'" },
    ];
    const output = "\x1b]133;D;0\x07";
    processOscInOutput(output, levelHooks, "t1", "g1");

    expect(mockHandleIdeMessage).toHaveBeenCalledTimes(1);
    const call = JSON.parse(mockHandleIdeMessage.mock.calls[0][0]);
    expect(call.action).toBe("notify");
    expect(call.level).toBe("success");
  });

  it("does not trigger notify for exit code 0", () => {
    const output = "\x1b]133;D;0\x07";
    processOscInOutput(output, hooks, "t1", "g1");

    expect(mockHandleIdeMessage).not.toHaveBeenCalled();
  });

  it("detects OSC 133 E git switch and triggers sync-branch", () => {
    const output = "\x1b]133;E;git switch feature/login\x07";
    processOscInOutput(output, hooks, "t1", "g1");

    expect(mockHandleIdeMessage).toHaveBeenCalledTimes(1);
    const call = JSON.parse(mockHandleIdeMessage.mock.calls[0][0]);
    expect(call.action).toBe("sync-branch");
  });

  it("does nothing for output without OSC sequences", () => {
    processOscInOutput("hello world", hooks, "t1", "g1");
    expect(mockHandleIdeMessage).not.toHaveBeenCalled();
  });

  it("does nothing when hooks list is empty", () => {
    const output = "\x1b]7;file:///foo\x07";
    processOscInOutput(output, [], "t1", "g1");
    expect(mockHandleIdeMessage).not.toHaveBeenCalled();
  });

  it("handles OSC 9 notification sequences", () => {
    const notifyHooks: OscHook[] = [
      { osc: 9, run: "ide notify $message" },
    ];
    const output = "\x1b]9;Build complete\x07";
    processOscInOutput(output, notifyHooks, "t1", "g1");

    expect(mockHandleIdeMessage).toHaveBeenCalledTimes(1);
    const call = JSON.parse(mockHandleIdeMessage.mock.calls[0][0]);
    expect(call.action).toBe("notify");
    expect(call.message).toBe("Build complete");
  });

  it("handles OSC 99 notification sequences", () => {
    const notifyHooks: OscHook[] = [
      { osc: 99, run: "ide notify $message" },
    ];
    const output = "\x1b]99;Deploy finished\x07";
    processOscInOutput(output, notifyHooks, "t1", "g1");

    expect(mockHandleIdeMessage).toHaveBeenCalledTimes(1);
    const call = JSON.parse(mockHandleIdeMessage.mock.calls[0][0]);
    expect(call.action).toBe("notify");
    expect(call.message).toBe("Deploy finished");
  });

  it("handles OSC 777 notification sequences", () => {
    const notifyHooks: OscHook[] = [
      { osc: 777, run: "ide notify $message" },
    ];
    const output = "\x1b]777;notify;Title;Body text\x07";
    processOscInOutput(output, notifyHooks, "t1", "g1");

    expect(mockHandleIdeMessage).toHaveBeenCalledTimes(1);
    const call = JSON.parse(mockHandleIdeMessage.mock.calls[0][0]);
    expect(call.action).toBe("notify");
    expect(call.message).toBe("Title;Body text");
  });

  it("handles OSC 9;9 ConEmu/WSL CWD as sync-cwd, not notification", () => {
    const cwdHook: OscHook[] = [
      { osc: 9, when: "message.startsWith('9;')", run: "ide sync-cwd $path" },
    ];
    const output = "\x1b]9;9;//wsl.localhost/Ubuntu-22.04/home/user\x07";
    processOscInOutput(output, cwdHook, "t1", "g1");

    expect(mockHandleIdeMessage).toHaveBeenCalledTimes(1);
    const call = JSON.parse(mockHandleIdeMessage.mock.calls[0][0]);
    expect(call.action).toBe("sync-cwd");
    // Path should strip the "9;" prefix
    expect(call.path).toBe("//wsl.localhost/Ubuntu-22.04/home/user");
  });

  it("handles OSC 133 C (preexec) → set-command-status with command", () => {
    const preexecHooks: OscHook[] = [
      { osc: 133, param: "C", run: "ide set-command-status --command __preexec__" },
    ];
    const output = "\x1b]133;C\x07";
    processOscInOutput(output, preexecHooks, "t1", "g1");

    expect(mockHandleIdeMessage).toHaveBeenCalledTimes(1);
    const call = JSON.parse(mockHandleIdeMessage.mock.calls[0][0]);
    expect(call.action).toBe("set-command-status");
    expect(call.terminal_id).toBe("t1");
    expect(call.command).toBe("__preexec__");
    expect(call.exit_code).toBeUndefined();
  });

  it("handles OSC 133 D → set-command-status with exit-code", () => {
    const resultHooks: OscHook[] = [
      { osc: 133, param: "D", run: "ide set-command-status --exit-code $exitCode" },
    ];
    const output = "\x1b]133;D;0\x07";
    processOscInOutput(output, resultHooks, "t1", "g1");

    expect(mockHandleIdeMessage).toHaveBeenCalledTimes(1);
    const call = JSON.parse(mockHandleIdeMessage.mock.calls[0][0]);
    expect(call.action).toBe("set-command-status");
    expect(call.terminal_id).toBe("t1");
    expect(call.exit_code).toBe(0);
    expect(call.command).toBeUndefined();
  });

  it("handles OSC 133 E → set-command-status with command text", () => {
    const trackHooks: OscHook[] = [
      { osc: 133, param: "E", run: 'ide set-command-status --command "$command"' },
    ];
    const output = "\x1b]133;E;npm test\x07";
    processOscInOutput(output, trackHooks, "t1", "g1");

    expect(mockHandleIdeMessage).toHaveBeenCalledTimes(1);
    const call = JSON.parse(mockHandleIdeMessage.mock.calls[0][0]);
    expect(call.action).toBe("set-command-status");
    expect(call.command).toBe("npm test");
  });
});
