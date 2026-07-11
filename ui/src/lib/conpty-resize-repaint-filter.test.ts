import { describe, expect, it } from "vitest";
import { ConptyResizeRepaintFilter } from "./conpty-resize-repaint-filter";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

describe("ConptyResizeRepaintFilter", () => {
  it("passes output through while disarmed", () => {
    const filter = new ConptyResizeRepaintFilter(500);

    expect(decoder.decode(filter.filter(bytes("normal output"), 1000))).toBe("normal output");
  });

  it("removes the cursor-hidden resize repaint and preserves surrounding output", () => {
    const filter = new ConptyResizeRepaintFilter(500);
    filter.arm(1000);

    const output = filter.filter(
      bytes("before\x1b[?25l\x1b[Hrepainted scrollback\x1b[19;19H\x1b[?25hafter"),
      1100,
    );

    expect(decoder.decode(output)).toBe("beforeafter");
    expect(filter.isArmed).toBe(false);
  });

  it("removes a repaint split across PTY chunks", () => {
    const filter = new ConptyResizeRepaintFilter(500);
    filter.arm(1000);

    expect(decoder.decode(filter.filter(bytes("\x1b[?25l\x1b[Hframe part"), 1050))).toBe("");
    expect(decoder.decode(filter.filter(bytes(" two\x1b[12;4H\x1b[?2"), 1060))).toBe("");
    expect(decoder.decode(filter.filter(bytes("5hreal output"), 1070))).toBe("real output");
    expect(filter.isArmed).toBe(false);
  });

  it("keeps unrelated output while waiting for the resize repaint", () => {
    const filter = new ConptyResizeRepaintFilter(500);
    filter.arm(1000);

    expect(decoder.decode(filter.filter(bytes("SIGWINCH handler output"), 1050))).toBe(
      "SIGWINCH handler output",
    );
    expect(filter.isArmed).toBe(true);
    expect(decoder.decode(filter.filter(bytes("\x1b[?25l\x1b[Hframe\x1b[?25h"), 1060))).toBe("");
  });

  it("expires without filtering later application redraws", () => {
    const filter = new ConptyResizeRepaintFilter(100);
    filter.arm(1000);
    const redraw = "\x1b[?25l\x1b[Happlication redraw\x1b[?25h";

    expect(decoder.decode(filter.filter(bytes(redraw), 1101))).toBe(redraw);
    expect(filter.isArmed).toBe(false);
  });
});
