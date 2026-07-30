import { beforeEach, describe, expect, it, vi } from "vitest";

import { TerminalOutputControlOperationRegistry } from "./terminal-output-control-registry";
import {
  TerminalOutputV3Runtime,
  type TerminalOutputV3RepairResponse,
  type TerminalOutputV3RuntimeOptions,
} from "./terminal-output-v3-runtime";
import {
  acknowledgeTerminalOutputEnvelope,
  closeTerminalOutputContinuation,
  holdTerminalOutputContinuation,
} from "./tauri-api";

vi.mock("./tauri-api", () => ({
  acknowledgeTerminalOutputEnvelope: vi.fn(() => Promise.resolve(true)),
  closeTerminalOutputContinuation: vi.fn(() => Promise.resolve(true)),
  holdTerminalOutputContinuation: vi.fn(() => Promise.resolve(true)),
}));

const mockAcknowledgeTerminalOutputEnvelope = vi.mocked(acknowledgeTerminalOutputEnvelope);
const mockCloseTerminalOutputContinuation = vi.mocked(closeTerminalOutputContinuation);
const mockHoldTerminalOutputContinuation = vi.mocked(holdTerminalOutputContinuation);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function payload(envelopeId: number, seqStart: number, text: string) {
  const data = Array.from(new TextEncoder().encode(text));
  return {
    version: 3,
    generation: 4,
    leaseToken: "lease-4",
    envelopeId,
    grantId: null,
    seqStart,
    seqEnd: seqStart + data.length,
    data,
    deltaEnds: [data.length],
    geometryRuns: [{ deltaIndex: 0, geometry: { revision: 2, cols: 100, rows: 30 } }],
  };
}

function harness(
  repairEnvelope: TerminalOutputV3RuntimeOptions["repairEnvelope"],
  options?: {
    current?: { value: boolean };
    controlTimeoutMs?: number;
    pendingVisibleParsers?: Array<() => void>;
  },
) {
  const current = options?.current ?? { value: true };
  const visible: string[] = [];
  const checkpoints: string[] = [];
  const failStops: string[] = [];
  const registry = new TerminalOutputControlOperationRegistry();
  const runtime = new TerminalOutputV3Runtime({
    terminalId: "term-1",
    generation: 4,
    leaseToken: "lease-4",
    attachEpoch: 1,
    initialSeq: 0,
    initialEnvelopeId: 1,
    controlTimeoutMs: options?.controlTimeoutMs ?? 100,
    scope: registry.mount("term-1"),
    isCurrent: () => current.value,
    getLifecycleFacts: () => ({
      parsersReady: true,
      disposed: !current.value,
      failStoppedReason: null,
      stabilizerHolding: false,
      capacityWaiting: false,
    }),
    applyCheckpoint(delta) {
      checkpoints.push(new TextDecoder().decode(delta.data));
      return Promise.resolve();
    },
    enqueueVisible(delta, onParsed) {
      visible.push(new TextDecoder().decode(delta.data));
      if (onParsed && options?.pendingVisibleParsers) {
        options.pendingVisibleParsers.push(onParsed);
      } else {
        onParsed?.();
      }
    },
    sendParsedRange: () => Promise.resolve(true),
    repairEnvelope,
    onFailStop: (reason) => failStops.push(reason),
  });
  return { runtime, current, visible, checkpoints, failStops };
}

describe("TerminalOutputV3Runtime exact repair", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAcknowledgeTerminalOutputEnvelope.mockResolvedValue(true);
    mockHoldTerminalOutputContinuation.mockResolvedValue(true);
  });

  it("queues the bounded ordered pipeline while an opener control gates its first successor", async () => {
    const hold = deferred<boolean>();
    mockHoldTerminalOutputContinuation.mockReturnValueOnce(hold.promise);
    const repair = vi.fn(() => Promise.resolve({ status: "idle" as const, envelope: null }));
    const h = harness(repair);
    const opener = "\u001b[?2026h";

    const first = h.runtime.receive(payload(1, 0, opener), 1);
    await vi.waitFor(() => expect(mockHoldTerminalOutputContinuation).toHaveBeenCalledOnce());
    const grantId = mockHoldTerminalOutputContinuation.mock.calls[0]?.[4];
    const successor = (envelopeId: number, seqStart: number, text: string) => ({
      ...payload(envelopeId, seqStart, text),
      grantId,
    });
    const second = h.runtime.receive(successor(2, opener.length, "B"), 2);
    const third = h.runtime.receive(successor(3, opener.length + 1, "C"), 3);
    const fourth = h.runtime.receive(successor(4, opener.length + 2, "D"), 4);

    hold.resolve(true);

    await expect(Promise.all([first, second, third, fourth])).resolves.toEqual([
      { kind: "accepted", envelopeId: 1 },
      { kind: "accepted", envelopeId: 2 },
      { kind: "accepted", envelopeId: 3 },
      { kind: "accepted", envelopeId: 4 },
    ]);
    expect(repair).not.toHaveBeenCalled();
    expect(h.visible).toEqual([opener, "B", "C", "D"]);
    expect(h.failStops).toEqual([]);
    expect(h.runtime.diagnostics()).toMatchObject({
      admittedSeq: opener.length + 3,
      nextEnvelopeId: 5,
    });
  });

  it("repairs one omitted envelope and then admits only its exact observed successor", async () => {
    const repair = vi.fn(() =>
      Promise.resolve<TerminalOutputV3RepairResponse>({
        status: "exact",
        envelope: payload(2, 1, "B"),
      }),
    );
    const h = harness(repair);

    await expect(h.runtime.receive(payload(1, 0, "A"), 1)).resolves.toMatchObject({
      kind: "accepted",
    });
    await expect(h.runtime.receive(payload(3, 2, "C"), 2)).resolves.toEqual({
      kind: "accepted",
      envelopeId: 3,
    });

    expect(repair).toHaveBeenCalledTimes(1);
    expect(repair).toHaveBeenCalledWith({
      terminalId: "term-1",
      generation: 4,
      token: "lease-4",
      envelopeId: 2,
      grantId: null,
      seqStart: 1,
    });
    expect(h.visible).toEqual(["A", "B", "C"]);
    expect(h.checkpoints).toEqual(["A", "B", "C"]);
    expect(h.runtime.diagnostics()).toMatchObject({
      admittedSeq: 3,
      nextEnvelopeId: 4,
      repairCount: 1,
      lastRepairReason: "event-gap:exact",
    });
  });

  it("deduplicates an exact event that wins the repair race", async () => {
    const response = deferred<TerminalOutputV3RepairResponse>();
    const repair = vi.fn(() => response.promise);
    const h = harness(repair);
    await h.runtime.receive(payload(1, 0, "A"), 1);

    const polling = h.runtime.pollExactRepair(2);
    await Promise.resolve();
    await h.runtime.receive(payload(2, 1, "B"), 3);
    response.resolve({ status: "exact", envelope: payload(2, 1, "B") });
    await polling;

    expect(h.visible).toEqual(["A", "B"]);
    expect(h.checkpoints).toEqual(["A", "B"]);
    expect(h.failStops).toEqual([]);
    expect(h.runtime.diagnostics()).toMatchObject({ repairCount: 0, lastRepairReason: null });
  });

  it("accepts alreadyReceipted only for the immutable envelope admitted during the race", async () => {
    const response = deferred<TerminalOutputV3RepairResponse>();
    const h = harness(() => response.promise);
    await h.runtime.receive(payload(1, 0, "A"), 1);

    const polling = h.runtime.pollExactRepair(2);
    await Promise.resolve();
    await h.runtime.receive(payload(2, 1, "B"), 3);
    response.resolve({ status: "alreadyReceipted" });
    await expect(polling).resolves.toBeUndefined();

    expect(h.visible).toEqual(["A", "B"]);
    expect(h.failStops).toEqual([]);

    const unknown = harness(() => Promise.resolve({ status: "alreadyReceipted" }));
    await unknown.runtime.pollExactRepair(1);
    expect(unknown.failStops).toEqual(["repair:already_receipted_unknown"]);
  });

  it("keeps a single in-flight watchdog pull and treats idle as a no-op", async () => {
    const response = deferred<TerminalOutputV3RepairResponse>();
    const repair = vi.fn(() => response.promise);
    const h = harness(repair);

    const first = h.runtime.pollExactRepair(1);
    const second = h.runtime.pollExactRepair(2);
    await Promise.resolve();
    expect(repair).toHaveBeenCalledTimes(1);
    response.resolve({ status: "idle" });
    await Promise.all([first, second]);

    expect(h.failStops).toEqual([]);
    expect(h.runtime.diagnostics()).toMatchObject({
      repairCount: 0,
      lastRepairReason: null,
    });
  });

  it("keeps a receipted surface healthy when the watchdog observes parser backlog as idle", async () => {
    const pendingVisibleParsers: Array<() => void> = [];
    const repair = vi.fn(() => Promise.resolve({ status: "idle" as const, envelope: null }));
    const h = harness(repair, { pendingVisibleParsers });

    await expect(h.runtime.receive(payload(1, 0, "A"), 0)).resolves.toEqual({
      kind: "accepted",
      envelopeId: 1,
    });
    expect(mockAcknowledgeTerminalOutputEnvelope).toHaveBeenCalledOnce();
    expect(h.runtime.diagnostics()).toMatchObject({ admittedSeq: 1, parsedSeq: 0 });

    await expect(h.runtime.pollExactRepair(1_000)).resolves.toBeUndefined();
    expect(repair).toHaveBeenCalledWith({
      terminalId: "term-1",
      generation: 4,
      token: "lease-4",
      envelopeId: 2,
      grantId: null,
      seqStart: 1,
    });
    expect(h.failStops).toEqual([]);
    expect(h.runtime.diagnostics()).toMatchObject({
      admittedSeq: 1,
      parsedSeq: 0,
      repairCount: 0,
      lastRepairReason: null,
    });

    pendingVisibleParsers[0]?.();
    await vi.waitFor(() => expect(h.runtime.diagnostics().parsedSeq).toBe(1));
  });

  it("does not poll while a receipt response is unsettled, then permits the next watchdog", async () => {
    vi.useFakeTimers();
    try {
      const receipt = deferred<boolean>();
      mockAcknowledgeTerminalOutputEnvelope.mockReturnValueOnce(receipt.promise);
      const repair = vi.fn(() => Promise.resolve({ status: "idle" as const, envelope: null }));
      const h = harness(repair, { controlTimeoutMs: 5_000 });
      const receiving = h.runtime.receive(payload(1, 0, "A"), 0);
      for (
        let turn = 0;
        turn < 10 && mockAcknowledgeTerminalOutputEnvelope.mock.calls.length === 0;
        turn += 1
      ) {
        await Promise.resolve();
      }
      expect(mockAcknowledgeTerminalOutputEnvelope).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(h.runtime.pollExactRepair(1_000)).resolves.toBeUndefined();
      expect(repair).not.toHaveBeenCalled();
      expect(h.failStops).toEqual([]);

      receipt.resolve(true);
      await expect(receiving).resolves.toEqual({ kind: "accepted", envelopeId: 1 });
      await expect(h.runtime.pollExactRepair(1_001)).resolves.toBeUndefined();
      expect(repair).toHaveBeenCalledOnce();
      expect(h.failStops).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll while a standalone timeout close is unsettled", async () => {
    const closing = deferred<boolean>();
    mockCloseTerminalOutputContinuation.mockReturnValueOnce(closing.promise);
    const repair = vi.fn(() => Promise.resolve({ status: "idle" as const, envelope: null }));
    const h = harness(repair, { controlTimeoutMs: 5_000 });
    await h.runtime.receive(payload(1, 0, "\u001b[?2026h"), 0);

    const flushing = h.runtime.flushExpired(5_000);
    for (
      let turn = 0;
      turn < 10 && mockCloseTerminalOutputContinuation.mock.calls.length === 0;
      turn += 1
    ) {
      await Promise.resolve();
    }
    expect(mockCloseTerminalOutputContinuation).toHaveBeenCalledOnce();

    await expect(h.runtime.pollExactRepair(5_000)).resolves.toBeUndefined();
    expect(repair).not.toHaveBeenCalled();
    expect(h.failStops).toEqual([]);

    closing.resolve(true);
    await flushing;
    await expect(h.runtime.pollExactRepair(5_001)).resolves.toBeUndefined();
    expect(repair).toHaveBeenCalledOnce();
    expect(h.failStops).toEqual([]);
  });

  it.each(["alreadyReceipted", "exact"] as const)(
    "keeps a direct winner witness through ledger eviction and ignores late %s",
    async (status) => {
      const response = deferred<TerminalOutputV3RepairResponse>();
      const repair = vi.fn(() => response.promise);
      const h = harness(repair);
      const polling = h.runtime.pollExactRepair(0);
      await Promise.resolve();

      await h.runtime.receive(payload(1, 0, "A"), 1);
      await h.runtime.receive(payload(2, 1, "B"), 2);
      await h.runtime.receive(payload(3, 2, "C"), 3);
      const diagnosticsBefore = h.runtime.diagnostics();
      const writesBefore = [...h.visible];

      response.resolve({
        status,
        envelope: status === "exact" ? payload(1, 0, "A") : null,
      });
      await expect(polling).resolves.toBeUndefined();

      expect(repair).toHaveBeenCalledOnce();
      expect(h.runtime.diagnostics()).toEqual(diagnosticsBefore);
      expect(h.runtime.diagnostics()).toMatchObject({
        admittedSeq: 3,
        nextEnvelopeId: 4,
        repairCount: 0,
        lastRepairReason: null,
      });
      expect(h.visible).toEqual(writesBefore);
      expect(h.visible).toEqual(["A", "B", "C"]);
      expect(h.failStops).toEqual([]);
    },
  );

  it("fail-stops a late exact response that conflicts with the direct winner witness", async () => {
    const response = deferred<TerminalOutputV3RepairResponse>();
    const h = harness(() => response.promise);
    const polling = h.runtime.pollExactRepair(0);
    await Promise.resolve();
    await h.runtime.receive(payload(1, 0, "A"), 1);
    await h.runtime.receive(payload(2, 1, "B"), 2);
    await h.runtime.receive(payload(3, 2, "C"), 3);

    response.resolve({ status: "exact", envelope: payload(1, 0, "X") });
    await expect(polling).resolves.toEqual({
      kind: "fail-stop",
      reason: "repair:winner_conflict",
    });
    expect(h.visible).toEqual(["A", "B", "C"]);
    expect(h.failStops).toEqual(["repair:winner_conflict"]);
  });

  it("bounds a permanently pending repair and does not start a second pull", async () => {
    vi.useFakeTimers();
    try {
      const repair = vi.fn(() => new Promise<TerminalOutputV3RepairResponse>(() => {}));
      const h = harness(repair);
      const first = h.runtime.pollExactRepair(1);
      const second = h.runtime.pollExactRepair(2);
      await Promise.resolve();
      expect(repair).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(100);

      await expect(first).resolves.toEqual({ kind: "fail-stop", reason: "repair:timeout" });
      await expect(second).resolves.toEqual({ kind: "fail-stop", reason: "repair:timeout" });
      expect(h.failStops).toEqual(["repair:timeout"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fail-stops typed repair failures and a non-successor after one exact repair", async () => {
    for (const status of ["stale", "mismatch", "exhausted"] as const) {
      const failed = harness(() => Promise.resolve({ status }));
      await expect(failed.runtime.pollExactRepair(1)).resolves.toEqual({
        kind: "fail-stop",
        reason: `repair:${status}`,
      });
      expect(failed.failStops).toEqual([`repair:${status}`]);
    }

    const malformed = harness(() => Promise.resolve({ status: "exact", envelope: { version: 3 } }));
    await expect(malformed.runtime.pollExactRepair(1)).resolves.toEqual({
      kind: "fail-stop",
      reason: "repair:malformed_exact",
    });
    await expect(malformed.runtime.receive(payload(2, 1, "B"), 2)).resolves.toEqual({
      kind: "fail-stop",
      reason: "repair:malformed_exact",
    });

    const skipped = harness(() =>
      Promise.resolve({ status: "exact", envelope: payload(1, 0, "A") }),
    );
    await expect(skipped.runtime.receive(payload(3, 2, "C"), 1)).resolves.toEqual({
      kind: "fail-stop",
      reason: "repair:non_successor",
    });
    expect(skipped.visible).toEqual(["A"]);
  });

  it("does not revive output, diagnostics, or failure callbacks after disposal", async () => {
    const response = deferred<TerminalOutputV3RepairResponse>();
    const h = harness(() => response.promise);
    const receive = h.runtime.receive(payload(2, 1, "B"), 1);
    await Promise.resolve();
    h.runtime.dispose();
    await expect(receive).resolves.toEqual({ kind: "stale" });
    const before = h.runtime.diagnostics();

    response.resolve({ status: "exact", envelope: payload(1, 0, "A") });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.visible).toEqual([]);
    expect(h.checkpoints).toEqual([]);
    expect(h.failStops).toEqual([]);
    expect(h.runtime.diagnostics()).toEqual(before);
  });

  it("ignores a late old generation or lease without mutating the current surface", async () => {
    const h = harness(() => Promise.resolve({ status: "idle", envelope: null }));
    await h.runtime.receive(payload(1, 0, "A"), 1);
    const before = h.runtime.diagnostics();
    const writesBefore = [...h.visible];

    await expect(
      h.runtime.receive({ ...payload(2, 1, "old-generation"), generation: 3 }, 2),
    ).resolves.toEqual({ kind: "stale" });
    await expect(
      h.runtime.receive({ ...payload(2, 1, "old-lease"), leaseToken: "retired-lease" }, 3),
    ).resolves.toEqual({ kind: "stale" });

    expect(h.runtime.diagnostics()).toEqual(before);
    expect(h.visible).toEqual(writesBefore);
    expect(h.failStops).toEqual([]);
  });

  it("does not let a retired runtime event contaminate a recreated surface", async () => {
    const retired = harness(() => Promise.resolve({ status: "idle", envelope: null }));
    await retired.runtime.receive(payload(1, 0, "old"), 1);
    retired.runtime.dispose();
    await expect(retired.runtime.receive(payload(2, 3, "late"), 2)).resolves.toEqual({
      kind: "stale",
    });

    const current = harness(() => Promise.resolve({ status: "idle", envelope: null }));
    const currentBefore = current.runtime.diagnostics();
    await expect(
      current.runtime.receive({ ...payload(2, 3, "late"), generation: 3 }, 3),
    ).resolves.toEqual({ kind: "stale" });
    expect(current.runtime.diagnostics()).toEqual(currentBefore);
    expect(current.visible).toEqual([]);
    expect(current.failStops).toEqual([]);
  });

  it("settles a queued gap when a malformed event fail-stops the surface", async () => {
    const repair = deferred<TerminalOutputV3RepairResponse>();
    const h = harness(() => repair.promise);
    const gap = h.runtime.receive(payload(2, 1, "B"), 1);
    await Promise.resolve();

    await expect(h.runtime.receive({ version: 3 }, 2)).resolves.toEqual({
      kind: "fail-stop",
      reason: "invalid_envelope",
    });
    await expect(gap).resolves.toEqual({ kind: "fail-stop", reason: "invalid_envelope" });
    repair.resolve({ status: "exact", envelope: payload(1, 0, "A") });
    await Promise.resolve();
    expect(h.visible).toEqual([]);
  });
});
