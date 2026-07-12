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

  it("removes a split narrow repaint with an intervening ConPTY window-size report", () => {
    const start = "\x1b[?25l\x1b[8;57;8t\x1b[H";
    const frame = `${start}narrow screen repaint\x1b[57;7H\x1b[?25hafter`;

    for (let split = 1; split < start.length; split++) {
      const filter = new ConptyResizeRepaintFilter(500);
      filter.arm(1000);

      expect(decoder.decode(filter.filter(bytes(frame.slice(0, split)), 1050))).toBe("");
      expect(decoder.decode(filter.filter(bytes(frame.slice(split)), 1060))).toBe("after");
      expect(filter.isArmed).toBe(false);
    }
  });

  it("removes every outstanding repaint when rearmed before the first frame starts", () => {
    const filter = new ConptyResizeRepaintFilter(500);
    filter.arm(1000);
    filter.arm(1010);

    const output = filter.filter(
      bytes(
        "\x1b[?25l\x1b[Hfirst frame\x1b[?25hbetween" + "\x1b[?25l\x1b[Hsecond frame\x1b[?25hafter",
      ),
      1020,
    );

    expect(decoder.decode(output)).toBe("betweenafter");
    expect(filter.isArmed).toBe(false);
  });

  it("preserves a partial start marker when rearmed before the first frame completes", () => {
    const filter = new ConptyResizeRepaintFilter(500);
    filter.arm(1000);

    expect(decoder.decode(filter.filter(bytes("\x1b[?25"), 1050))).toBe("");
    filter.arm(1060);
    expect(
      decoder.decode(
        filter.filter(
          bytes("l\x1b[Hfirst frame\x1b[?25hbetween" + "\x1b[?25l\x1b[Hsecond frame\x1b[?25hafter"),
          1070,
        ),
      ),
    ).toBe("betweenafter");
    expect(filter.isArmed).toBe(false);
  });

  it("restores the older deadline when a later arm is cancelled", () => {
    const filter = new ConptyResizeRepaintFilter(500);
    filter.arm(1000);
    const laterArm = filter.arm(1400);

    expect(decoder.decode(filter.cancelArm(laterArm))).toBe("");
    const redraw = "\x1b[?25l\x1b[Happlication redraw\x1b[?25h";
    expect(decoder.decode(filter.filter(bytes(redraw), 1600))).toBe(redraw);
    expect(filter.isArmed).toBe(false);
  });

  it("finishes the current repaint before honoring a second arm", () => {
    const filter = new ConptyResizeRepaintFilter(500);
    filter.arm(1000);

    expect(decoder.decode(filter.filter(bytes("\x1b[?25l\x1b[Hfirst frame"), 1050))).toBe("");
    filter.arm(1060);
    expect(
      decoder.decode(
        filter.filter(
          bytes(" tail\x1b[?25hbetween\x1b[?25l\x1b[Hsecond frame\x1b[?25hafter"),
          1070,
        ),
      ),
    ).toBe("betweenafter");
    expect(filter.isArmed).toBe(false);
  });

  it("honors a second arm after an incomplete current repaint expires", () => {
    const filter = new ConptyResizeRepaintFilter(500);
    filter.arm(1000);

    expect(decoder.decode(filter.filter(bytes("\x1b[?25l\x1b[Hincomplete"), 1050))).toBe("");
    filter.arm(1060);
    expect(
      decoder.decode(filter.filter(bytes("\x1b[?25l\x1b[Hsecond frame\x1b[?25hafter"), 1551)),
    ).toBe("after");
    expect(filter.isArmed).toBe(false);
  });

  it("finishes a repaint that starts near the scan window boundary", () => {
    const filter = new ConptyResizeRepaintFilter(500);
    filter.arm(1000);

    expect(decoder.decode(filter.filter(bytes("\x1b[?25l\x1b[Hframe"), 1490))).toBe("");
    expect(decoder.decode(filter.filter(bytes(" tail\x1b[?25hafter"), 1510))).toBe("after");
    expect(filter.isArmed).toBe(false);
  });

  it("stops dropping an incomplete repaint after its frame window", () => {
    const filter = new ConptyResizeRepaintFilter(500);
    filter.arm(1000);

    expect(decoder.decode(filter.filter(bytes("\x1b[?25l\x1b[Hincomplete"), 1490))).toBe("");
    expect(decoder.decode(filter.filter(bytes("later output"), 1991))).toBe("later output");
    expect(filter.isArmed).toBe(false);
  });

  it("removes a repaint at every split inside the start marker", () => {
    const start = "\x1b[?25l\x1b[H";
    const frame = `${start}frame\x1b[8;3H\x1b[?25hafter`;

    for (let split = 1; split < start.length; split++) {
      const filter = new ConptyResizeRepaintFilter(500);
      filter.arm(1000);

      const first = filter.filter(bytes(frame.slice(0, split)), 1050);
      const second = filter.filter(bytes(frame.slice(split)), 1060);

      expect(decoder.decode(first), `split ${split} first chunk`).toBe("");
      expect(decoder.decode(second), `split ${split} second chunk`).toBe("after");
      expect(filter.isArmed, `split ${split} armed state`).toBe(false);
    }
  });

  it("releases a partial start prefix when the following chunk does not match", () => {
    const filter = new ConptyResizeRepaintFilter(500);
    filter.arm(1000);

    expect(decoder.decode(filter.filter(bytes("before\x1b[?25"), 1050))).toBe("before");
    expect(decoder.decode(filter.filter(bytes("Xafter"), 1060))).toBe("\x1b[?25Xafter");
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
