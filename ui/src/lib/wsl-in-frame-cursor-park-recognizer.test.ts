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
