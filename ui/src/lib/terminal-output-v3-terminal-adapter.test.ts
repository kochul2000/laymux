import { describe, expect, it, vi } from "vitest";
import { normalizeTerminalOutputEnvelope } from "./terminal-output-envelope";
import { TerminalOutputV3TerminalAdapter } from "./terminal-output-v3-terminal-adapter";

function envelope(data = new Uint8Array([65, 66, 67, 68])) {
  return normalizeTerminalOutputEnvelope({
    version: 3,
    generation: 7,
    leaseToken: "lease-7",
    envelopeId: 11,
    grantId: null,
    seqStart: 20,
    seqEnd: 24,
    data,
    deltaEnds: [2, 4],
    geometryRuns: [
      { deltaIndex: 0, geometry: { revision: 3, cols: 80, rows: 24 } },
      { deltaIndex: 1, geometry: { revision: 4, cols: 100, rows: 30 } },
    ],
  });
}

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function setup() {
  const visible = deferred();
  const checkpoints = [deferred(), deferred()];
  const enqueueVisible = vi.fn(
    (_delta: unknown, onParsed: (() => void) | undefined, _onDiscard: (reason: string) => void) => {
      if (onParsed) void visible.promise.then(onParsed);
    },
  );
  const applyCheckpoint = vi
    .fn()
    .mockReturnValueOnce(checkpoints[0].promise)
    .mockReturnValueOnce(checkpoints[1].promise);
  const sendParsedRange = vi.fn().mockResolvedValue(true);
  const onFailStop = vi.fn();
  const adapter = new TerminalOutputV3TerminalAdapter({
    terminalId: "terminal-7",
    generation: 7,
    leaseToken: "lease-7",
    initialParsedSeq: 20,
    isCurrent: () => true,
    applyCheckpoint,
    enqueueVisible,
    sendParsedRange,
    onFailStop,
  });
  return {
    adapter,
    visible,
    checkpoints,
    enqueueVisible,
    applyCheckpoint,
    sendParsedRange,
    onFailStop,
  };
}

describe("TerminalOutputV3TerminalAdapter", () => {
  it("coalesces contiguous same-geometry deltas only for the checkpoint parser", () => {
    const value = normalizeTerminalOutputEnvelope({
      version: 3,
      generation: 7,
      leaseToken: "lease-7",
      envelopeId: 11,
      grantId: null,
      seqStart: 20,
      seqEnd: 24,
      data: new Uint8Array([65, 66, 67, 68]),
      deltaEnds: [1, 2, 3, 4],
      geometryRuns: [{ deltaIndex: 0, geometry: { revision: 3, cols: 80, rows: 24 } }],
    });
    const applyCheckpoint = vi.fn().mockResolvedValue(undefined);
    const enqueueVisible = vi.fn();
    const adapter = new TerminalOutputV3TerminalAdapter({
      terminalId: "terminal-7",
      generation: 7,
      leaseToken: "lease-7",
      initialParsedSeq: 20,
      isCurrent: () => true,
      applyCheckpoint,
      enqueueVisible,
      sendParsedRange: vi.fn().mockResolvedValue(true),
      onFailStop: vi.fn(),
    });

    adapter.transfer({ envelope: value, complete: vi.fn() });

    expect(enqueueVisible).toHaveBeenCalledTimes(4);
    expect(applyCheckpoint).toHaveBeenCalledTimes(1);
    expect(applyCheckpoint.mock.calls[0][0]).toMatchObject({
      generation: 7,
      leaseToken: "lease-7",
      envelopeId: 11,
      grantId: null,
      seqStart: 20,
      seqEnd: 24,
      geometry: { revision: 3, cols: 80, rows: 24 },
    });
    expect(applyCheckpoint.mock.calls[0][0].data).toEqual(new Uint8Array([65, 66, 67, 68]));
  });

  it("preserves contradictory dimensions for checkpoint validation", () => {
    const value = normalizeTerminalOutputEnvelope({
      version: 3,
      generation: 7,
      leaseToken: "lease-7",
      envelopeId: 11,
      grantId: null,
      seqStart: 20,
      seqEnd: 22,
      data: new Uint8Array([65, 66]),
      deltaEnds: [1, 2],
      geometryRuns: [
        { deltaIndex: 0, geometry: { revision: 3, cols: 80, rows: 24 } },
        { deltaIndex: 1, geometry: { revision: 3, cols: 100, rows: 30 } },
      ],
    });
    const applyCheckpoint = vi.fn().mockResolvedValue(undefined);
    const adapter = new TerminalOutputV3TerminalAdapter({
      terminalId: "terminal-7",
      generation: 7,
      leaseToken: "lease-7",
      initialParsedSeq: 20,
      isCurrent: () => true,
      applyCheckpoint,
      enqueueVisible: vi.fn(),
      sendParsedRange: vi.fn().mockResolvedValue(true),
      onFailStop: vi.fn(),
    });

    adapter.transfer({ envelope: value, complete: vi.fn() });

    expect(applyCheckpoint).toHaveBeenCalledTimes(2);
    expect(applyCheckpoint.mock.calls[1][0].geometry).toEqual({
      revision: 3,
      cols: 100,
      rows: 30,
    });
  });

  it("transfers original delta views and geometry before reporting acceptance", () => {
    const backing = new Uint8Array([65, 66, 67, 68]);
    const value = envelope(backing);
    const { adapter, enqueueVisible, applyCheckpoint } = setup();

    expect(adapter.preflight(value)).toEqual({ kind: "accepted" });
    expect(adapter.transfer({ envelope: value, complete: vi.fn() })).toEqual({
      acceptedDeltaCount: 2,
    });
    expect(enqueueVisible).toHaveBeenCalledTimes(2);
    expect(applyCheckpoint).toHaveBeenCalledTimes(2);
    expect(enqueueVisible.mock.calls[0][0].data.buffer).toBe(backing.buffer);
    expect(enqueueVisible.mock.calls[0][0].geometry).toEqual({ revision: 3, cols: 80, rows: 24 });
    expect(enqueueVisible.mock.calls[1][0].geometry).toEqual({
      revision: 4,
      cols: 100,
      rows: 30,
    });
  });

  it("completes only after visible and every checkpoint parser intersect", async () => {
    const value = envelope();
    const { adapter, visible, checkpoints } = setup();
    const complete = vi.fn();
    adapter.transfer({ envelope: value, complete });

    visible.resolve();
    checkpoints[0].resolve();
    await Promise.resolve();
    expect(complete).not.toHaveBeenCalled();
    checkpoints[1].resolve();
    await vi.waitFor(() =>
      expect(complete).toHaveBeenCalledWith({
        kind: "parsed",
        visibleSeq: 24,
        checkpointSeq: 24,
      }),
    );
  });

  it("turns a queue discard into one non-replayable envelope failure", async () => {
    const value = envelope();
    const { adapter, enqueueVisible } = setup();
    const complete = vi.fn();
    adapter.transfer({ envelope: value, complete });

    const discard = enqueueVisible.mock.calls[0][2] as (reason: string) => void;
    discard("queue_discarded");
    (enqueueVisible.mock.calls[1][2] as (reason: string) => void)("second_discard");
    await vi.waitFor(() =>
      expect(complete).toHaveBeenCalledWith({ kind: "discarded", reason: "queue_discarded" }),
    );
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("awaits backend-confirmed parsed credit and preserves contiguous ranges", async () => {
    const { adapter, sendParsedRange } = setup();
    await expect(
      adapter.sendParsedAck({
        terminalId: "terminal-7",
        generation: 7,
        leaseToken: "lease-7",
        seq: 24,
      }),
    ).resolves.toBe(true);
    expect(sendParsedRange).toHaveBeenCalledWith(20, 24);

    await expect(
      adapter.sendParsedAck({
        terminalId: "terminal-7",
        generation: 7,
        leaseToken: "lease-7",
        seq: 28,
      }),
    ).resolves.toBe(true);
    expect(sendParsedRange).toHaveBeenLastCalledWith(24, 28);
  });

  it("drops stale completion after disposal without invoking surface callbacks", async () => {
    const value = envelope();
    const { adapter, visible, checkpoints } = setup();
    const complete = vi.fn();
    adapter.transfer({ envelope: value, complete });
    adapter.dispose();
    visible.resolve();
    checkpoints.forEach((checkpoint) => checkpoint.resolve());
    await Promise.resolve();
    await Promise.resolve();

    expect(complete).not.toHaveBeenCalled();
  });
});
