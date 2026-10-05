import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { withCodexStatusCheckpoint } from "./codex-status-probe";
import { registerCheckpointGeometry } from "./terminal-checkpoint-geometry";
import { useWorkspaceStore } from "@/stores/workspace-store";
import i18n from "@/i18n";
import {
  registerTerminalInspector,
  registerTerminalRenderCheckpointProvider,
  unregisterTerminalInspector,
  unregisterTerminalRenderCheckpointProvider,
} from "./terminal-serialize-registry";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const calls: string[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
});

describe("fenced Codex checkpoint", () => {
  it.each([
    { repainting: false, slow: false },
    { repainting: true, slow: false },
    { repainting: false, slow: true },
  ])(
    "submits once and saves the current screen (%j)",
    async ({ repainting, slow }) => {
      let time = Date.now();
      const clock = slow ? vi.spyOn(Date, "now").mockImplementation(() => time) : undefined;
      const id = "terminal-current-screen";
      const releaseGeometry = registerCheckpointGeometry(id, () => {});
      let selected = false;
      let empty = false;
      const boundary = { generation: 9, seq: 120, geometry: { revision: 3, cols: 96, rows: 40 } };
      const current = { ...boundary, seq: 140, data: "unchanged Session cells plus new composer" };
      const capture = vi.fn(async () => {
        if (slow) time += 200;
        if (repainting) current.seq += 1;
        return { ...current };
      });
      registerTerminalRenderCheckpointProvider(id, capture);
      registerTerminalInspector(id, () => {
        const lines = selected
          ? [
              "/status",
              "│ Session: previous │",
              "› /status      show current session configuration",
              "",
              "› /statu",
              "",
            ]
          : [empty ? "› Ask Codex to do anything" : "› draft", ""];
        return {
          cols: 96,
          rows: 40,
          length: 40,
          baseY: 0,
          lines: lines.map((text, index) => ({ index, text, isWrapped: false })),
        };
      });
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        calls.push(command);
        if (command === "begin_codex_status_checkpoint")
          return { token: "proof", targets: [{ terminalId: id, cols: 96, rows: 40 }] };
        if (command === "codex_status_checkpoint_input") {
          const step = (args as { step: string }).step;
          if (step === "clear") empty = true;
          if (step === "typeStatus") selected = true;
          if (step === "submit") {
            if (slow) time += 9_000;
            return boundary;
          }
          return null;
        }
        if (command === "read_codex_status_checkpoint")
          return "01a0e103-7bcb-7a20-89c0-2dc0472f2957";
      });
      const commit = vi.fn(async () => {
        calls.push("save");
      });
      try {
        await withCodexStatusCheckpoint(true, undefined, commit);
        expect(capture).toHaveBeenCalledWith({ ...boundary, seq: 121 }, 0);
        expect(invoke).toHaveBeenCalledWith("read_codex_status_checkpoint", {
          token: "proof",
          terminalId: id,
          screen: current,
        });
        expect(
          vi
            .mocked(invoke)
            .mock.calls.filter(
              ([command, args]) =>
                command === "codex_status_checkpoint_input" &&
                (args as { step: string }).step === "submit",
            ),
        ).toHaveLength(1);
        expect(calls.indexOf("read_codex_status_checkpoint")).toBeLessThan(calls.indexOf("save"));
        expect(commit).toHaveBeenCalledOnce();
      } finally {
        unregisterTerminalInspector(id);
        unregisterTerminalRenderCheckpointProvider(id);
        releaseGeometry();
        clock?.mockRestore();
      }
    },
    10000,
  );
  it("reports the actual pane and manual retry advice when discovery fails before a token exists", async () => {
    await i18n.changeLanguage("ko");
    useWorkspaceStore.setState({
      workspaces: [
        {
          id: "ws-check",
          name: "서버",
          panes: [
            {
              id: "ambiguous",
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              view: { type: "TerminalView", profile: "WSL" },
            },
          ],
        },
      ],
    });
    vi.mocked(invoke).mockRejectedValue("Ambiguous WSL Codex process [terminal-ambiguous]");
    const commit = vi.fn();
    await expect(withCodexStatusCheckpoint(true, 42, commit)).rejects.toThrow(
      "서버 · pane 1 · WSL",
    );
    await expect(withCodexStatusCheckpoint(true, 42, commit)).rejects.toThrow(
      "수동으로 종료한 뒤 다시 시도",
    );
    expect(commit).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(invoke)
        .mock.calls.every(([command]) => command === "begin_codex_status_checkpoint"),
    ).toBe(true);
  });
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
