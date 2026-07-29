import { describe, expect, it, vi } from "vitest";
import {
  TERMINAL_OUTPUT_BASE_CREDIT_BYTES,
  TERMINAL_OUTPUT_FRAME_CONTINUATION_MAX_BYTES,
  TerminalOutputFrameContinuationTracker,
  type TerminalOutputFrameContinuationTransition,
  type TerminalOutputFrameContinuationTrackerOptions,
} from "./terminal-output-frame-continuation";

const encoder = new TextEncoder();
const FRAME_OPEN = encoder.encode("\x1b[?2026h");
const FRAME_CLOSE = encoder.encode("\x1b[?2026l");

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const length = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.byteLength;
  }
  return joined;
}

function frameOfSize(byteLength: number): Uint8Array {
  const payloadLength = byteLength - FRAME_OPEN.byteLength - FRAME_CLOSE.byteLength;
  if (payloadLength < 0) throw new Error("frame size is smaller than its delimiters");
  return concat(FRAME_OPEN, new Uint8Array(payloadLength).fill(0x78), FRAME_CLOSE);
}

function options(
  overrides: Partial<TerminalOutputFrameContinuationTrackerOptions> = {},
): TerminalOutputFrameContinuationTrackerOptions {
  return {
    surface: "active",
    terminalId: "terminal-1",
    generation: 7,
    leaseToken: "lease-7",
    createGrantId: vi.fn(() => "grant-1"),
    ...overrides,
  };
}

function transitionsOf(
  tracker: TerminalOutputFrameContinuationTracker,
  data: Uint8Array,
  sourceStartSeq: number,
  now: number,
  envelopeId = 1,
  healthyLiveSurface = true,
): readonly TerminalOutputFrameContinuationTransition[] {
  const observation = tracker.observe({
    data,
    sourceStartSeq,
    envelopeId,
    now,
    healthyLiveSurface,
  });
  expect(observation.forward).toBe(data);
  expect(observation.forward).toEqual(data);
  return observation.transitions;
}

describe("TerminalOutputFrameContinuationTracker", () => {
  it("bootstrap에서는 열린 frame을 추적하되 continuation grant를 만들지 않는다", () => {
    const createGrantId = vi.fn(() => "must-not-be-used");
    const tracker = new TerminalOutputFrameContinuationTracker(
      options({ surface: "bootstrap", createGrantId }),
    );
    const input = frameOfSize(TERMINAL_OUTPUT_BASE_CREDIT_BYTES + 1);

    const transitions = transitionsOf(tracker, input, 200, 10);

    expect(transitions).toEqual([
      {
        type: "opened",
        frameStartSeq: 200,
        maxFrameEndSeq: 200 + TERMINAL_OUTPUT_FRAME_CONTINUATION_MAX_BYTES,
        grant: null,
      },
      {
        type: "closed",
        envelopeId: 1,
        frameStartSeq: 200,
        frameEndSeq: 200 + input.byteLength,
        frameBytes: input.byteLength,
        outcome: "complete",
        reason: "terminator",
        grant: null,
        grantResult: null,
      },
    ]);
    expect(createGrantId).not.toHaveBeenCalled();
  });

  it.each(["active", "reattach"] as const)(
    "%s surface는 opener envelope에 고정된 immutable grant identity를 한 번만 만든다",
    (surface) => {
      const createGrantId = vi.fn(() => `${surface}-grant`);
      const tracker = new TerminalOutputFrameContinuationTracker(
        options({ surface, createGrantId }),
      );

      const first = transitionsOf(tracker, FRAME_OPEN.subarray(0, 3), 1_000, 20, 11);
      expect(first).toEqual([]);
      const opened = transitionsOf(tracker, FRAME_OPEN.subarray(3), 1_003, 21, 12);
      expect(tracker.deadline).toBe(70);
      const closed = transitionsOf(tracker, FRAME_CLOSE, 1_008, 22, 13);

      expect(opened).toHaveLength(1);
      expect(opened[0]).toMatchObject({
        type: "opened",
        frameStartSeq: 1_000,
        grant: {
          terminalId: "terminal-1",
          generation: 7,
          leaseToken: "lease-7",
          envelopeId: 11,
          grantId: `${surface}-grant`,
        },
      });
      expect(Object.isFrozen(opened[0].grant)).toBe(true);
      expect(closed[0]).toMatchObject({
        type: "closed",
        envelopeId: 13,
        outcome: "complete",
        reason: "terminator",
        grantResult: "close",
      });
      expect(closed[0].grant).toBe(opened[0].grant);
      expect(createGrantId).toHaveBeenCalledOnce();
      expect(createGrantId).toHaveBeenCalledWith({
        terminalId: "terminal-1",
        generation: 7,
        leaseToken: "lease-7",
        envelopeId: 11,
        frameStartSeq: 1_000,
      });
    },
  );

  it("active snapshot에서 시작한 opener는 live healthy 판정 전 grant하지 않는다", () => {
    const createGrantId = vi.fn(() => "must-not-be-used");
    const tracker = new TerminalOutputFrameContinuationTracker(options({ createGrantId }));

    expect(transitionsOf(tracker, FRAME_OPEN.subarray(0, 3), 2_000, 10, 21, false)).toEqual([]);
    const opened = transitionsOf(tracker, FRAME_OPEN.subarray(3), 2_003, 11, 22, true);
    const closed = transitionsOf(tracker, FRAME_CLOSE, 2_008, 12, 23, true);

    expect(opened[0]).toMatchObject({ type: "opened", grant: null });
    expect(closed[0]).toMatchObject({
      type: "closed",
      outcome: "complete",
      grant: null,
      grantResult: null,
    });
    expect(createGrantId).not.toHaveBeenCalled();
  });

  it.each([
    TERMINAL_OUTPUT_BASE_CREDIT_BYTES + 1,
    768 * 1024,
    TERMINAL_OUTPUT_FRAME_CONTINUATION_MAX_BYTES,
  ])("정상 DECSET 2026 frame %i bytes를 timeout 없이 정확히 닫는다", (frameBytes) => {
    const tracker = new TerminalOutputFrameContinuationTracker(options());
    const input = frameOfSize(frameBytes);
    const transitions = transitionsOf(tracker, input, 9_000, 49);

    expect(transitions.at(-1)).toMatchObject({
      type: "closed",
      frameStartSeq: 9_000,
      frameEndSeq: 9_000 + frameBytes,
      frameBytes,
      outcome: "complete",
      reason: "terminator",
      grantResult: "close",
    });
    expect(tracker.deadline).toBeUndefined();
  });

  it.each([
    TERMINAL_OUTPUT_BASE_CREDIT_BYTES + 1,
    768 * 1024,
    TERMINAL_OUTPUT_FRAME_CONTINUATION_MAX_BYTES,
  ])("refreshes the timeout on byte progress for a %i-byte frame", (frameBytes) => {
    const tracker = new TerminalOutputFrameContinuationTracker(options({ timeoutMs: 50 }));
    const input = frameOfSize(frameBytes);
    const transitions: TerminalOutputFrameContinuationTransition[] = [];
    let offset = 0;
    let envelopeId = 1;
    while (offset < input.byteLength) {
      const end = Math.min(offset + 64 * 1024, input.byteLength);
      transitions.push(
        ...transitionsOf(
          tracker,
          input.subarray(offset, end),
          20_000 + offset,
          (envelopeId - 1) * 40,
          envelopeId,
        ),
      );
      offset = end;
      envelopeId += 1;
    }

    expect(transitions.at(-1)).toMatchObject({
      type: "closed",
      envelopeId: envelopeId - 1,
      outcome: "complete",
      reason: "terminator",
      frameBytes,
    });
  });

  it("uses the transition envelope for close, malformed, oversized, and last-progress timeout", () => {
    const closed = new TerminalOutputFrameContinuationTracker(options());
    transitionsOf(closed, FRAME_OPEN, 0, 0, 1);
    transitionsOf(closed, encoder.encode("body"), 8, 1, 2);
    expect(transitionsOf(closed, FRAME_CLOSE, 12, 2, 3)[0]).toMatchObject({
      type: "closed",
      envelopeId: 3,
      reason: "terminator",
    });

    const malformed = new TerminalOutputFrameContinuationTracker(options());
    transitionsOf(malformed, FRAME_OPEN, 0, 0, 1);
    transitionsOf(malformed, encoder.encode("body"), 8, 1, 2);
    expect(transitionsOf(malformed, FRAME_OPEN, 12, 2, 3)[0]).toMatchObject({
      type: "closed",
      envelopeId: 3,
      reason: "malformed",
    });

    const oversized = new TerminalOutputFrameContinuationTracker(options({ maxFrameBytes: 16 }));
    transitionsOf(oversized, FRAME_OPEN, 0, 0, 1);
    transitionsOf(oversized, new Uint8Array(8), 8, 1, 2);
    expect(transitionsOf(oversized, new Uint8Array([65]), 16, 2, 3)[0]).toMatchObject({
      type: "closed",
      envelopeId: 3,
      reason: "oversized",
    });

    const timeout = new TerminalOutputFrameContinuationTracker(options({ timeoutMs: 50 }));
    transitionsOf(timeout, FRAME_OPEN, 0, 0, 1);
    transitionsOf(timeout, encoder.encode("body"), 8, 40, 2);
    expect(timeout.flushExpired(90)[0]).toMatchObject({
      type: "closed",
      envelopeId: 2,
      reason: "timeout",
    });
  });

  it("opener와 terminator가 split되어도 raw source sequence를 보존한다", () => {
    const tracker = new TerminalOutputFrameContinuationTracker(options());
    const chunks = [
      encoder.encode("prefix\x1b[?"),
      encoder.encode("20"),
      encoder.encode("26hbody\x1b[?20"),
      encoder.encode("26lpostfix"),
    ];
    const allTransitions: TerminalOutputFrameContinuationTransition[] = [];
    let sequence = 50;
    for (const [index, chunk] of chunks.entries()) {
      allTransitions.push(...transitionsOf(tracker, chunk, sequence, index, index + 1));
      sequence += chunk.byteLength;
    }

    expect(allTransitions).toMatchObject([
      { type: "opened", frameStartSeq: 56 },
      {
        type: "closed",
        envelopeId: 4,
        frameStartSeq: 56,
        frameEndSeq: 56 + FRAME_OPEN.byteLength + 4 + FRAME_CLOSE.byteLength,
        frameBytes: FRAME_OPEN.byteLength + 4 + FRAME_CLOSE.byteLength,
        outcome: "complete",
      },
    ]);
    expect(allTransitions[0].grant?.envelopeId).toBe(1);
  });

  it("1-byte chunk에서도 opener/terminator를 한 번만 인식한다", () => {
    const tracker = new TerminalOutputFrameContinuationTracker(options());
    const input = frameOfSize(257);
    const transitions: TerminalOutputFrameContinuationTransition[] = [];
    for (let index = 0; index < input.byteLength; index += 1) {
      transitions.push(
        ...transitionsOf(
          tracker,
          input.subarray(index, index + 1),
          4_000 + index,
          10,
          Math.floor(index / 64) + 1,
        ),
      );
    }

    expect(transitions).toHaveLength(2);
    expect(transitions[0]).toMatchObject({ type: "opened", frameStartSeq: 4_000 });
    expect(transitions[1]).toMatchObject({
      type: "closed",
      frameEndSeq: 4_257,
      frameBytes: 257,
      outcome: "complete",
    });
  });

  it("OSC와 DCS payload 안의 DECSET-looking bytes는 frame으로 해석하지 않는다", () => {
    const tracker = new TerminalOutputFrameContinuationTracker(options());
    const input = encoder.encode(
      "\x1b]0;fake \x1b[?2026h title\x07" + "\x1bPfake \x1b[?2026l payload\x1b\\" + "plain",
    );

    expect(transitionsOf(tracker, input, 0, 0)).toEqual([]);
  });

  it("중첩 opener를 malformed로 byte-exact fail-open하고 동일 grant를 abort한다", () => {
    const tracker = new TerminalOutputFrameContinuationTracker(options());
    const input = encoder.encode("\x1b[?2026hbody\x1b[?2026hrest\x1b[?2026l");
    const before = Uint8Array.from(input);

    const transitions = transitionsOf(tracker, input, 300, 10);

    expect(Array.from(input)).toEqual(Array.from(before));
    expect(transitions).toHaveLength(2);
    expect(transitions[1]).toMatchObject({
      type: "closed",
      outcome: "fail-open",
      reason: "malformed",
      grantResult: "abort",
      frameStartSeq: 300,
      frameEndSeq: 300 + FRAME_OPEN.byteLength + 4 + FRAME_OPEN.byteLength,
    });
    expect(transitions[1].grant).toBe(transitions[0].grant);
  });

  it("timeout 시 이미 전달한 raw bytes를 재작성하지 않고 동일 grant를 abort한다", () => {
    const tracker = new TerminalOutputFrameContinuationTracker(options({ timeoutMs: 50 }));
    const prefix = encoder.encode("\x1b[?2026hpayload");
    const opened = transitionsOf(tracker, prefix, 700, 100);
    expect(tracker.flushExpired(149)).toEqual([]);

    const expired = tracker.flushExpired(150);

    expect(expired).toEqual([
      {
        type: "closed",
        envelopeId: 1,
        frameStartSeq: 700,
        frameEndSeq: 700 + prefix.byteLength,
        frameBytes: prefix.byteLength,
        outcome: "fail-open",
        reason: "timeout",
        grant: opened[0].grant,
        grantResult: "abort",
      },
    ]);
    const suffix = encoder.encode("tail\x1b[?2026l");
    expect(transitionsOf(tracker, suffix, 700 + prefix.byteLength, 151)).toEqual([]);
  });

  it("1 MiB + 1 byte에서 mutation 없이 oversized fail-open하고 grant를 abort한다", () => {
    const tracker = new TerminalOutputFrameContinuationTracker(options());
    const input = frameOfSize(TERMINAL_OUTPUT_FRAME_CONTINUATION_MAX_BYTES + 1);
    const before = Uint8Array.from(input);

    const transitions = transitionsOf(tracker, input, 5_000, 0);

    expect(Array.from(input)).toEqual(Array.from(before));
    expect(transitions).toHaveLength(2);
    expect(transitions[1]).toMatchObject({
      type: "closed",
      frameStartSeq: 5_000,
      frameEndSeq: 5_000 + TERMINAL_OUTPUT_FRAME_CONTINUATION_MAX_BYTES + 1,
      frameBytes: TERMINAL_OUTPUT_FRAME_CONTINUATION_MAX_BYTES + 1,
      outcome: "fail-open",
      reason: "oversized",
      grantResult: "abort",
    });
    expect(transitions[1].grant).toBe(transitions[0].grant);
  });

  it("source sequence gap은 tracker 상태를 바꾸기 전에 거절한다", () => {
    const tracker = new TerminalOutputFrameContinuationTracker(options());
    transitionsOf(tracker, FRAME_OPEN.subarray(0, 3), 100, 0);

    expect(() => transitionsOf(tracker, FRAME_OPEN.subarray(3), 104, 1)).toThrow(
      /contiguous source sequence/,
    );
    expect(tracker.expectedSourceSeq).toBe(103);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "envelopeId %s는 positive safe integer가 아니므로 상태 변경 전 거절한다",
    (envelopeId) => {
      const tracker = new TerminalOutputFrameContinuationTracker(options());

      expect(() => transitionsOf(tracker, FRAME_OPEN, 100, 0, envelopeId)).toThrow(
        /envelopeId must be a positive safe integer/,
      );
      expect(tracker.expectedSourceSeq).toBeUndefined();
    },
  );
});
