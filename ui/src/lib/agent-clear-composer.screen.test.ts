import { describe, expect, it } from "vitest";
import { createScreenTerminal } from "@/test/screen/xterm-screen";
import { agentClearComposer } from "./agent-clear-composer";
import type { TerminalBufferDump } from "./terminal-serialize-registry";

describe("실제 xterm 입력창 clear 판독", () => {
  it.each(["Claude", "Codex"] as const)(
    "%s의 여러 줄 초안, 빈 입력창, 모달을 구분한다",
    async (provider) => {
      const surface = createScreenTerminal({ cols: 96, rows: 12 });
      const dump = (): TerminalBufferDump => {
        const term = surface.terminal;
        const b = term.buffer.active;
        return {
          cols: term.cols,
          rows: term.rows,
          length: b.length,
          baseY: b.baseY,
          lines: Array.from({ length: b.length }, (_, index) => ({
            index,
            text: b.getLine(index)?.translateToString(true) ?? "",
            isWrapped: b.getLine(index)?.isWrapped ?? false,
          })),
        };
      };
      const frame = (text: string) =>
        provider === "Codex"
          ? `› ${text}\r\n\r\n  GPT-6.1-Sol · Context 100% left`
          : `────────────────────────\r\n> ${text}\r\n────────────────────────\r\n  ⏵⏵ auto mode on`;
      try {
        await surface.write(frame("draft\r\n  second line"));
        expect(agentClearComposer(dump(), provider)).toBe("draft");
        await surface.write("\x1b[H\x1b[2J" + frame(""));
        expect(agentClearComposer(dump(), provider)).toBe("empty");
        await surface.write(
          "\x1b[H\x1b[2J" + "Do you want to run this?\r\n❯ 1. Yes\r\n  2. No\r\n  esc to cancel",
        );
        expect(agentClearComposer(dump(), provider)).toBe("unsupported");
        // Old prompts in scrollback never authorize a menu currently on screen.
        await surface.write("\r\n".repeat(15) + "Select model\r\nenter confirm · esc back");
        expect(agentClearComposer(dump(), provider)).toBe("unsupported");
      } finally {
        surface.dispose();
      }
    },
  );
});
