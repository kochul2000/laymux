import { describe, expect, it } from "vitest";
import { normalBufferOnly } from "./terminal-output-cache";

describe("normalBufferOnly", () => {
  it("preserves a cache serialized from the normal buffer", () => {
    const cached = "first line\r\nsecond line\x1b[?2004h";

    expect(normalBufferOnly(cached)).toBe(cached);
  });

  it("drops SerializeAddon's unterminated alternate-buffer suffix", () => {
    const normal = "old scrollback\r\nlast normal line";
    const cached = `${normal}\x1b[?1049h\x1b[Hstale Claude frame\x1b[?2004h`;

    expect(normalBufferOnly(cached)).toBe(normal);
  });
});
