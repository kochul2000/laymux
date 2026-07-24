import { describe, expect, it } from "vitest";
import {
  NativeWindowsOutputStabilizer,
  type StabilizedOutputEmission,
} from "./native-windows-output-stabilizer";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function text(emissions: StabilizedOutputEmission[]): string {
  return emissions.map((emission) => decoder.decode(emission.data)).join("");
}

describe("NativeWindowsOutputStabilizer", () => {
  it("holds a split synchronized-output frame through its exact cursor restore", () => {
    const stabilizer = new NativeWindowsOutputStabilizer();

    expect(text(stabilizer.push(bytes("prefix\x1b[?2026"), 10))).toBe("prefix");
    expect(text(stabilizer.push(bytes("hframe\x1b[?25h\x1b[?2026l\x1b[?25l"), 20))).toBe("");
    expect(stabilizer.deadline).toBe(60);
    const emissions = stabilizer.push(bytes("\x1b[4;7H\x1b[?25htail"), 30);

    expect(text(emissions)).toBe("\x1b[?2026hframe\x1b[?2026l\x1b[?25l\x1b[4;7H\x1b[?25htail");
    expect(emissions[0]).toMatchObject({ stabilized: true, parkDeadline: 70 });
  });

  it("accepts multiple CUP, HVP, and CHA position commands in the restore", () => {
    const stabilizer = new NativeWindowsOutputStabilizer();
    const emissions = stabilizer.push(
      bytes("\x1b[?2026hbody\x1b[?2026l\x1b[?25l\x1b[2;3H\x1b[4;5f\x1b[9G\x1b[?25h"),
      100,
    );

    expect(text(emissions)).toContain("\x1b[2;3H\x1b[4;5f\x1b[9G\x1b[?25h");
    expect(emissions).toHaveLength(1);
    expect(emissions[0].stabilized).toBe(true);
  });

  it("does not treat CSI-looking bytes inside OSC or DCS payloads as frame markers", () => {
    const stabilizer = new NativeWindowsOutputStabilizer();
    const input =
      "\x1b]0;fake \x1b[?2026h title\x07" + "\x1bPfake \x1b[?2026l payload\x1b\\" + "plain";

    const emissions = stabilizer.push(bytes(input), 0);

    expect(text(emissions)).toBe(input);
    expect(emissions.every((emission) => !emission.stabilized)).toBe(true);
  });

  it("fails open byte-for-byte when post-frame bytes do not match the restore grammar", () => {
    const stabilizer = new NativeWindowsOutputStabilizer();
    const input = "\x1b[?2026hbody\x1b[?25h\x1b[?2026lX";

    const emissions = stabilizer.push(bytes(input), 25);

    expect(text(emissions)).toBe(input);
    expect(emissions[0]).toMatchObject({ stabilized: false, parkDeadline: 75 });
  });

  it("uses one absolute 50ms hold deadline across frame end and restore wait", () => {
    const stabilizer = new NativeWindowsOutputStabilizer();

    expect(text(stabilizer.push(bytes("\x1b[?2026hbody"), 100))).toBe("");
    expect(text(stabilizer.push(bytes("\x1b[?2026l"), 149))).toBe("");
    expect(stabilizer.deadline).toBe(150);
    const timedOut = stabilizer.flushExpired(150);

    expect(text(timedOut)).toBe("\x1b[?2026hbody\x1b[?2026l");
    expect(timedOut[0]).toMatchObject({ stabilized: false, parkDeadline: 199 });
  });

  it("streams an unterminated OSC after timeout until its real terminator", () => {
    const stabilizer = new NativeWindowsOutputStabilizer();
    const prefix = "\x1b[?2026hbody\x1b]0;unterminated \x1b[?2026l";

    expect(text(stabilizer.push(bytes(prefix), 0))).toBe("");
    expect(text(stabilizer.flushExpired(50))).toBe(prefix);
    expect(text(stabilizer.push(bytes(" still payload \x1b[?2026h"), 60))).toBe(
      " still payload \x1b[?2026h",
    );
    expect(text(stabilizer.push(bytes("\x07after"), 70))).toBe("\x07after");

    expect(text(stabilizer.push(bytes("\x1b[?2026hnew"), 80))).toBe("");
  });

  it("fails open when the buffered transaction would exceed its byte limit", () => {
    const stabilizer = new NativeWindowsOutputStabilizer({ maxBufferedBytes: 24 });
    const input = "\x1b[?2026h" + "x".repeat(20);

    expect(text(stabilizer.push(bytes(input), 0))).toBe(input);
    expect(stabilizer.deadline).toBeUndefined();
  });

  it("keeps lexical framing when the size limit lands on a control-string introducer", () => {
    const stabilizer = new NativeWindowsOutputStabilizer({ maxBufferedBytes: 9 });
    const prefix = "\x1b[?2026h\x1b]";

    expect(text(stabilizer.push(bytes(prefix), 0))).toBe(prefix);
    expect(text(stabilizer.push(bytes("fake \x1b[?2026h\x07plain"), 1))).toBe(
      "fake \x1b[?2026h\x07plain",
    );
    expect(text(stabilizer.push(bytes("\x1b[?2026h"), 2))).toBe("");
  });

  it("fails open an un-restored frame before starting a following frame candidate", () => {
    const stabilizer = new NativeWindowsOutputStabilizer();
    const previous = "\x1b[?2026hold\x1b[?2026l";

    expect(text(stabilizer.push(bytes(previous), 0))).toBe("");
    const emissions = stabilizer.push(bytes("\x1b[?2026hnew"), 10);

    expect(text(emissions)).toBe(previous);
    expect(stabilizer.deadline).toBe(60);
    expect(text(stabilizer.push(bytes("\x1b[?2026l\x1b[?25l\x1b[H\x1b[?25h"), 20))).toBe(
      "\x1b[?2026hnew\x1b[?2026l\x1b[?25l\x1b[H\x1b[?25h",
    );
  });

  it("discards held bytes and lexical state on attach reset", () => {
    const stabilizer = new NativeWindowsOutputStabilizer();

    expect(text(stabilizer.push(bytes("\x1b[?2026hheld\x1b]0;open"), 0))).toBe("");
    stabilizer.reset();

    expect(text(stabilizer.push(bytes("fresh"), 1))).toBe("fresh");
    expect(stabilizer.deadline).toBeUndefined();
  });
});
