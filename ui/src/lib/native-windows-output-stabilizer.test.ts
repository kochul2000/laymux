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
  it("flushes Codex 0.145's in-frame cursor park without waiting for another chunk", () => {
    const stabilizer = new NativeWindowsOutputStabilizer();
    // Captured on Codex 0.145.0: unlike the older two-chunk grammar, the final
    // input-caret CUP now lands after DECTCEM show but before DEC 2026 reset.
    const emissions = stabilizer.push(
      bytes("\x1b[?2026hframe\x1b[26;58H\x1b[?25h\x1b[24;3H\x1b[?2026l"),
      10,
    );

    expect(text(emissions)).toBe("\x1b[?2026hframe\x1b[26;58H\x1b[?25h\x1b[24;3H\x1b[?2026l");
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      stabilized: true,
      frameEndCursorAuthoritative: true,
    });
    expect(emissions[0].parkDeadline).toBeUndefined();
    expect(stabilizer.deadline).toBeUndefined();
  });

  it("flushes Codex 0.150+'s position-before-show park without waiting", () => {
    const stabilizer = new NativeWindowsOutputStabilizer();
    // Captured on Codex 0.151.0: the final input-caret CUP now precedes
    // DECTCEM show, and DEC 2026 reset follows the show immediately.
    const input = "\x1b[?2026hframe\x1b[26;58H\x1b[24;3H\x1b[?25h\x1b[?2026l";

    const emissions = stabilizer.push(bytes(input), 10);

    expect(text(emissions)).toBe(input);
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      stabilized: true,
      frameEndCursorAuthoritative: true,
    });
    expect(emissions[0].parkDeadline).toBeUndefined();
    expect(stabilizer.deadline).toBeUndefined();
  });

  it("recognizes Codex 0.150+'s strict tail split around show and reset", () => {
    const stabilizer = new NativeWindowsOutputStabilizer();
    const input = "\x1b[?2026hframe\x1b[24;3H\x1b[?25h\x1b[?2026l";

    expect(text(stabilizer.push(bytes("\x1b[?2026hframe\x1b[24;3H"), 10))).toBe("");
    expect(text(stabilizer.push(bytes("\x1b[?25h\x1b[?20"), 20))).toBe("");
    const emissions = stabilizer.push(bytes("26l"), 30);

    expect(text(emissions)).toBe(input);
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      stabilized: true,
      frameEndCursorAuthoritative: true,
    });
    expect(stabilizer.deadline).toBeUndefined();
  });

  it.each([
    ["0.145", "\x1b[?2026hframe\x1b[?25h\x1b[24;3H\x1b[?2026l"],
    ["0.150+", "\x1b[?2026hframe\x1b[24;3H\x1b[?25h\x1b[?2026l"],
  ])("recognizes Codex %s's strict tail at every PTY chunk boundary", (_version, input) => {
    for (let split = 1; split < input.length; split += 1) {
      const stabilizer = new NativeWindowsOutputStabilizer();
      const emissions = [
        ...stabilizer.push(bytes(input.slice(0, split)), 10),
        ...stabilizer.push(bytes(input.slice(split)), 20),
      ];

      expect(text(emissions)).toBe(input);
      expect(emissions).toHaveLength(1);
      expect(emissions[0]).toMatchObject({
        stabilized: true,
        frameEndCursorAuthoritative: true,
      });
      expect(stabilizer.deadline).toBeUndefined();
    }
  });

  it.each([
    [
      "show-first P+",
      "\x1b[?25h\x1b[2;3H\x1b[4;5f\x1b[9G\x1b[?2026l",
      "\x1b[?25h\x1b[2;3H\x1b[4;5f\x1b[9G\x1b[?2026l",
    ],
    [
      "position-first P+",
      "\x1b[2;3H\x1b[4;5f\x1b[9G\x1b[?25h\x1b[?2026l",
      "\x1b[2;3H\x1b[4;5f\x1b[9G\x1b[?25h\x1b[?2026l",
    ],
    [
      "position-first suffix",
      "\x1b[?25h\x1b[2;3H\x1b[?25h\x1b[?2026l",
      "\x1b[2;3H\x1b[?25h\x1b[?2026l",
    ],
    [
      "show-first suffix",
      "\x1b[2;3H\x1b[?25h\x1b[9G\x1b[?2026l",
      "\x1b[2;3H\x1b[?25h\x1b[9G\x1b[?2026l",
    ],
  ])("recognizes the final %s after earlier candidate tokens", (_label, tail, expectedTail) => {
    const stabilizer = new NativeWindowsOutputStabilizer();
    const input = "\x1b[?2026hframe" + tail;
    const expected = "\x1b[?2026hframe" + expectedTail;

    const emissions = stabilizer.push(bytes(input), 10);

    expect(text(emissions)).toBe(expected);
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      stabilized: true,
      frameEndCursorAuthoritative: true,
    });
  });

  it("removes an earlier transient show but preserves Codex 0.150+'s final show", () => {
    const stabilizer = new NativeWindowsOutputStabilizer();
    const input = "\x1b[?2026hframe\x1b[?25h\x1b[0m\x1b[24;3H\x1b[?25h\x1b[?2026l";
    const expected = "\x1b[?2026hframe\x1b[0m\x1b[24;3H\x1b[?25h\x1b[?2026l";

    const emissions = stabilizer.push(bytes(input), 10);

    expect(text(emissions)).toBe(expected);
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      stabilized: true,
      frameEndCursorAuthoritative: true,
    });
  });

  it.each([
    ["printable payload", "X"],
    ["another CSI", "\x1b[0m"],
    ["an OSC", "\x1b]0;title\x07"],
  ])("does not widen the strict in-frame park across %s", (_label, interruption) => {
    const stabilizer = new NativeWindowsOutputStabilizer();
    const input = "\x1b[?2026hframe\x1b[?25h\x1b[24;3H" + interruption + "\x1b[?2026l";

    expect(text(stabilizer.push(bytes(input), 0))).toBe("");
    expect(text(stabilizer.flushExpired(50))).toBe(input);
  });

  it.each([
    ["printable after position", "\x1b[24;3HX\x1b[?25h\x1b[?2026l"],
    ["another CSI after position", "\x1b[24;3H\x1b[0m\x1b[?25h\x1b[?2026l"],
    ["an OSC after position", "\x1b[24;3H\x1b]0;title\x07\x1b[?25h\x1b[?2026l"],
    ["a C0 after position", "\x1b[24;3H\x00\x1b[?25h\x1b[?2026l"],
    ["printable after show", "\x1b[24;3H\x1b[?25hX\x1b[?2026l"],
    ["another CSI after show", "\x1b[24;3H\x1b[?25h\x1b[0m\x1b[?2026l"],
    ["an OSC after show", "\x1b[24;3H\x1b[?25h\x1b]0;title\x07\x1b[?2026l"],
    ["a malformed CSI", "\x1b[24;3H\x1b[\x10\x1b[?25h\x1b[?2026l"],
  ])("does not widen Codex 0.150+'s strict tail across %s", (_label, tail) => {
    const stabilizer = new NativeWindowsOutputStabilizer();
    const input = "\x1b[?2026hframe" + tail;

    expect(text(stabilizer.push(bytes(input), 0))).toBe("");
    expect(text(stabilizer.flushExpired(50))).toBe(input);
  });

  it("does not treat a final position without cursor show as authoritative", () => {
    const stabilizer = new NativeWindowsOutputStabilizer();
    const input = "\x1b[?2026hframe\x1b[24;3H\x1b[?2026l";

    expect(text(stabilizer.push(bytes(input), 0))).toBe("");
    const emissions = stabilizer.flushExpired(50);

    expect(text(emissions)).toBe(input);
    expect(emissions).toHaveLength(1);
    expect(emissions[0].frameEndCursorAuthoritative).toBeUndefined();
    expect(emissions[0].stabilized).toBe(false);
  });

  it("reconsumes ESC that cancels a malformed CSI as the next position opener", () => {
    const input = "\x1b[?2026hbody\x1b[31\x1b[4;7H\x1b[?25h\x1b[?2026l";

    for (let split = 1; split < input.length; split += 1) {
      const stabilizer = new NativeWindowsOutputStabilizer();
      const emissions = [
        ...stabilizer.push(bytes(input.slice(0, split)), 10),
        ...stabilizer.push(bytes(input.slice(split)), 20),
      ];

      expect(text(emissions)).toBe(input);
      expect(emissions).toHaveLength(1);
      expect(emissions[0]).toMatchObject({
        stabilized: true,
        frameEndCursorAuthoritative: true,
      });
    }
  });

  it("does not leak a frame or omit shows past a reset that cancels a malformed CSI", () => {
    const input = "\x1b[?2026h\x1b[?25h\x1b[31\x1b[?2026l" + "outside\x1b[?25h\x1b[4;7H\x1b[?2026l";

    for (let split = 1; split < input.length; split += 1) {
      const stabilizer = new NativeWindowsOutputStabilizer();
      const emissions = [
        ...stabilizer.push(bytes(input.slice(0, split)), 10),
        ...stabilizer.push(bytes(input.slice(split)), 20),
      ];

      expect(text(emissions)).toBe(input);
      expect(emissions.every((emission) => !emission.frameEndCursorAuthoritative)).toBe(true);
      expect(emissions.every((emission) => !emission.stabilized)).toBe(true);
      expect(stabilizer.deadline).toBeUndefined();
    }
  });

  it("keeps the last of repeated ESC bytes as a position opener", () => {
    const input = "\x1b[?2026hbody\x1b\x1b[4;7H\x1b[?25h\x1b[?2026l";

    for (let split = 1; split < input.length; split += 1) {
      const stabilizer = new NativeWindowsOutputStabilizer();
      const emissions = [
        ...stabilizer.push(bytes(input.slice(0, split)), 10),
        ...stabilizer.push(bytes(input.slice(split)), 20),
      ];

      expect(text(emissions)).toBe(input);
      expect(emissions).toHaveLength(1);
      expect(emissions[0]).toMatchObject({
        stabilized: true,
        frameEndCursorAuthoritative: true,
      });
    }
  });

  it.each([
    ["a canceled standalone CSI", "prefix\x1b[31\x1b[?2026hbody"],
    ["repeated standalone ESC", "prefix\x1b\x1b[?2026hbody"],
  ])("preserves %s before a following strict frame", (_label, prefix) => {
    const input = prefix + "\x1b[4;7H\x1b[?25h\x1b[?2026l";

    for (let split = 1; split < input.length; split += 1) {
      const stabilizer = new NativeWindowsOutputStabilizer();
      const emissions = [
        ...stabilizer.push(bytes(input.slice(0, split)), 10),
        ...stabilizer.push(bytes(input.slice(split)), 20),
      ];

      expect(text(emissions)).toBe(input);
      expect(
        emissions.filter((emission) => emission.frameEndCursorAuthoritative === true),
      ).toHaveLength(1);
    }
  });

  it.each([
    ["a canceled partial CSI", "\x1b[31\x1b[?2026h"],
    ["repeated ESC", "\x1b\x1b[?2026h"],
  ])("hands %s from an unrestored frame to the following frame", (_label, boundary) => {
    const input = "\x1b[?2026hold\x1b[?2026l" + boundary + "new\x1b[4;7H\x1b[?25h\x1b[?2026l";

    for (let split = 1; split < input.length; split += 1) {
      const stabilizer = new NativeWindowsOutputStabilizer();
      const emissions = [
        ...stabilizer.push(bytes(input.slice(0, split)), 10),
        ...stabilizer.push(bytes(input.slice(split)), 20),
      ];

      expect(text(emissions)).toBe(input);
      expect(emissions.filter((emission) => emission.stabilized)).toHaveLength(1);
      expect(
        emissions.filter((emission) => emission.frameEndCursorAuthoritative === true),
      ).toHaveLength(1);
      expect(stabilizer.deadline).toBeUndefined();
    }
  });

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

  it("keeps a standalone split CSI pending until its final byte", () => {
    const stabilizer = new NativeWindowsOutputStabilizer();

    expect(text(stabilizer.push(bytes("\x1b[31"), 100))).toBe("");
    expect(stabilizer.hasHeldBytes).toBe(true);
    expect(stabilizer.hasOpenSequence).toBe(true);
    expect(stabilizer.deadline).toBeUndefined();
    expect(text(stabilizer.flushExpired(10_000))).toBe("");

    expect(text(stabilizer.push(bytes("mbody"), 10_001))).toBe("\x1b[31mbody");
    expect(stabilizer.hasHeldBytes).toBe(false);
    expect(stabilizer.hasOpenSequence).toBe(false);
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

  it("preserves a split OSC introducer when timeout lands after ESC", () => {
    const stabilizer = new NativeWindowsOutputStabilizer();
    const prefix = "\x1b[?2026hbody\x1b";
    const suffix = "]title fake \x1b[?2026hPAY\x1b[?25h\x1b[?2026l\x1b[?25l\x1b[H\x1b[?25h\x07tail";

    expect(text(stabilizer.push(bytes(prefix), 0))).toBe("");
    expect(text(stabilizer.flushExpired(50))).toBe(prefix);
    expect(text(stabilizer.push(bytes(suffix), 60))).toBe(suffix);

    expect(text(stabilizer.push(bytes("\x1b[?2026hnew"), 70))).toBe("");
  });

  it("fails open when the buffered transaction would exceed its byte limit", () => {
    const stabilizer = new NativeWindowsOutputStabilizer({ maxBufferedBytes: 24 });
    const input = "\x1b[?2026h" + "x".repeat(20);

    expect(text(stabilizer.push(bytes(input), 0))).toBe(input);
    expect(stabilizer.deadline).toBeUndefined();
  });

  it("keeps lexical framing when the size limit lands on a control-string introducer", () => {
    const stabilizer = new NativeWindowsOutputStabilizer({ maxBufferedBytes: 8 });
    const prefix = "\x1b[?2026h\x1b";

    expect(text(stabilizer.push(bytes(prefix), 0))).toBe(prefix);
    expect(text(stabilizer.push(bytes("]fake \x1b[?2026h\x07plain"), 1))).toBe(
      "]fake \x1b[?2026h\x07plain",
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
