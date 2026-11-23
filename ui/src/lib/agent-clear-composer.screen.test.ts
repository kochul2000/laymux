import { describe, expect, it } from "vitest";
import { createScreenTerminal } from "@/test/screen/xterm-screen";
import { agentClearComposer } from "./agent-clear-composer";
import type { TerminalBufferDump } from "./terminal-serialize-registry";
import type { Terminal } from "@xterm/xterm";

function dump(term: Terminal): TerminalBufferDump {
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
}

describe("실제 xterm 입력창 clear 판독", () => {
  it("Codex 첫 실행의 context 없는 모델 상태줄에서도 입력창을 확인한다", async () => {
    const surface = createScreenTerminal({ cols: 51, rows: 36 });
    const frame = (text: string) =>
      "  >_ OpenAI Codex (v0.167.0)\r\n" +
      "     D:\\PycharmProjects\\laymux\r\n\r\n" +
      `› ${text}\r\n \r\n` +
      "  GPT-6.1-Sol high Fast · …  ⚠ 1 warning · f2 to view";
    try {
      await surface.write(frame("Ask Codex to do anything"));
      expect(agentClearComposer(dump(surface.terminal), "Codex")).toBe("empty");
      await surface.write("\x1b[H\x1b[2J" + frame("첫 초안\r\n  두 번째 줄"));
      expect(agentClearComposer(dump(surface.terminal), "Codex")).toBe("draft");
      await surface.write("\r\n  enter to confirm · esc to cancel");
      expect(agentClearComposer(dump(surface.terminal), "Codex")).toBe("unsupported");
    } finally {
      surface.dispose();
    }
  });

  it.each([
    [48, "  GPT-6.2-Astra max · Context 94% left · Ask fo…"],
    [95, "  GPT-6.2-Astra max · Context 94% left · Ask for approval"],
  ] as const)(
    "Codex %i열에서 초안을 지워 두 줄 상태 표시가 나타나면 빈 입력창이다",
    async (cols, status) => {
      const surface = createScreenTerminal({ cols, rows: 12 });
      const hint = "  ← for agents · ? for shortcuts";
      try {
        await surface.write(`› LAYMUX-DIAG-X\r\n\r\n${status}`);
        expect(agentClearComposer(dump(surface.terminal), "Codex")).toBe("draft");
        await surface.write(`\x1b[H\x1b[2J› Ask Codex to do anything\r\n\r\n${status}\r\n${hint}`);
        expect(agentClearComposer(dump(surface.terminal), "Codex")).toBe("empty");
      } finally {
        surface.dispose();
      }
    },
  );

  it("Codex 상태줄처럼 보이는 여러 줄 초안과 상태 표시의 중단 안내를 보호한다", async () => {
    const surface = createScreenTerminal({ cols: 95, rows: 12 });
    const status = "  GPT-6.2-Astra max · Context 94% left";
    const hint = "  ? for shortcuts";
    try {
      await surface.write(
        `›\r\n\r\n  Context in a draft\r\n${status}\r\n${hint}\r\n\r\n${status}\r\n${hint}`,
      );
      expect(agentClearComposer(dump(surface.terminal), "Codex")).toBe("draft");
      await surface.write(`\x1b[H\x1b[2J›\r\n\r\n  Context in a draft\r\n${hint}`);
      expect(agentClearComposer(dump(surface.terminal), "Codex")).toBe("draft");
      await surface.write(
        `\x1b[H\x1b[2J›\r\n\r\n${status}\r\n${hint}\r\n  아직 남은 초안\r\n\r\n  main`,
      );
      expect(agentClearComposer(dump(surface.terminal), "Codex")).toBe("draft");
      await surface.write(`\x1b[H\x1b[2J›\r\n${status}\r\n${hint}`);
      expect(agentClearComposer(dump(surface.terminal), "Codex")).toBe("draft");
      await surface.write(`\x1b[H\x1b[2J›\r\n\r\n${status} · esc to interrupt\r\n${hint}`);
      expect(agentClearComposer(dump(surface.terminal), "Codex")).toBe("unsupported");
    } finally {
      surface.dispose();
    }
  });

  it.each(["  Context 94% left", "  GPT-6.2-Astra max · …"])(
    "Codex 상태줄 '%s' 아래에 단축키 안내만 있어도 입력란을 찾는다",
    async (status) => {
      const surface = createScreenTerminal({ cols: 48, rows: 8 });
      try {
        await surface.write(`›\r\n\r\n${status}\r\n  ? for shortcuts`);
        expect(agentClearComposer(dump(surface.terminal), "Codex")).toBe("empty");
      } finally {
        surface.dispose();
      }
    },
  );

  it("Grok의 테두리 입력창은 초안·여러 줄·빈 입력과 메뉴를 구분한다", async () => {
    const surface = createScreenTerminal({ cols: 96, rows: 12 });
    const frame = (text: string) =>
      "  ╭──────────────────────────────────────────────────╮\r\n" +
      text
        .split("\n")
        .map((l, i) => `  │ ${i === 0 ? "❯" : " "} ${l} │`)
        .join("\r\n") +
      "\r\n  ╰─────────────────────── Grok 4.7 (xhigh) ─╯\r\n  Shift+Tab:mode │ Ctrl+x:shortcuts";
    try {
      await surface.write(frame("Vim: esc to cancel\nsecond line"));
      expect(agentClearComposer(dump(surface.terminal), "Grok")).toBe("draft");
      await surface.write("\x1b[H\x1b[2J" + frame(""));
      expect(agentClearComposer(dump(surface.terminal), "Grok")).toBe("empty");
      await surface.write("\r\n  esc to cancel · enter to confirm");
      expect(agentClearComposer(dump(surface.terminal), "Grok")).toBe("unsupported");
    } finally {
      surface.dispose();
    }
  });
  it.each(["Claude", "Codex"] as const)(
    "%s의 과거 응답과 초안에 있는 UI 문구는 편집 모드로 오인하지 않는다",
    async (provider) => {
      const surface = createScreenTerminal({ cols: 96, rows: 12 });
      try {
        const draft = "Vim: esc to cancel";
        await surface.write(
          "Earlier response: esc to cancel\r\n" +
            (provider === "Codex"
              ? `› ${draft}\r\n\r\n  GPT-6.1-Sol · Context 100% left`
              : `────────────────────────\r\n> ${draft}\r\n────────────────────────\r\n  auto mode on`),
        );
        expect(agentClearComposer(dump(surface.terminal), provider)).toBe("draft");
      } finally {
        surface.dispose();
      }
    },
  );

  it.each(["", "Context in a draft"])(
    "Codex 초안 앞부분 '%s' 뒤의 긴 줄을 모두 확인한다",
    async (firstLine) => {
      const surface = createScreenTerminal({ cols: 96, rows: 12 });
      try {
        await surface.write(
          `› \r\n  ${firstLine}\r\n  ` +
            "x".repeat(160) +
            "\r\n\r\n  GPT-6.1-Sol · Context 100% left",
        );
        expect(agentClearComposer(dump(surface.terminal), "Codex")).toBe("draft");
      } finally {
        surface.dispose();
      }
    },
  );

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
