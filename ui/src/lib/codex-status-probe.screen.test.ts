import { describe, expect, it } from "vitest";
import { createScreenTerminal } from "@/test/screen/xterm-screen";
import { isCodexStatusCommandSelected, isCodexIdleTextComposer } from "./codex-status-probe";
import type { TerminalBufferDump } from "./terminal-serialize-registry";

describe("Codex status command cell guard", () => {
  it("selects the current prefix without clearing previous status output", async () => {
    const surface = createScreenTerminal({ cols: 96, rows: 12 });
    const menu =
      "› /status      show current session configuration and token usage\r\n  /statusline  configure status line\r\n\r\n› /statu\r\n\r\n  GPT-6-Astra · Context 100% left";
    const dump = (): TerminalBufferDump => {
      const buffer = surface.terminal.buffer.active;
      return {
        cols: 96,
        rows: 12,
        baseY: buffer.baseY,
        length: buffer.length,
        lines: Array.from({ length: buffer.length }, (_, index) => ({
          index,
          text: buffer.getLine(index)?.translateToString(true) ?? "",
          isWrapped: buffer.getLine(index)?.isWrapped ?? false,
        })),
      };
    };
    try {
      await surface.write(
        "/status\r\n│ Session: 01a0e103-7bcb-7a20-89c0-2dc0472f2957 │\r\n" + menu,
      );
      expect(isCodexStatusCommandSelected(dump())).toBe(true);
      await surface.write("\x1b[H\x1b[2J" + menu);
      expect(isCodexStatusCommandSelected(dump())).toBe(true);
      await surface.write("\x1b[5;1H  leftover multiline draft");
      expect(isCodexStatusCommandSelected(dump())).toBe(false);
    } finally {
      surface.dispose();
    }
  });
  it("rejects a menu erased by a modal and ignores the same menu in scrollback", async () => {
    const surface = createScreenTerminal({ cols: 96, rows: 8 });
    const menu =
      "\x1b[1;1H› /status      show current session configuration and token usage\r\n  /statusline  configure status line\r\n\r\n› /status\r\n\r\n  GPT-6-Astra · Context 100% left";
    const dump = (): TerminalBufferDump => {
      const term = surface.terminal;
      const buffer = term.buffer.active;
      return {
        cols: term.cols,
        rows: term.rows,
        baseY: buffer.baseY,
        length: buffer.length,
        lines: Array.from({ length: buffer.length }, (_, index) => ({
          index,
          text: buffer.getLine(index)?.translateToString(true) ?? "",
          isWrapped: buffer.getLine(index)?.isWrapped ?? false,
        })),
      };
    };
    try {
      await surface.write(menu);
      expect(isCodexStatusCommandSelected(dump())).toBe(true);
      await surface.write("\x1b[H\x1b[2JTask is still running\r\n› Exit");
      expect(isCodexStatusCommandSelected(dump())).toBe(false);
      await surface.write(
        "\x1b[H\x1b[2JSet up the Codex agent sandbox\r\n› 1. Set up default sandbox\r\n  2. Use non-admin sandbox\r\n\r\n  enter select · esc back",
      );
      expect(isCodexIdleTextComposer(dump())).toBe(false);
      await surface.write("\x1b[H\x1b[2J" + menu + "\r\n".repeat(10) + "› unsent draft");
      expect(isCodexStatusCommandSelected(dump())).toBe(false);
    } finally {
      surface.dispose();
    }
  });
});
