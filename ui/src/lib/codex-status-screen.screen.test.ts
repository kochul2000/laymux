import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createScreenTerminal } from "@/test/screen/xterm-screen";
import { TerminalRenderCheckpointModel } from "./terminal-render-checkpoint";
import { isCodexStatusCommandSelected } from "./codex-status-probe";
import type { TerminalBufferDump } from "./terminal-serialize-registry";

describe("Codex repeated status screen", () => {
  it("keeps the complete 0.160.1 background-server card from the reproduced dev timeout", async () => {
    const fixture = JSON.parse(
      readFileSync(
        resolve(
          process.cwd(),
          "../src-tauri/src/commands/codex_session/status_probe/fixtures/native-1601-server-render-checkpoint.json",
        ),
        "utf8",
      ),
    );
    const surface = createScreenTerminal(fixture.screen.geometry);
    try {
      await surface.write(fixture.screen.data);
      const buffer = surface.terminal.buffer.active;
      const lines = Array.from(
        { length: buffer.length },
        (_, i) => buffer.getLine(i)?.translateToString(true) ?? "",
      );
      const response = lines.slice(lines.lastIndexOf("/status") + 1).join("\n");
      expect(response).toContain("Server:");
      expect(response).toContain("Local background server");
      expect(response).toContain(fixture.id);
      expect(response).toContain("› Ask Codex to do anything");
    } finally {
      surface.dispose();
    }
  });
  it.each(["native", "wsl"])(
    "captures unchanged Session cells after the real %s differential response",
    async (host) => {
      const fixture = JSON.parse(
        readFileSync(
          resolve(
            process.cwd(),
            `../src-tauri/src/commands/codex_session/status_probe/fixtures/${host}-status-current-screen.json`,
          ),
          "utf8",
        ),
      ) as { cols: number; rows: number; selected: string[]; response: number[]; id: string };
      const selected = fixture.selected
        .map((line, index) => `\x1b[${index + 1};1H${line}`)
        .join("");
      const encoder = new TextEncoder();
      const before = encoder.encode(selected);
      const data = Uint8Array.from(fixture.response);
      expect(new TextDecoder().decode(data)).not.toContain(fixture.id);
      const geometry = { revision: 1, cols: fixture.cols, rows: fixture.rows };
      const model = new TerminalRenderCheckpointModel();
      try {
        await model.attach({
          state: {
            version: 1,
            generation: 3,
            snapshotStartSeq: 0,
            snapshotSeq: before.length,
            sourceStartSeq: 0,
            sourceSeq: before.length,
            snapshotKind: "raw",
            protocolRevision: 0,
            modes: { bracketedPaste: true },
            geometry,
          },
          snapshot: before,
        });
        await model.apply({
          generation: 3,
          seqStart: before.length,
          seqEnd: before.length + data.length,
          geometry,
          data,
        });
        const screen = await model.capture(
          { generation: 3, seq: before.length + data.length, geometry },
          0,
        );
        expect(screen.data).toContain(fixture.id);
        expect(screen.data).not.toContain("› /statu");
      } finally {
        model.dispose();
      }
    },
  );
  it("can select a new status command while an earlier card remains visible", async () => {
    const surface = createScreenTerminal({ cols: 96, rows: 40 });
    try {
      await surface.write(
        "/status\r\n│ Session: 01a0e103-7bcb-7a20-89c0-2dc0472f2957 │\r\n" +
          "› /status      show current session configuration and token usage\r\n\r\n› /statu\r\n\r\n  Context 100% left",
      );
      const buffer = surface.terminal.buffer.active;
      const screen: TerminalBufferDump = {
        cols: 96,
        rows: 40,
        baseY: buffer.baseY,
        length: buffer.length,
        lines: Array.from({ length: buffer.length }, (_, index) => ({
          index,
          text: buffer.getLine(index)?.translateToString(true) ?? "",
          isWrapped: buffer.getLine(index)?.isWrapped ?? false,
        })),
      };
      expect(isCodexStatusCommandSelected(screen)).toBe(true);
    } finally {
      surface.dispose();
    }
  });
});
