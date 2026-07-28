import { afterEach, describe, expect, it } from "vitest";
import { createScreenTerminal, type ScreenTerminal } from "@/test/screen/xterm-screen";
import type { TerminalOutputAppliedSegment } from "./terminal-output-attach-coordinator";
import { coalesceTerminalOutputSegments } from "./terminal-output-coalesce";

/**
 * Coalescing is only safe if it is invisible (issue #606, ADR-0079).
 *
 * The unit tests next door prove the coalescer's arithmetic. They cannot prove
 * the thing that actually matters: that streaming the merged segments into a VT
 * parser produces the same cell grid as streaming the originals. Escape sequences
 * split across delta boundaries, cursor addressing and wide characters all live
 * below the byte arithmetic, so this claim belongs in the screen tier (ADR-0074).
 */

const encoder = new TextEncoder();

const terminals: ScreenTerminal[] = [];

function screen() {
  const created = createScreenTerminal({ cols: 40, rows: 8, scrollback: 200 });
  terminals.push(created);
  return created;
}

afterEach(() => {
  while (terminals.length > 0) terminals.pop()?.dispose();
});

/** Cut a byte stream into deltas of `size` bytes, sequenced from 0. */
function shred(text: string, size: number): TerminalOutputAppliedSegment[] {
  const bytes = encoder.encode(text);
  const segments: TerminalOutputAppliedSegment[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    const slice = bytes.slice(offset, offset + size);
    segments.push({
      generation: 1,
      seqStart: offset,
      seqEnd: offset + slice.length,
      data: slice,
      geometry: { revision: 0, cols: 40, rows: 8 },
    });
  }
  return segments;
}

async function render(segments: readonly TerminalOutputAppliedSegment[]) {
  const target = screen();
  for (const segment of segments) await target.write(segment.data);
  return target.capture();
}

describe("coalesceTerminalOutputSegments on a real xterm", () => {
  it("renders cursor-addressed output identically after merging", async () => {
    const stream =
      "\x1b[2J\x1b[H" +
      "first line\r\n" +
      "\x1b[3;5Hplaced\x1b[K" +
      "\x1b[1;1H\x1b[31mred\x1b[0m" +
      "\x1b[5;1Hlast";
    // One byte per delta is the extreme of what a flood produces: every escape
    // sequence is split across several deltas.
    const shredded = shred(stream, 1);
    expect(shredded.length).toBeGreaterThan(40);

    const merged = coalesceTerminalOutputSegments(shredded);
    expect(merged).toHaveLength(1);

    expect(await render(merged)).toEqual(await render(shredded));
  });

  it("renders wrapping and scrollback identically after merging", async () => {
    let stream = "";
    for (let line = 0; line < 30; line += 1) {
      stream += `line-${line} ${"x".repeat(50)}\r\n`;
    }
    const shredded = shred(stream, 7);
    const merged = coalesceTerminalOutputSegments(shredded);
    expect(merged).toHaveLength(1);

    const mergedScreen = await render(merged);
    expect(mergedScreen).toEqual(await render(shredded));
    expect(mergedScreen.baseY).toBeGreaterThan(0);
  });

  it("renders wide characters identically when a delta splits a code point", async () => {
    const stream = "\x1b[H한글 混在 テスト\r\nascii tail";
    const shredded = shred(stream, 2);
    const merged = coalesceTerminalOutputSegments(shredded);

    expect(merged).toHaveLength(1);
    expect(await render(merged)).toEqual(await render(shredded));
  });

  it("renders alternate-buffer entry and exit identically after merging", async () => {
    const stream =
      "normal one\r\nnormal two\r\n" +
      "\x1b[?1049h\x1b[2J\x1b[Halt screen\x1b[3;1Hmore alt" +
      "\x1b[?1049l" +
      "back to normal\r\n";
    const shredded = shred(stream, 3);
    const merged = coalesceTerminalOutputSegments(shredded);

    expect(merged).toHaveLength(1);
    expect(await render(merged)).toEqual(await render(shredded));
  });

  it("still renders identically when a geometry change blocks the merge", async () => {
    const first = shred("\x1b[Hbefore resize\r\n", 4);
    const afterBytes = encoder.encode("\x1b[Hafter resize\r\n");
    const base = first[first.length - 1].seqEnd;
    const second: TerminalOutputAppliedSegment[] = [
      {
        generation: 1,
        seqStart: base,
        seqEnd: base + afterBytes.length,
        data: afterBytes,
        geometry: { revision: 1, cols: 40, rows: 8 },
      },
    ];
    const shredded = [...first, ...second];
    const merged = coalesceTerminalOutputSegments(shredded);

    // The revision boundary survives — the checkpoint model resizes there.
    expect(merged).toHaveLength(2);
    expect(merged[0].geometry.revision).toBe(0);
    expect(merged[1].geometry.revision).toBe(1);
    expect(await render(merged)).toEqual(await render(shredded));
  });
});
