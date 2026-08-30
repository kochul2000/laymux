import { describe, expect, it } from "vitest";
import {
  WslInFrameCursorParkRecognizer,
  type WslCursorMetadataEmission,
} from "./wsl-in-frame-cursor-park-recognizer";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function text(emissions: WslCursorMetadataEmission[]): string {
  return emissions.map((emission) => decoder.decode(emission.data)).join("");
}

describe("WslInFrameCursorParkRecognizer", () => {
  it("marks only Codex 0.145's strict in-frame DEC 2026 reset as authoritative", () => {
    const recognizer = new WslInFrameCursorParkRecognizer();
    const input = "\x1b[?2026hbody\x1b[26;58H\x1b[?25h\x1b[24;3H\x1b[?2026l";

    const emissions = recognizer.push(bytes(input));

    expect(text(emissions)).toBe(input);
    expect(emissions).toHaveLength(2);
    expect(emissions[0].frameEndCursorAuthoritative).toBeUndefined();
    expect(decoder.decode(emissions[1].data)).toBe("\x1b[?2026l");
    expect(emissions[1].frameEndCursorAuthoritative).toBe(true);
    expect(emissions.every((emission) => emission.stabilized === false)).toBe(true);
  });

  it("marks Codex 0.150+'s position-before-show reset as authoritative", () => {
    const recognizer = new WslInFrameCursorParkRecognizer();
    // Captured on Codex 0.151.0: the final input-caret CUP now precedes
    // DECTCEM show, and DEC 2026 reset follows the show immediately.
    const input = "\x1b[?2026hbody\x1b[26;58H\x1b[24;3H\x1b[?25h\x1b[?2026l";

    const emissions = recognizer.push(bytes(input));

    expect(text(emissions)).toBe(input);
    expect(emissions).toHaveLength(2);
    expect(emissions[0].frameEndCursorAuthoritative).toBeUndefined();
    expect(decoder.decode(emissions[1].data)).toBe("\x1b[?2026l");
    expect(emissions[1].frameEndCursorAuthoritative).toBe(true);
    expect(emissions.every((emission) => emission.stabilized === false)).toBe(true);
  });

  it("recognizes a strict tail split across PTY chunks without holding either chunk", () => {
    const recognizer = new WslInFrameCursorParkRecognizer();
    const first = "\x1b[?2026hbody\x1b[?25h\x1b[24;3H\x1b[?20";
    const second = "26lafter";

    const firstEmissions = recognizer.push(bytes(first));
    const secondEmissions = recognizer.push(bytes(second));

    expect(text(firstEmissions)).toBe(first);
    expect(firstEmissions.every((emission) => !emission.frameEndCursorAuthoritative)).toBe(true);
    expect(text(secondEmissions)).toBe(second);
    expect(decoder.decode(secondEmissions[0].data)).toBe("26l");
    expect(secondEmissions[0].frameEndCursorAuthoritative).toBe(true);
    expect(decoder.decode(secondEmissions[1].data)).toBe("after");
  });

  it("recognizes Codex 0.150+'s strict tail split around show and reset", () => {
    const recognizer = new WslInFrameCursorParkRecognizer();
    const first = "\x1b[?2026hbody\x1b[24;3H";
    const second = "\x1b[?25h\x1b[?20";
    const third = "26lafter";

    const firstEmissions = recognizer.push(bytes(first));
    const secondEmissions = recognizer.push(bytes(second));
    const thirdEmissions = recognizer.push(bytes(third));

    expect(text(firstEmissions)).toBe(first);
    expect(text(secondEmissions)).toBe(second);
    expect(
      [...firstEmissions, ...secondEmissions].every(
        (emission) => !emission.frameEndCursorAuthoritative,
      ),
    ).toBe(true);
    expect(text(thirdEmissions)).toBe(third);
    expect(decoder.decode(thirdEmissions[0].data)).toBe("26l");
    expect(thirdEmissions[0].frameEndCursorAuthoritative).toBe(true);
    expect(decoder.decode(thirdEmissions[1].data)).toBe("after");
  });

  it.each([
    ["0.145", "\x1b[?2026hbody\x1b[?25h\x1b[24;3H\x1b[?2026l"],
    ["0.150+", "\x1b[?2026hbody\x1b[24;3H\x1b[?25h\x1b[?2026l"],
  ])("recognizes Codex %s's strict tail at every PTY chunk boundary", (_version, input) => {
    for (let split = 1; split < input.length; split += 1) {
      const recognizer = new WslInFrameCursorParkRecognizer();
      const emissions = [
        ...recognizer.push(bytes(input.slice(0, split))),
        ...recognizer.push(bytes(input.slice(split))),
      ];

      expect(text(emissions)).toBe(input);
      expect(
        emissions.filter((emission) => emission.frameEndCursorAuthoritative === true),
      ).toHaveLength(1);
    }
  });

  it.each([
    ["show-first P+", "\x1b[?25h\x1b[2;3H\x1b[4;5f\x1b[9G\x1b[?2026l"],
    ["position-first P+", "\x1b[2;3H\x1b[4;5f\x1b[9G\x1b[?25h\x1b[?2026l"],
    ["position-first suffix", "\x1b[?25h\x1b[2;3H\x1b[?25h\x1b[?2026l"],
    ["show-first suffix", "\x1b[2;3H\x1b[?25h\x1b[9G\x1b[?2026l"],
  ])("recognizes the final %s after earlier candidate tokens", (_label, tail) => {
    const recognizer = new WslInFrameCursorParkRecognizer();
    const input = "\x1b[?2026hbody" + tail;

    const emissions = recognizer.push(bytes(input));

    expect(text(emissions)).toBe(input);
    expect(
      emissions.filter((emission) => emission.frameEndCursorAuthoritative === true),
    ).toHaveLength(1);
  });

  it.each([
    ["printable payload", "X"],
    ["another CSI", "\x1b[0m"],
    ["an OSC", "\x1b]0;title\x07"],
  ])("rejects an interrupted strict tail after %s", (_label, interruption) => {
    const recognizer = new WslInFrameCursorParkRecognizer();
    const input = "\x1b[?2026hbody\x1b[?25h\x1b[24;3H" + interruption + "\x1b[?2026l";

    const emissions = recognizer.push(bytes(input));

    expect(text(emissions)).toBe(input);
    expect(emissions.every((emission) => !emission.frameEndCursorAuthoritative)).toBe(true);
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
  ])("rejects Codex 0.150+'s strict tail interrupted by %s", (_label, tail) => {
    const recognizer = new WslInFrameCursorParkRecognizer();
    const input = "\x1b[?2026hbody" + tail;

    const emissions = recognizer.push(bytes(input));

    expect(text(emissions)).toBe(input);
    expect(emissions.every((emission) => !emission.frameEndCursorAuthoritative)).toBe(true);
  });

  it("does not treat a final position without cursor show as authoritative", () => {
    const recognizer = new WslInFrameCursorParkRecognizer();
    const input = "\x1b[?2026hbody\x1b[24;3H\x1b[?2026l";

    const emissions = recognizer.push(bytes(input));

    expect(text(emissions)).toBe(input);
    expect(emissions.every((emission) => !emission.frameEndCursorAuthoritative)).toBe(true);
  });

  it("reconsumes ESC that cancels a malformed CSI as the next position opener", () => {
    const input = "\x1b[?2026hbody\x1b[31\x1b[4;7H\x1b[?25h\x1b[?2026l";

    for (let split = 1; split < input.length; split += 1) {
      const recognizer = new WslInFrameCursorParkRecognizer();
      const emissions = [
        ...recognizer.push(bytes(input.slice(0, split))),
        ...recognizer.push(bytes(input.slice(split))),
      ];

      expect(text(emissions)).toBe(input);
      expect(
        emissions.filter((emission) => emission.frameEndCursorAuthoritative === true),
      ).toHaveLength(1);
    }
  });

  it("does not leak a frame past a reset that cancels a malformed CSI", () => {
    const input = "\x1b[?2026h\x1b[?25h\x1b[31\x1b[?2026l" + "outside\x1b[?25h\x1b[4;7H\x1b[?2026l";

    for (let split = 1; split < input.length; split += 1) {
      const recognizer = new WslInFrameCursorParkRecognizer();
      const emissions = [
        ...recognizer.push(bytes(input.slice(0, split))),
        ...recognizer.push(bytes(input.slice(split))),
      ];

      expect(text(emissions)).toBe(input);
      expect(emissions.every((emission) => !emission.frameEndCursorAuthoritative)).toBe(true);
    }
  });

  it.each(["\x1b[?2026;25l", "\x1b[?25;2026l"])(
    "closes the frame on combined DEC 2026 reset %j without leaking authority",
    (combinedReset) => {
      const input = "\x1b[?2026hbody" + combinedReset + "OUT\x1b[4;7H\x1b[?25h\x1b[?2026l";

      for (let split = 0; split <= input.length; split += 1) {
        const recognizer = new WslInFrameCursorParkRecognizer();
        const emissions = [
          ...recognizer.push(bytes(input.slice(0, split))),
          ...recognizer.push(bytes(input.slice(split))),
        ];

        expect(text(emissions)).toBe(input);
        expect(emissions.every((emission) => !emission.frameEndCursorAuthoritative)).toBe(true);
      }
    },
  );

  it.each([
    ["a canceled standalone CSI", "prefix\x1b[31\x1b[?2026hbody"],
    ["repeated standalone ESC", "prefix\x1b\x1b[?2026hbody"],
  ])("preserves %s before a following strict frame", (_label, prefix) => {
    const input = prefix + "\x1b[4;7H\x1b[?25h\x1b[?2026l";

    for (let split = 1; split < input.length; split += 1) {
      const recognizer = new WslInFrameCursorParkRecognizer();
      const emissions = [
        ...recognizer.push(bytes(input.slice(0, split))),
        ...recognizer.push(bytes(input.slice(split))),
      ];

      expect(text(emissions)).toBe(input);
      expect(
        emissions.filter((emission) => emission.frameEndCursorAuthoritative === true),
      ).toHaveLength(1);
    }
  });

  it("keeps metadata scoped away from an earlier non-authoritative reset in the same chunk", () => {
    const recognizer = new WslInFrameCursorParkRecognizer();
    const legacyFrame = "\x1b[?2026hlegacy\x1b[?2026l";
    const strictFrame = "\x1b[?2026hnew\x1b[?25h\x1b[4;7H\x1b[?2026l";

    const emissions = recognizer.push(bytes(legacyFrame + strictFrame));
    const authoritativeIndex = emissions.findIndex(
      (emission) => emission.frameEndCursorAuthoritative === true,
    );

    expect(text(emissions)).toBe(legacyFrame + strictFrame);
    expect(authoritativeIndex).toBeGreaterThan(0);
    expect(decoder.decode(emissions.slice(0, authoritativeIndex).at(-1)?.data)).toContain(
      legacyFrame,
    );
    expect(decoder.decode(emissions[authoritativeIndex].data)).toBe("\x1b[?2026l");
  });

  it("forgets partial framing on reset", () => {
    const recognizer = new WslInFrameCursorParkRecognizer();
    recognizer.push(bytes("\x1b[?2026hbody\x1b[?25h\x1b[4;7H\x1b[?20"));

    recognizer.reset();
    const emissions = recognizer.push(bytes("26l"));

    expect(text(emissions)).toBe("26l");
    expect(emissions.every((emission) => !emission.frameEndCursorAuthoritative)).toBe(true);
  });
});
