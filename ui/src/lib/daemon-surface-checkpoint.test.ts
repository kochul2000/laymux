import { describe, expect, it } from "vitest";
import { normalizeTerminalOutputAttachment } from "./terminal-output-attach-coordinator";

const parserState = {
  version: 1,
  charset: null,
  charsets: [null, null, null, null],
  glevel: 0,
  normal: { tabs: [8, 16], savedCharset: null },
  alternate: { tabs: [8, 16], savedCharset: null },
  mouseEncoding: "DEFAULT",
};
const fixture = () => ({
  state: {
    version: 1,
    generation: 9,
    snapshotStartSeq: 0,
    snapshotSeq: 3,
    sourceStartSeq: 0,
    sourceSeq: 3,
    snapshotKind: "screen" as const,
    protocolRevision: 0,
    modes: { bracketedPaste: true },
    geometry: { revision: 4, cols: 80, rows: 24 },
  },
  snapshot: [65, 66, 67],
  daemon: {
    version: 1 as const,
    incarnation: "12345678-1234-1234-1234-123456789abc",
    nativeGeneration: 6,
    sourceSeq: 800000,
    parserState,
    pendingBytes: [27, 91],
  },
});
describe("daemon projection checkpoint admission", () => {
  it("keeps native source sequence separate from GUI delivery bytes", () => {
    const normalized = normalizeTerminalOutputAttachment(fixture());
    expect(normalized.snapshot).toEqual(new Uint8Array([65, 66, 67]));
    expect(normalized.daemon?.sourceSeq).toBe(800000);
    expect(normalized.daemon?.pendingBytes).toEqual([27, 91]);
  });
  it.each([
    { nativeGeneration: 0 },
    { sourceSeq: -1 },
    { incarnation: "" },
    { version: 2 },
    { pendingBytes: [256] },
    { pendingBytes: [-1] },
    { parserState: { ...parserState, glevel: 4 } },
    { parserState: { ...parserState, mouseEncoding: "arbitrary" } },
    { parserState: { ...parserState, normal: { tabs: [4096], savedCharset: null } } },
    { parserState: { ...parserState, charset: JSON.parse('{"__proto__":"x"}') } },
  ])("rejects malformed daemon state before any screen write (%j)", (patch) => {
    const value = fixture();
    expect(() =>
      normalizeTerminalOutputAttachment({ ...value, daemon: { ...value.daemon, ...patch } }),
    ).toThrow();
  });
});
