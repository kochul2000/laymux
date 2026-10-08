import { afterEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { HeadlessScreen } from "../../../../tools/terminal-headless/state";
import { activateTerminalUnicodeProvider } from "../../lib/terminal-unicode-width";
import { applyDaemonParserState } from "../../lib/daemon-parser-state";

const owned: Array<{ dispose(): void }> = [];
function pair(cols = 10, rows = 4) {
  const replies: string[] = [];
  const daemon = new HeadlessScreen(cols, rows, (data) => replies.push(data));
  const gui = new Terminal({
    cols,
    rows,
    scrollback: 10000,
    allowProposedApi: true,
    windowsPty: { backend: "conpty", buildNumber: 21376 },
  });
  activateTerminalUnicodeProvider(gui);
  owned.push(daemon, gui);
  return { daemon, gui, replies };
}
const write = (terminal: Terminal, data: string | Uint8Array) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));
function cells(terminal: Terminal | HeadlessScreen["terminal"]) {
  const buffer = terminal.buffer.active;
  return {
    cursor: [buffer.cursorX, buffer.cursorY],
    mode: buffer.type,
    lines: Array.from({ length: terminal.rows }, (_, row) => {
      const line = buffer.getLine(buffer.baseY + row);
      return Array.from({ length: terminal.cols }, (_, col) => {
        const cell = line?.getCell(col);
        return [cell?.getChars(), cell?.getWidth(), cell?.getFgColor(), cell?.getBgColor()];
      });
    }),
  };
}
afterEach(() => owned.splice(0).forEach((item) => item.dispose()));

describe("daemon checkpoint restored into a real GUI xterm", () => {
  it("preserves custom tab stops, G0/G1 charset and SGR mouse encoding", async () => {
    const { daemon, gui } = pair(24, 5);
    await daemon.write(
      "\x1b[3g\x1b[1;4H\x1bH\x1b[1;10H\x1bH\x1b[H\x1b)0\x0e\x1b[?1000h\x1b[?1006h",
    );
    const checkpoint = daemon.checkpoint();
    await write(gui, checkpoint.serialized);
    applyDaemonParserState(gui, checkpoint.parserState);
    const suffix = "q\tq\tq\x0fq";
    await daemon.write(suffix);
    await write(gui, suffix);
    expect(cells(gui)).toEqual(cells(daemon.terminal));
    const encoding = (terminal: unknown) =>
      (terminal as { _core: { coreMouseService: { activeEncoding: string } } })._core
        .coreMouseService.activeEncoding;
    expect(encoding(gui)).toBe(encoding(daemon.terminal));
    expect(encoding(gui)).toBe("SGR");
  });
  it("preserves DECRC saved charset independently from the currently selected charset", async () => {
    const { daemon, gui } = pair(24, 5);
    await daemon.write("\x1b(0\x1b7\x1b(B\x1b[2;1Hplain");
    const checkpoint = daemon.checkpoint();
    await write(gui, checkpoint.serialized);
    applyDaemonParserState(gui, checkpoint.parserState);
    const suffix = "q\x1b8q";
    await daemon.write(suffix);
    await write(gui, suffix);
    expect(cells(gui)).toEqual(cells(daemon.terminal));
  });
  it.each([
    "\x1b[31m\x1b]8;id=sample;https://example.com/doc\x1b\\link\x1b]8;;\x1b\\tail",
    "ABCDEFGHI\x1b]8;;https://example.com/edge\x1b\\J\x1b]8;;\x1b\\",
    "\x1b]8;;https://example.com/open\x1b\\link",
  ])("preserves OSC 8 cell links and the active link at attach (%j)", async (data) => {
    const { daemon, gui } = pair();
    const links = (terminal: Terminal | HeadlessScreen["terminal"]) => {
      const core = (
        terminal as unknown as {
          _core: { _oscLinkService: { getLinkData(id: number): { uri: string } | undefined } };
        }
      )._core;
      return Array.from({ length: terminal.rows }, (_, row) =>
        Array.from({ length: terminal.cols }, (_, col) => {
          const cell = terminal.buffer.active
            .getLine(terminal.buffer.active.baseY + row)
            ?.getCell(col) as unknown as { extended: { urlId: number } };
          return core._oscLinkService.getLinkData(cell.extended.urlId)?.uri;
        }),
      );
    };
    await daemon.write(data);
    await write(gui, daemon.checkpoint().serialized);
    expect(cells(gui)).toEqual(cells(daemon.terminal));
    expect(links(gui)).toEqual(links(daemon.terminal));
    await daemon.write("Z");
    await write(gui, "Z");
    expect(links(gui)).toEqual(links(daemon.terminal));
  });
  it("keeps all logical records through extreme narrow and rapid widen", async () => {
    const { daemon, gui } = pair(98, 57);
    const body = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".repeat(4);
    const records = Array.from(
      { length: 500 },
      (_, index) => `R5-${String(index + 1).padStart(4, "0")}|${body}|END`,
    );
    const raw = records
      .map((record, index) =>
        index < 27
          ? `${record}\r\n`
          : `${record.slice(0, 98)}\r\n\x1b[56;98H${record.slice(97)}\r\n`,
      )
      .join("");
    await daemon.write(`\x1b[3;1H${raw}PS D:\\project> `);
    await write(gui, `\x1b[3;1H${raw}PS D:\\project> `);
    for (const cols of [8, 58, 100]) {
      daemon.terminal.resize(cols, 57);
      gui.resize(cols, 57);
    }
    const logical = (terminal: Terminal | HeadlessScreen["terminal"]) => {
      const result: string[] = [];
      for (let index = 0; index < terminal.buffer.active.length; index++) {
        const line = terminal.buffer.active.getLine(index);
        const text = line?.translateToString(true) ?? "";
        if (line?.isWrapped && result.length) result[result.length - 1] += text;
        else result.push(text);
      }
      return result.filter((line) => line.startsWith("R5-"));
    };
    expect(logical(gui)).toEqual(records);
    expect(logical(daemon.terminal)).toEqual(records);
  });
  it("answers OSC foreground/background/cursor queries without a GUI", async () => {
    const { daemon, replies } = pair();
    await daemon.write("\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b]12;?\x1b\\");
    expect(replies).toEqual([
      "\x1b]10;rgb:f0f0/f0f0/f0f0\x1b\\",
      "\x1b]11;rgb:0c0c/0c0c/0c0c\x1b\\",
      "\x1b]12;rgb:ffff/ffff/ffff\x1b\\",
    ]);
    replies.length = 0;
    await daemon.write("\x1b]11;#112233\x1b\\\x1b]11;?\x1b\\\x1b]111\x1b\\\x1b]11;?\x1b\\");
    expect(replies).toEqual([
      "\x1b]11;rgb:1111/2222/3333\x1b\\",
      "\x1b]11;rgb:0c0c/0c0c/0c0c\x1b\\",
    ]);
  });
  it.each([
    ["plain\x1b[31;", "1mRED"],
    ["plain\x1b]2;par", "tial-title\x1b\\tail"],
    ["plain\x1bP$q", "m\x1b\\tail"],
    ["plain\x1b(", "0q"],
  ])("continues an unfinished VT sequence across attach (%j)", async (prefix, suffix) => {
    const { daemon, gui } = pair(20);
    await daemon.write(new TextEncoder().encode(prefix));
    const checkpoint = daemon.checkpoint();
    await write(gui, checkpoint.serialized);
    await write(gui, Uint8Array.from(checkpoint.pendingBytes));
    await daemon.write(suffix);
    await write(gui, suffix);
    expect(cells(gui)).toEqual(cells(daemon.terminal));
  });

  it("continues a partially decoded UTF-8 glyph across attach", async () => {
    const { daemon, gui } = pair(20);
    const bytes = new TextEncoder().encode("A한B");
    await daemon.write(bytes.slice(0, 3));
    const checkpoint = daemon.checkpoint();
    await write(gui, checkpoint.serialized);
    await write(gui, Uint8Array.from(checkpoint.pendingBytes));
    await daemon.write(bytes.slice(3));
    await write(gui, bytes.slice(3));
    expect(cells(gui)).toEqual(cells(daemon.terminal));
  });
  it.each([false, true])(
    "preserves scroll margins and origin mode before later output (%j)",
    async (origin) => {
      const { daemon, gui } = pair(10, 6);
      await daemon.write(`header\x1b[2;5r${origin ? "\x1b[?6h" : ""}\x1b[3;2Hmiddle`);
      await write(gui, daemon.checkpoint().serialized);
      expect(cells(gui)).toEqual(cells(daemon.terminal));
      const suffix = "\x1b[4;1Hone\r\ntwo\r\nthree";
      await daemon.write(suffix);
      await write(gui, suffix);
      expect(cells(gui)).toEqual(cells(daemon.terminal));
      expect(gui.modes.originMode).toEqual(daemon.terminal.modes.originMode);
    },
  );

  it("restores saved cursor and rendition before a later DECRC", async () => {
    const { daemon, gui } = pair(12, 5);
    await daemon.write("\x1b[2;4H\x1b[31m\x1b7\x1b[4;2H\x1b[32mnow");
    await write(gui, daemon.checkpoint().serialized);
    await daemon.write("\x1b8R");
    await write(gui, "\x1b8R");
    expect(cells(gui)).toEqual(cells(daemon.terminal));
  });

  it("matches GUI reflow after width and height changes while detached", async () => {
    const { daemon, gui } = pair(20, 6);
    const text = "long command 한글 abcdefghijklmnopqrstuvwxyz\r\nnext line";
    await daemon.write(text);
    await write(gui, text);
    daemon.terminal.resize(11, 8);
    gui.resize(11, 8);
    expect(cells(gui)).toEqual(cells(daemon.terminal));
    const restored = new Terminal({ cols: 11, rows: 8, allowProposedApi: true });
    activateTerminalUnicodeProvider(restored);
    owned.push(restored);
    await write(restored, daemon.checkpoint().serialized);
    expect(cells(restored)).toEqual(cells(daemon.terminal));
  });

  it.each(["", "\x1b[?1049h"])(
    "keeps an explicitly positioned last-column cursor (%j)",
    async (mode) => {
      const { daemon, gui } = pair();
      await daemon.write(`${mode}ABCDEFGHIJ\x1b[1;10H`);
      await write(gui, daemon.checkpoint().serialized);
      expect(cells(gui)).toEqual(cells(daemon.terminal));
      await daemon.write("Z");
      await write(gui, "Z");
      expect(cells(gui)).toEqual(cells(daemon.terminal));
    },
  );

  it("keeps pending wrap at the last cell across attach", async () => {
    const { daemon, gui } = pair();
    await daemon.write("ABCDEFGHIJ");
    await write(gui, daemon.checkpoint().serialized);
    await daemon.write("K");
    await write(gui, "K");
    expect(cells(gui)).toEqual(cells(daemon.terminal));
  });

  it("continues parsing UTF-8 and answering DSR without a GUI", async () => {
    const { daemon, gui, replies } = pair(20);
    const data = new TextEncoder().encode("한글\x1b[6n");
    await daemon.write(data.slice(0, 2));
    await daemon.write(data.slice(2));
    expect(replies).toEqual(["\x1b[1;5R"]);
    await write(gui, daemon.checkpoint().serialized);
    expect(cells(gui)).toEqual(cells(daemon.terminal));
    expect(replies).toHaveLength(1);
  });

  it("uses the shared grapheme provider when an emoji crosses the right margin", async () => {
    const { daemon, gui } = pair(10);
    await daemon.write("12345678👩‍💻한글");
    await write(gui, "12345678👩‍💻한글");
    expect(cells(gui)).toEqual(cells(daemon.terminal));
    const restored = new Terminal({ cols: 10, rows: 4, allowProposedApi: true });
    activateTerminalUnicodeProvider(restored);
    owned.push(restored);
    await write(restored, daemon.checkpoint().serialized);
    expect(cells(restored)).toEqual(cells(daemon.terminal));
  });
});
