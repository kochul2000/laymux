import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

function writeTerminal(terminal: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function logicalLines(terminal: Terminal): string[] {
  const lines: string[] = [];
  let current: string | undefined;

  for (let index = 0; index < terminal.buffer.active.length; index++) {
    const line = terminal.buffer.active.getLine(index);
    if (!line) continue;
    const text = line.translateToString(true);
    if (!line.isWrapped) {
      if (current !== undefined) lines.push(current);
      current = text;
    } else {
      current = (current ?? "") + text;
    }
  }
  if (current !== undefined) lines.push(current);
  return lines;
}

describe("xterm width reflow", () => {
  it("preserves every logical line across an extreme narrow and rapid widen", async () => {
    const terminal = new Terminal({
      cols: 98,
      rows: 57,
      scrollback: 10_000,
      windowsPty: { backend: "conpty", buildNumber: 21_376 },
    });
    expect(terminal.buffer.active).toBe(terminal.buffer.normal);
    const body = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".repeat(4);
    const records = Array.from(
      { length: 500 },
      (_, index) => `R5-${String(index + 1).padStart(4, "0")}|${body}|END`,
    );
    // Once the screen fills, ConPTY wraps by repeating the last cell after a
    // CUP back to that cell. This mirrors the raw 98-column output precisely.
    const conptyOutput = records
      .map((record, index) =>
        index < 27
          ? `${record}\r\n`
          : `${record.slice(0, 98)}\r\n\x1b[56;98H${record.slice(97)}\r\n`,
      )
      .join("");
    await writeTerminal(terminal, `\x1b[3;1H${conptyOutput}PS D:\\PycharmProjects\\laymux> `);

    expect(logicalLines(terminal).filter((line) => line.startsWith("R5-"))).toEqual(records);

    // The bundled ConPTY runtime emits no host repaint after a width change
    // (ADR-0067), so xterm sees the resize and nothing else.
    terminal.resize(8, 57);
    terminal.scrollLines(-7_900);
    terminal.resize(58, 57);
    terminal.resize(100, 57);

    const reflowed = logicalLines(terminal).filter((line) => line.startsWith("R5-"));
    expect(reflowed).toEqual(records);
  });
});
