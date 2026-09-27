import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { withCodexStatusCheckpoint } from "./codex-status-probe";
import {
  registerTerminalInspector,
  unregisterTerminalInspector,
} from "./terminal-serialize-registry";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const calls: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
});

describe("fenced Codex checkpoint", () => {
  it("does not touch a terminal when the option is disabled", async () => {
    await expect(withCodexStatusCheckpoint(false, undefined, async () => 7)).resolves.toBe(7);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("holds the proof until the checkpoint is committed and always releases it", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      calls.push(command);
      if (command === "begin_codex_status_checkpoint") return { token: "proof", targets: [] };
      return undefined;
    });
    await withCodexStatusCheckpoint(true, 42, async () => {
      calls.push("commit");
    });
    expect(invoke).toHaveBeenCalledWith("begin_codex_status_checkpoint", { updateRequestId: 42 });
    expect(calls).toEqual([
      "begin_codex_status_checkpoint",
      "commit",
      "complete_codex_status_checkpoint",
      "finish_codex_status_checkpoint",
    ]);
  });

  it("does not report a delayed save as successful after its proof expires", async () => {
    vi.mocked(invoke).mockImplementation(async (command) => {
      if (command === "begin_codex_status_checkpoint") return { token: "proof", targets: [] };
      if (command === "complete_codex_status_checkpoint") throw new Error("checkpoint expired");
    });
    await expect(withCodexStatusCheckpoint(true, undefined, async () => 7)).rejects.toThrow(
      "expired",
    );
    expect(invoke).toHaveBeenLastCalledWith("finish_codex_status_checkpoint", { token: "proof" });
  });

  it("refuses a running task before sending any key and skips the save", async () => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "begin_codex_status_checkpoint"
        ? { token: "proof", targets: [{ terminalId: "terminal-p", cols: 96, rows: 40 }] }
        : undefined,
    );
    const text = ["Working (esc to interrupt)", "› draft", ""];
    registerTerminalInspector("terminal-p", () => ({
      cols: 96,
      rows: 40,
      baseY: 0,
      length: 40,
      lines: text.map((text, index) => ({ index, text, isWrapped: false })),
    }));
    const commit = vi.fn();
    try {
      await expect(withCodexStatusCheckpoint(true, undefined, commit)).rejects.toThrow(
        "idle text composer",
      );
      expect(commit).not.toHaveBeenCalled();
      expect(invoke).not.toHaveBeenCalledWith("codex_status_checkpoint_input", expect.anything());
      expect(invoke).toHaveBeenLastCalledWith("finish_codex_status_checkpoint", { token: "proof" });
    } finally {
      unregisterTerminalInspector("terminal-p");
    }
  });

  it("releases the proof and restores geometry when persistence fails", async () => {
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "begin_codex_status_checkpoint" ? { token: "proof", targets: [] } : undefined,
    );
    await expect(
      withCodexStatusCheckpoint(true, undefined, async () => {
        throw new Error("disk full");
      }),
    ).rejects.toThrow("disk full");
    expect(invoke).toHaveBeenLastCalledWith("finish_codex_status_checkpoint", { token: "proof" });
  });
});
