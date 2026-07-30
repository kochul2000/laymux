import { SerializeAddon } from "@xterm/addon-serialize";
import { afterEach, describe, expect, it } from "vitest";
import {
  TERMINAL_OUTPUT_BASE_CREDIT_BYTES,
  TERMINAL_OUTPUT_FRAME_CONTINUATION_MAX_BYTES,
  TerminalOutputFrameContinuationTracker,
  type TerminalOutputFrameContinuationTransition,
} from "./terminal-output-frame-continuation";
import {
  createScreenTerminal,
  diffScreens,
  type ScreenSnapshot,
  type ScreenTerminal,
} from "@/test/screen/xterm-screen";

const encoder = new TextEncoder();
const FRAME_OPEN = encoder.encode("\x1b[?2026h");
const FRAME_CLOSE = encoder.encode("\x1b[?2026l");
const PREAMBLE = encoder.encode("\x1b[2J\x1b[Hcontinuation baseline\r\n");
const SUFFIX = encoder.encode("\r\ncontinuation complete\x1b[K");
const BOUNDED_CHUNK_BYTES = 64 * 1024;

const terminals: ScreenTerminal[] = [];

interface RenderedTerminal {
  snapshot: ScreenSnapshot;
  serialized: string;
}

interface TrackedRender extends RenderedTerminal {
  transitions: readonly TerminalOutputFrameContinuationTransition[];
}

function screen(): { surface: ScreenTerminal; serializeAddon: SerializeAddon } {
  const surface = createScreenTerminal({ cols: 97, rows: 12, scrollback: 64 });
  const serializeAddon = new SerializeAddon();
  surface.terminal.loadAddon(serializeAddon);
  terminals.push(surface);
  return { surface, serializeAddon };
}

afterEach(() => {
  while (terminals.length > 0) terminals.pop()?.dispose();
});

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

function payload(byteLength: number): Uint8Array {
  return new Uint8Array(byteLength).fill(0x78);
}

function exactFrame(frameBytes: number): Uint8Array {
  const payloadBytes = frameBytes - FRAME_OPEN.byteLength - FRAME_CLOSE.byteLength;
  if (payloadBytes < 0) throw new RangeError("frame is smaller than its DECSET delimiters");
  return concat(FRAME_OPEN, payload(payloadBytes), FRAME_CLOSE);
}

function boundedChunks(data: Uint8Array): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.byteLength; offset += BOUNDED_CHUNK_BYTES) {
    chunks.push(data.subarray(offset, offset + BOUNDED_CHUNK_BYTES));
  }
  return chunks;
}

function normalChunks(frameBytes: number, tokenMode: "split" | "one-byte"): Uint8Array[] {
  const payloadBytes = frameBytes - FRAME_OPEN.byteLength - FRAME_CLOSE.byteLength;
  const chunks: Uint8Array[] = [PREAMBLE];
  if (tokenMode === "one-byte") {
    for (const byte of FRAME_OPEN) chunks.push(Uint8Array.of(byte));
  } else {
    chunks.push(FRAME_OPEN.subarray(0, 5), FRAME_OPEN.subarray(5));
  }
  chunks.push(...boundedChunks(payload(payloadBytes)));
  if (tokenMode === "one-byte") {
    for (const byte of FRAME_CLOSE) chunks.push(Uint8Array.of(byte));
  } else {
    chunks.push(FRAME_CLOSE.subarray(0, 3), FRAME_CLOSE.subarray(3));
  }
  chunks.push(SUFFIX);
  return chunks;
}

async function renderBaseline(raw: Uint8Array): Promise<RenderedTerminal> {
  const { surface, serializeAddon } = screen();
  for (const chunk of boundedChunks(raw)) await surface.write(chunk);
  return {
    snapshot: surface.capture(),
    serialized: serializeAddon.serialize({ scrollback: 64 }),
  };
}

async function renderTracked(
  chunks: readonly Uint8Array[],
  options: { flushAt?: { afterChunk: number; now: number } } = {},
): Promise<TrackedRender> {
  const { surface, serializeAddon } = screen();
  const tracker = new TerminalOutputFrameContinuationTracker({
    surface: "active",
    terminalId: "screen-terminal",
    generation: 1,
    leaseToken: "screen-lease",
    createGrantId: () => "screen-grant",
  });
  const transitions: TerminalOutputFrameContinuationTransition[] = [];
  let sourceSeq = 0;
  for (const [index, chunk] of chunks.entries()) {
    const observation = tracker.observe({
      data: chunk,
      sourceStartSeq: sourceSeq,
      envelopeId: index + 1,
      healthyLiveSurface: true,
      now: index,
    });
    expect(observation.forward).toBe(chunk);
    transitions.push(...observation.transitions);
    await surface.write(observation.forward);
    sourceSeq += chunk.byteLength;
    if (options.flushAt?.afterChunk === index) {
      transitions.push(...tracker.flushExpired(options.flushAt.now));
    }
  }
  expect(tracker.expectedSourceSeq).toBe(sourceSeq);
  return {
    snapshot: surface.capture(),
    serialized: serializeAddon.serialize({ scrollback: 64 }),
    transitions,
  };
}

function expectByteExactScreen(baseline: RenderedTerminal, tracked: TrackedRender): void {
  const visibleText = baseline.snapshot.viewport.map((row) => row.text).join("\n");
  expect(visibleText).toContain("continuation complete");
  expect(baseline.serialized).toContain("continuation complete");
  expect(diffScreens(baseline.snapshot, tracked.snapshot)).toBeNull();
  expect(tracked.snapshot.cursor).toEqual(baseline.snapshot.cursor);
  expect(tracked.snapshot.viewport).toEqual(baseline.snapshot.viewport);
  expect(tracked.serialized).toBe(baseline.serialized);
}

describe("v3 DECSET 2026 continuation on a real xterm", () => {
  it.each([
    TERMINAL_OUTPUT_BASE_CREDIT_BYTES + 1,
    768 * 1024,
    TERMINAL_OUTPUT_FRAME_CONTINUATION_MAX_BYTES,
  ])(
    "split frame %i bytes가 raw baseline과 cell/cursor/buffer-identical하다",
    async (frameBytes) => {
      const chunks = normalChunks(frameBytes, "split");
      const raw = concat(...chunks);

      const baseline = await renderBaseline(raw);
      const tracked = await renderTracked(chunks);

      expect(raw.subarray(PREAMBLE.byteLength, PREAMBLE.byteLength + frameBytes)).toEqual(
        exactFrame(frameBytes),
      );
      expect(tracked.transitions).toMatchObject([
        { type: "opened", frameStartSeq: PREAMBLE.byteLength },
        {
          type: "closed",
          frameStartSeq: PREAMBLE.byteLength,
          frameEndSeq: PREAMBLE.byteLength + frameBytes,
          frameBytes,
          outcome: "complete",
          reason: "terminator",
          grantResult: "close",
        },
      ]);
      expectByteExactScreen(baseline, tracked);
    },
  );

  it.each([
    TERMINAL_OUTPUT_BASE_CREDIT_BYTES + 1,
    768 * 1024,
    TERMINAL_OUTPUT_FRAME_CONTINUATION_MAX_BYTES,
  ])(
    "token 1-byte frame %i bytes가 raw baseline과 cell/cursor/buffer-identical하다",
    async (frameBytes) => {
      const chunks = normalChunks(frameBytes, "one-byte");
      const raw = concat(...chunks);

      const baseline = await renderBaseline(raw);
      const tracked = await renderTracked(chunks);

      expect(tracked.transitions).toMatchObject([
        { type: "opened", frameStartSeq: PREAMBLE.byteLength },
        {
          type: "closed",
          frameEndSeq: PREAMBLE.byteLength + frameBytes,
          frameBytes,
          outcome: "complete",
          grantResult: "close",
        },
      ]);
      expectByteExactScreen(baseline, tracked);
    },
  );

  it("malformed frame을 raw 그대로 fail-open해 xterm 결과를 바꾸지 않는다", async () => {
    const malformed = encoder.encode("\x1b[?2026x");
    const chunks = [
      PREAMBLE,
      ...Array.from(FRAME_OPEN, (byte) => Uint8Array.of(byte)),
      payload(4096),
    ];
    chunks.push(
      ...Array.from(malformed, (byte) => Uint8Array.of(byte)),
      payload(2048),
      FRAME_CLOSE,
      SUFFIX,
    );
    const raw = concat(...chunks);

    const baseline = await renderBaseline(raw);
    const tracked = await renderTracked(chunks);

    expect(tracked.transitions).toMatchObject([
      { type: "opened" },
      { type: "closed", outcome: "fail-open", reason: "malformed", grantResult: "abort" },
    ]);
    expectByteExactScreen(baseline, tracked);
  });

  it("timeout frame을 raw 그대로 fail-open해 xterm 결과를 바꾸지 않는다", async () => {
    const beforeTimeout = concat(PREAMBLE, FRAME_OPEN, payload(4096));
    const afterTimeout = concat(payload(2048), FRAME_CLOSE, SUFFIX);
    const chunks = [beforeTimeout, afterTimeout];
    const raw = concat(...chunks);

    const baseline = await renderBaseline(raw);
    const tracked = await renderTracked(chunks, { flushAt: { afterChunk: 0, now: 50 } });

    expect(tracked.transitions).toMatchObject([
      { type: "opened" },
      { type: "closed", outcome: "fail-open", reason: "timeout", grantResult: "abort" },
    ]);
    expectByteExactScreen(baseline, tracked);
  });

  it("1 MiB + 1 byte frame을 raw 그대로 fail-open해 xterm 결과를 바꾸지 않는다", async () => {
    const frameBytes = TERMINAL_OUTPUT_FRAME_CONTINUATION_MAX_BYTES + 1;
    const chunks = normalChunks(frameBytes, "split");
    const raw = concat(...chunks);

    const baseline = await renderBaseline(raw);
    const tracked = await renderTracked(chunks);

    expect(tracked.transitions).toMatchObject([
      { type: "opened", frameStartSeq: PREAMBLE.byteLength },
      {
        type: "closed",
        frameEndSeq: PREAMBLE.byteLength + frameBytes,
        frameBytes,
        outcome: "fail-open",
        reason: "oversized",
        grantResult: "abort",
      },
    ]);
    expectByteExactScreen(baseline, tracked);
  });
});
