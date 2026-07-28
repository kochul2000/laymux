import { describe, expect, it } from "vitest";
import type { TerminalOutputAppliedSegment } from "./terminal-output-attach-coordinator";
import {
  TERMINAL_OUTPUT_COALESCE_MAX_BYTES,
  coalesceTerminalOutputSegments,
} from "./terminal-output-coalesce";

function segment(
  seqStart: number,
  bytes: number,
  overrides: Partial<TerminalOutputAppliedSegment> = {},
): TerminalOutputAppliedSegment {
  return {
    generation: 1,
    seqStart,
    seqEnd: seqStart + bytes,
    data: new Uint8Array(bytes).fill(0x61),
    geometry: { revision: 3, cols: 80, rows: 24 },
    ...overrides,
  };
}

describe("coalesceTerminalOutputSegments", () => {
  it("returns the input untouched when there is nothing to merge", () => {
    expect(coalesceTerminalOutputSegments([])).toEqual([]);
    const single = [segment(0, 4)];
    expect(coalesceTerminalOutputSegments(single)).toEqual(single);
  });

  it("merges contiguous same-generation same-geometry segments into one", () => {
    const merged = coalesceTerminalOutputSegments([segment(0, 3), segment(3, 5), segment(8, 2)]);

    expect(merged).toHaveLength(1);
    expect(merged[0].seqStart).toBe(0);
    expect(merged[0].seqEnd).toBe(10);
    expect(merged[0].data).toEqual(new Uint8Array(10).fill(0x61));
    expect(merged[0].geometry).toEqual({ revision: 3, cols: 80, rows: 24 });
  });

  it("keeps byte order exactly", () => {
    const first = segment(0, 0, { seqEnd: 3, data: new Uint8Array([1, 2, 3]) });
    const second = segment(3, 0, { seqStart: 3, seqEnd: 6, data: new Uint8Array([4, 5, 6]) });
    const merged = coalesceTerminalOutputSegments([first, second]);
    expect(merged[0].data).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]));
  });

  it("splits at a geometry revision change", () => {
    const merged = coalesceTerminalOutputSegments([
      segment(0, 3),
      segment(3, 3, { geometry: { revision: 4, cols: 80, rows: 12 } }),
      segment(6, 3, { geometry: { revision: 4, cols: 80, rows: 12 } }),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0].geometry.revision).toBe(3);
    expect(merged[0].seqEnd).toBe(3);
    expect(merged[1].geometry.revision).toBe(4);
    expect(merged[1].seqStart).toBe(3);
    expect(merged[1].seqEnd).toBe(9);
  });

  it("splits at a generation change", () => {
    const merged = coalesceTerminalOutputSegments([
      segment(0, 3),
      segment(3, 3, { generation: 2 }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it("splits at a sequence discontinuity instead of hiding it", () => {
    const merged = coalesceTerminalOutputSegments([segment(0, 3), segment(9, 3)]);
    expect(merged).toHaveLength(2);
    expect(merged[0].seqEnd).toBe(3);
    expect(merged[1].seqStart).toBe(9);
  });

  it("never builds a merged segment past the write chunk budget", () => {
    const chunk = TERMINAL_OUTPUT_COALESCE_MAX_BYTES / 4;
    const merged = coalesceTerminalOutputSegments([
      segment(0, chunk),
      segment(chunk, chunk),
      segment(chunk * 2, chunk),
      segment(chunk * 3, chunk),
      segment(chunk * 4, chunk),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0].data.length).toBe(TERMINAL_OUTPUT_COALESCE_MAX_BYTES);
    expect(merged[1].data.length).toBe(chunk);
    expect(merged[0].seqEnd).toBe(merged[1].seqStart);
  });

  it("drops empty segments rather than emitting zero-byte writes", () => {
    const merged = coalesceTerminalOutputSegments([
      segment(0, 0, { seqEnd: 0, data: new Uint8Array(0) }),
      segment(0, 4),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].data.length).toBe(4);
  });
});
