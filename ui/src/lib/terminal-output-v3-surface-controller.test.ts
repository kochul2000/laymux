import { describe, expect, it, vi } from "vitest";

import type {
  TerminalOutputDeliveryControlRequest,
  TerminalOutputDeliveryControlResult,
} from "./terminal-output-delivery-control";
import { normalizeTerminalOutputEnvelope } from "./terminal-output-envelope";
import { TerminalOutputEnvelopeIngress } from "./terminal-output-envelope-ingress";
import { TerminalOutputFrameContinuationTracker } from "./terminal-output-frame-continuation";
import type { TerminalOutputSurfaceLifecycle } from "./terminal-output-surface-lifecycle";
import {
  TerminalOutputV3SurfaceController,
  type TerminalOutputV3SurfaceAdapter,
  type TerminalOutputV3TransferRequest,
} from "./terminal-output-v3-surface-controller";

const OPEN = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x68];
const CLOSE = [0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x6c];

function payload(options: {
  envelopeId?: number;
  seqStart?: number;
  grantId?: string | null;
  data?: number[] | Uint8Array;
  deltaEnds?: number[];
}) {
  const data = options.data ?? [65, 66];
  return {
    version: 3,
    generation: 4,
    leaseToken: "lease-4",
    envelopeId: options.envelopeId ?? 1,
    grantId: options.grantId ?? null,
    seqStart: options.seqStart ?? 0,
    seqEnd: (options.seqStart ?? 0) + data.length,
    data,
    deltaEnds: options.deltaEnds ?? [data.length],
    geometryRuns: [{ deltaIndex: 0, geometry: { revision: 2, cols: 100, rows: 30 } }],
  };
}

function lifecycle(): TerminalOutputSurfaceLifecycle {
  return {
    generation: 4,
    leaseToken: "lease-4",
    attachEpoch: 1,
    visible: { alive: true, ready: true, generation: 4, leaseToken: "lease-4" },
    checkpoint: { alive: true, ready: true, generation: 4, leaseToken: "lease-4" },
    disposed: false,
    failStoppedReason: null,
    stabilizerHolding: false,
    capacityWaiting: false,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(options?: {
  lifecycle?: TerminalOutputSurfaceLifecycle;
  receipt?: ReturnType<typeof deferred<TerminalOutputDeliveryControlResult>>;
  hold?: ReturnType<typeof deferred<TerminalOutputDeliveryControlResult>>;
  sendControl?: (
    request: TerminalOutputDeliveryControlRequest,
  ) => Promise<TerminalOutputDeliveryControlResult> | undefined;
  controlResult?: TerminalOutputDeliveryControlResult;
  preflight?: TerminalOutputV3SurfaceAdapter["preflight"];
  transfer?: TerminalOutputV3SurfaceAdapter["transfer"];
  parsedAck?: TerminalOutputV3SurfaceAdapter["sendParsedAck"];
  timeoutMs?: number;
}) {
  const currentLifecycle = options?.lifecycle ?? lifecycle();
  const ingress = new TerminalOutputEnvelopeIngress({
    terminalId: "term-1",
    generation: 4,
    leaseToken: "lease-4",
    initialSeq: 0,
  });
  const continuation = new TerminalOutputFrameContinuationTracker({
    surface: "active",
    terminalId: "term-1",
    generation: 4,
    leaseToken: "lease-4",
    timeoutMs: options?.timeoutMs,
    createGrantId: () => "grant-1",
  });
  const controlCalls: TerminalOutputDeliveryControlRequest[] = [];
  let deliveryDisposed = 0;
  const deliveryControl = {
    send(request: TerminalOutputDeliveryControlRequest) {
      controlCalls.push(request);
      const override = options?.sendControl?.(request);
      if (override) return override;
      if (request.identity.kind === "hold" && options?.hold) {
        return options.hold.promise;
      }
      if (request.identity.kind === "receipt" && options?.receipt) {
        return options.receipt.promise;
      }
      return Promise.resolve(
        options?.controlResult ?? {
          kind: "accepted" as const,
          identity: request.identity,
        },
      );
    },
    dispose() {
      deliveryDisposed += 1;
    },
  };
  const transferRequests: TerminalOutputV3TransferRequest[] = [];
  const parsedAcks: Array<{
    terminalId: string;
    generation: number;
    leaseToken: string;
    seq: number;
  }> = [];
  const failStops: string[] = [];
  const adapter: TerminalOutputV3SurfaceAdapter = {
    preflight: options?.preflight ?? (() => ({ kind: "accepted" })),
    transfer:
      options?.transfer ??
      ((request) => {
        transferRequests.push(request);
        return { acceptedDeltaCount: request.envelope.deltas.length };
      }),
    sendParsedAck:
      options?.parsedAck ??
      ((identity) => {
        parsedAcks.push(identity);
        return Promise.resolve(true);
      }),
    failStop(reason) {
      failStops.push(reason);
    },
  };
  const controller = new TerminalOutputV3SurfaceController({
    ingress,
    continuation,
    deliveryControl,
    getLifecycle: () => currentLifecycle,
    adapter,
  });
  return {
    controller,
    ingress,
    currentLifecycle,
    controlCalls,
    transferRequests,
    parsedAcks,
    failStops,
    get deliveryDisposed() {
      return deliveryDisposed;
    },
  };
}

describe("TerminalOutputV3SurfaceController", () => {
  it("preflights the whole immutable envelope before admission and transfers all semantic deltas once", async () => {
    const events: string[] = [];
    const ingressRef: { current?: TerminalOutputEnvelopeIngress } = {};
    let transferred!: TerminalOutputV3TransferRequest;
    let preflightEnvelope!: TerminalOutputV3TransferRequest["envelope"];
    let preflightBacking!: Uint8Array;
    let transferCalls = 0;
    const h = harness({
      preflight(envelope) {
        events.push("preflight");
        preflightEnvelope = envelope;
        preflightBacking = envelope.backing;
        expect(ingressRef.current?.snapshot()).toMatchObject({
          admittedSeq: 0,
          expectedEnvelopeId: 1,
        });
        expect(envelope.deltas.map((delta) => [delta.seqStart, delta.seqEnd])).toEqual([
          [0, 2],
          [2, 4],
        ]);
        return { kind: "accepted" };
      },
      transfer(request) {
        events.push("transfer");
        transferCalls += 1;
        transferred = request;
        return { acceptedDeltaCount: request.envelope.deltas.length };
      },
    });
    ingressRef.current = h.ingress;
    const original = payload({ data: [65, 66, 67, 68], deltaEnds: [2, 4] });

    const result = await h.controller.receive(original, 1);

    expect(result).toMatchObject({ kind: "accepted", envelopeId: 1 });
    expect(events).toEqual(["preflight", "transfer"]);
    expect(transferCalls).toBe(1);
    expect(transferred.envelope.backing).toBe(preflightBacking);
    expect(transferred.envelope).toBe(preflightEnvelope);
    expect(transferred.envelope.deltas).toHaveLength(2);
    expect(transferred.envelope.deltas[0].data.buffer).toBe(transferred.envelope.backing.buffer);
    expect(transferred.envelope.deltas[1].data.buffer).toBe(transferred.envelope.backing.buffer);
    expect(h.controlCalls.map((request) => request.identity.kind)).toEqual(["receipt"]);
    expect(h.controlCalls[0]).toMatchObject({
      identity: {
        terminalId: "term-1",
        generation: 4,
        leaseToken: "lease-4",
        envelopeId: 1,
        grantId: null,
      },
      payload: { seqEnd: 4 },
    });
  });

  it("leaves ingress untouched when whole-envelope preflight rejects", async () => {
    const h = harness({
      preflight: () => ({ kind: "rejected", reason: "queue_unavailable" }),
    });

    const result = await h.controller.receive(payload({}), 1);

    expect(result).toEqual({ kind: "fail-stop", reason: "preflight:queue_unavailable" });
    expect(h.ingress.snapshot()).toMatchObject({
      admittedSeq: 0,
      parsedSeq: 0,
      expectedEnvelopeId: 1,
      unparsed: [],
    });
    expect(h.transferRequests).toHaveLength(0);
    expect(h.controlCalls).toHaveLength(0);
    expect(h.failStops).toEqual(["preflight:queue_unavailable"]);
  });

  it("advances parsed credit after visible/checkpoint intersection independently of receipt", async () => {
    const receipt = deferred<TerminalOutputDeliveryControlResult>();
    const h = harness({ receipt });

    const receive = h.controller.receive(payload({}), 1);
    expect(h.ingress.unreceipted).toBeUndefined();
    expect(h.ingress.parsedSeq).toBe(0);

    h.transferRequests[0].complete({ kind: "parsed", visibleSeq: 2, checkpointSeq: 2 });
    await Promise.resolve();

    expect(h.ingress.parsedSeq).toBe(2);
    expect(h.parsedAcks).toEqual([
      { terminalId: "term-1", generation: 4, leaseToken: "lease-4", seq: 2 },
    ]);
    expect(h.ingress.unreceipted).toBeUndefined();

    receipt.resolve({ kind: "accepted", identity: h.controlCalls[0].identity });
    await expect(receive).resolves.toMatchObject({ kind: "accepted", envelopeId: 1 });
    expect(h.ingress.unreceipted).toBeUndefined();
  });

  it("accepts the next event delivered before the prior receipt Promise settles", async () => {
    const firstReceipt = deferred<TerminalOutputDeliveryControlResult>();
    const holder: { current?: ReturnType<typeof harness> } = {};
    let second: ReturnType<TerminalOutputV3SurfaceController["receive"]> | undefined;
    const acceptedResult = (request: TerminalOutputDeliveryControlRequest) => ({
      kind: "accepted" as const,
      identity: request.identity,
    });
    const h = harness({
      sendControl(request) {
        if (request.identity.kind !== "receipt") return undefined;
        if (request.identity.envelopeId === 1) {
          second = holder.current?.controller.receive(payload({ envelopeId: 2, seqStart: 2 }), 2);
          return firstReceipt.promise;
        }
        return Promise.resolve(acceptedResult(request));
      },
    });
    holder.current = h;

    const first = h.controller.receive(payload({ envelopeId: 1, seqStart: 0 }), 1);
    await vi.waitFor(() => expect(second).toBeDefined());
    await expect(second).resolves.toEqual({ kind: "accepted", envelopeId: 2 });
    expect(h.ingress.snapshot()).toMatchObject({
      admittedSeq: 4,
      expectedEnvelopeId: 3,
    });
    expect(h.ingress.unreceipted).toBeUndefined();
    expect(h.transferRequests).toHaveLength(2);
    expect(h.failStops).toEqual([]);

    firstReceipt.resolve(acceptedResult(h.controlCalls[0]));
    await expect(first).resolves.toEqual({ kind: "accepted", envelopeId: 1 });
  });

  it("holds synchronous parsed completion until opener hold is accepted", async () => {
    const hold = deferred<TerminalOutputDeliveryControlResult>();
    let transferred!: TerminalOutputV3TransferRequest;
    const parsedAck = vi.fn(() => Promise.resolve(true));
    const h = harness({
      hold,
      parsedAck,
      transfer(request) {
        transferred = request;
        request.complete({
          kind: "parsed",
          visibleSeq: request.envelope.seqEnd,
          checkpointSeq: request.envelope.seqEnd,
        });
        return { acceptedDeltaCount: request.envelope.deltas.length };
      },
    });

    const receive = h.controller.receive(payload({ data: OPEN }), 1);
    await Promise.resolve();
    expect(transferred).toBeDefined();
    expect(h.controlCalls.map(({ identity }) => identity.kind)).toEqual(["hold"]);
    expect(parsedAck).not.toHaveBeenCalled();

    hold.resolve({ kind: "accepted", identity: h.controlCalls[0].identity });
    await expect(receive).resolves.toEqual({ kind: "accepted", envelopeId: 1 });
    expect(parsedAck).toHaveBeenCalledWith({
      terminalId: "term-1",
      generation: 4,
      leaseToken: "lease-4",
      seq: OPEN.length,
    });
    expect(h.controlCalls.map(({ identity }) => identity.kind)).toEqual(["hold", "receipt"]);
  });

  it("fail-stops a synchronous discard immediately while opener hold is pending", async () => {
    const hold = deferred<TerminalOutputDeliveryControlResult>();
    const parsedAck = vi.fn(() => Promise.resolve(true));
    const h = harness({
      hold,
      parsedAck,
      transfer(request) {
        request.complete({ kind: "discarded", reason: "checkpoint_failed" });
        return { acceptedDeltaCount: request.envelope.deltas.length };
      },
    });

    const receive = h.controller.receive(payload({ data: OPEN }), 1);
    await Promise.resolve();
    expect(h.failStops).toEqual(["discarded:checkpoint_failed"]);
    expect(h.deliveryDisposed).toBe(1);
    expect(h.controlCalls.map(({ identity }) => identity.kind)).toEqual(["hold"]);
    expect(parsedAck).not.toHaveBeenCalled();

    hold.resolve({ kind: "accepted", identity: h.controlCalls[0].identity });
    await expect(receive).resolves.toEqual({
      kind: "fail-stop",
      reason: "discarded:checkpoint_failed",
    });
    expect(h.controlCalls.map(({ identity }) => identity.kind)).toEqual(["hold"]);
    expect(parsedAck).not.toHaveBeenCalled();
    expect(h.ingress.parsedSeq).toBe(0);
  });

  it("fail-stops a partial parser intersection and ignores every later completion", async () => {
    const h = harness();
    await h.controller.receive(payload({}), 1);
    const complete = h.transferRequests[0].complete;

    complete({ kind: "parsed", visibleSeq: 2, checkpointSeq: 1 });
    complete({ kind: "parsed", visibleSeq: 2, checkpointSeq: 2 });
    await Promise.resolve();

    expect(h.failStops).toEqual(["partial_parser_completion"]);
    expect(h.ingress.parsedSeq).toBe(0);
    expect(h.parsedAcks).toHaveLength(0);
    expect(h.deliveryDisposed).toBe(1);
  });

  it("fail-stops discard without reset, replay, or replacement attach hooks", async () => {
    const h = harness();
    await h.controller.receive(payload({}), 1);

    h.transferRequests[0].complete({ kind: "discarded", reason: "surface_lost" });

    expect(h.failStops).toEqual(["discarded:surface_lost"]);
    expect(h.ingress.parsedSeq).toBe(0);
    expect(h.parsedAcks).toHaveLength(0);
  });

  it("uses opener identity for hold and closing-envelope identity for close", async () => {
    const h = harness();

    await h.controller.receive(payload({ data: OPEN }), 10);
    expect(h.controller.activeGrantId).toBe("grant-1");
    expect(h.controlCalls).toMatchObject([
      {
        identity: {
          kind: "hold",
          terminalId: "term-1",
          generation: 4,
          leaseToken: "lease-4",
          envelopeId: 1,
          grantId: "grant-1",
        },
        payload: { frameStartSeq: 0 },
      },
      {
        identity: { kind: "receipt", envelopeId: 1, grantId: null },
        payload: { seqEnd: 8 },
      },
    ]);

    await h.controller.receive(
      payload({ envelopeId: 2, seqStart: 8, grantId: "grant-1", data: [88] }),
      11,
    );
    await h.controller.receive(
      payload({ envelopeId: 3, seqStart: 9, grantId: "grant-1", data: CLOSE }),
      12,
    );
    expect(h.controller.activeGrantId).toBeNull();
    expect(h.controlCalls.slice(3)).toMatchObject([
      {
        identity: { kind: "close", envelopeId: 3, grantId: "grant-1" },
        payload: { closeSeq: 17, reason: "close" },
      },
      {
        identity: { kind: "receipt", envelopeId: 3, grantId: "grant-1" },
        payload: { seqEnd: 17 },
      },
    ]);
  });

  it("retains a bounded current+previous retry ledger after receipt", async () => {
    const receipt = deferred<TerminalOutputDeliveryControlResult>();
    const h = harness({ receipt });
    const firstPayload = payload({ data: [65, 66] });
    const first = h.controller.receive(firstPayload, 1);
    expect(h.controller.receive({ ...firstPayload, data: [65, 66] }, 2)).toBe(first);
    expect(h.controller.rememberedEnvelopeCount).toBe(1);
    receipt.resolve({ kind: "accepted", identity: h.controlCalls[0].identity });
    await expect(first).resolves.toMatchObject({ kind: "accepted" });
    await Promise.resolve();
    expect(h.controller.rememberedEnvelopeCount).toBe(1);
  });

  it("keeps only current+previous immutable envelopes and deduplicates the previous one", async () => {
    const h = harness();
    const firstPayload = payload({ envelopeId: 1, seqStart: 0, data: [65] });
    const secondPayload = payload({ envelopeId: 2, seqStart: 1, data: [66] });
    const thirdPayload = payload({ envelopeId: 3, seqStart: 2, data: [67] });

    await h.controller.receive(firstPayload, 1);
    await h.controller.receive(secondPayload, 2);
    await h.controller.receive(thirdPayload, 3);

    expect(h.controller.rememberedEnvelopeCount).toBe(2);
    expect(h.controller.matchKnownEnvelope(normalizeTerminalOutputEnvelope(secondPayload))).toBe(
      "same",
    );
    expect(h.controller.matchKnownEnvelope(normalizeTerminalOutputEnvelope(firstPayload))).toBe(
      "unknown",
    );
    await expect(h.controller.receive(secondPayload, 4)).resolves.toEqual({
      kind: "accepted",
      envelopeId: 2,
    });
    expect(h.transferRequests).toHaveLength(3);
    await expect(h.controller.receive({ ...secondPayload, data: [88] }, 5)).resolves.toEqual({
      kind: "fail-stop",
      reason: "envelope_identity_conflict",
    });
  });

  it("does not open the transport slot when opener hold fails", async () => {
    const h = harness({
      controlResult: {
        kind: "rejected",
        identity: {
          kind: "hold",
          terminalId: "term-1",
          generation: 4,
          leaseToken: "lease-4",
          envelopeId: 1,
          grantId: "grant-1",
        },
        error: new Error("hold rejected"),
      },
    });

    await expect(h.controller.receive(payload({ data: OPEN }), 1)).resolves.toEqual({
      kind: "fail-stop",
      reason: "control:hold:rejected",
    });
    expect(h.controlCalls.map((request) => request.identity.kind)).toEqual(["hold"]);
    expect(h.ingress.unreceipted).toBeDefined();
  });

  it("rejects a continuation envelope whose grant is not the current grant", async () => {
    const h = harness();
    await h.controller.receive(payload({ data: OPEN }), 1);

    const result = await h.controller.receive(
      payload({ envelopeId: 2, seqStart: 8, grantId: "wrong-grant", data: [65] }),
      2,
    );

    expect(result).toEqual({ kind: "fail-stop", reason: "grant_mismatch" });
    expect(h.transferRequests).toHaveLength(1);
    expect(h.ingress.admittedSeq).toBe(8);
  });

  it("gates one old-grant successor until close and the closing receipt settle", async () => {
    const close = deferred<TerminalOutputDeliveryControlResult>();
    const h = harness({
      sendControl: (request) => (request.identity.kind === "close" ? close.promise : undefined),
    });
    await h.controller.receive(payload({ data: OPEN }), 1);
    h.transferRequests[0].complete({ kind: "parsed", visibleSeq: 8, checkpointSeq: 8 });
    await Promise.resolve();
    await Promise.resolve();
    const parsedBeforeClose = h.parsedAcks.length;
    const closing = h.controller.receive(
      payload({ envelopeId: 2, seqStart: 8, grantId: "grant-1", data: CLOSE }),
      2,
    );
    await Promise.resolve();
    const queued = h.controller.receive(
      payload({ envelopeId: 3, seqStart: 16, grantId: "grant-1", data: [65] }),
      3,
    );
    h.transferRequests[1].complete({ kind: "parsed", visibleSeq: 16, checkpointSeq: 16 });
    await Promise.resolve();

    expect(h.controller.activeGrantId).toBe("grant-1");
    expect(h.transferRequests).toHaveLength(2);
    expect(h.controlCalls.filter((request) => request.identity.envelopeId === 3)).toEqual([]);
    expect(h.parsedAcks).toHaveLength(parsedBeforeClose);

    close.resolve({ kind: "accepted", identity: h.controlCalls.at(-1)!.identity });
    await expect(closing).resolves.toEqual({ kind: "accepted", envelopeId: 2 });
    await expect(queued).resolves.toEqual({ kind: "accepted", envelopeId: 3 });

    expect(h.controller.activeGrantId).toBeNull();
    expect(h.transferRequests).toHaveLength(3);
    expect(h.controlCalls.slice(-2)).toMatchObject([
      { identity: { kind: "receipt", envelopeId: 2, grantId: "grant-1" } },
      { identity: { kind: "receipt", envelopeId: 3, grantId: "grant-1" } },
    ]);
  });

  it("accepts the one old-grant successor delivered after the close and receipt settle", async () => {
    const h = harness();
    await h.controller.receive(payload({ data: OPEN }), 1);

    await expect(
      h.controller.receive(
        payload({ envelopeId: 2, seqStart: 8, grantId: "grant-1", data: CLOSE }),
        2,
      ),
    ).resolves.toEqual({ kind: "accepted", envelopeId: 2 });
    expect(h.controller.activeGrantId).toBeNull();

    await expect(
      h.controller.receive(
        payload({ envelopeId: 3, seqStart: 16, grantId: "grant-1", data: [65] }),
        3,
      ),
    ).resolves.toEqual({ kind: "accepted", envelopeId: 3 });

    expect(h.failStops).toEqual([]);
    expect(h.transferRequests).toHaveLength(3);
    expect(h.controlCalls.slice(-1)).toMatchObject([
      { identity: { kind: "receipt", envelopeId: 3, grantId: "grant-1" } },
    ]);
  });

  it("keeps base credit for a frame that opens in its predecessor's closing envelope", async () => {
    const h = harness();
    await h.controller.receive(payload({ data: OPEN }), 1);

    await expect(
      h.controller.receive(
        payload({
          envelopeId: 2,
          seqStart: 8,
          grantId: "grant-1",
          data: [...CLOSE, ...OPEN],
        }),
        2,
      ),
    ).resolves.toEqual({ kind: "accepted", envelopeId: 2 });

    expect(h.controlCalls.filter((request) => request.identity.envelopeId === 2)).toMatchObject([
      { identity: { kind: "close", grantId: "grant-1" } },
      { identity: { kind: "receipt", grantId: "grant-1" } },
    ]);
    expect(h.controlCalls.filter((request) => request.identity.kind === "hold")).toHaveLength(1);

    await expect(
      h.controller.receive(payload({ envelopeId: 3, seqStart: 24, grantId: null, data: CLOSE }), 3),
    ).resolves.toEqual({ kind: "accepted", envelopeId: 3 });
    expect(h.failStops).toEqual([]);
    expect(h.controller.activeGrantId).toBeNull();
  });

  it("does not carry settled-close grant admission past the next successor", async () => {
    const h = harness();
    await h.controller.receive(payload({ data: OPEN }), 1);
    await h.controller.receive(
      payload({ envelopeId: 2, seqStart: 8, grantId: "grant-1", data: CLOSE }),
      2,
    );
    await h.controller.receive(
      payload({ envelopeId: 3, seqStart: 16, grantId: null, data: [65] }),
      3,
    );

    await expect(
      h.controller.receive(
        payload({ envelopeId: 4, seqStart: 17, grantId: "grant-1", data: [66] }),
        4,
      ),
    ).resolves.toEqual({ kind: "fail-stop", reason: "grant_mismatch" });
  });

  it("gates a null-grant successor that wins the closing receipt-response race", async () => {
    const receipt = deferred<TerminalOutputDeliveryControlResult>();
    const h = harness({
      sendControl: (request) =>
        request.identity.kind === "receipt" && request.identity.envelopeId === 2
          ? receipt.promise
          : undefined,
    });
    await h.controller.receive(payload({ data: OPEN }), 1);
    const closing = h.controller.receive(
      payload({ envelopeId: 2, seqStart: 8, grantId: "grant-1", data: CLOSE }),
      2,
    );
    for (let turn = 0; turn < 10 && h.controlCalls.length < 5; turn += 1) {
      await Promise.resolve();
    }
    expect(h.controlCalls.at(-1)).toMatchObject({
      identity: { kind: "receipt", envelopeId: 2 },
    });

    const queued = h.controller.receive(
      payload({ envelopeId: 3, seqStart: 16, grantId: null, data: [66] }),
      3,
    );
    expect(h.transferRequests).toHaveLength(2);
    expect(h.controlCalls.filter((request) => request.identity.envelopeId === 3)).toEqual([]);

    receipt.resolve({ kind: "accepted", identity: h.controlCalls.at(-1)!.identity });
    await expect(closing).resolves.toEqual({ kind: "accepted", envelopeId: 2 });
    await expect(queued).resolves.toEqual({ kind: "accepted", envelopeId: 3 });
    expect(h.transferRequests).toHaveLength(3);
  });

  it("gates a null-grant successor emitted before the close response", async () => {
    const close = deferred<TerminalOutputDeliveryControlResult>();
    const h = harness({
      sendControl: (request) => (request.identity.kind === "close" ? close.promise : undefined),
    });
    await h.controller.receive(payload({ data: OPEN }), 1);
    const closing = h.controller.receive(
      payload({ envelopeId: 2, seqStart: 8, grantId: "grant-1", data: CLOSE }),
      2,
    );
    for (let turn = 0; turn < 10 && h.controlCalls.length < 4; turn += 1) {
      await Promise.resolve();
    }
    const queued = h.controller.receive(
      payload({ envelopeId: 3, seqStart: 16, grantId: null, data: [66] }),
      3,
    );

    expect(h.transferRequests).toHaveLength(2);
    expect(h.failStops).toEqual([]);

    const closeIdentity = h.controlCalls.find(
      (request) => request.identity.kind === "close",
    )!.identity;
    close.resolve({ kind: "accepted", identity: closeIdentity });

    await expect(closing).resolves.toEqual({ kind: "accepted", envelopeId: 2 });
    await expect(queued).resolves.toEqual({ kind: "accepted", envelopeId: 3 });
    expect(h.transferRequests).toHaveLength(3);
  });

  it("fail-stops a queued closing successor when close is rejected", async () => {
    const close = deferred<TerminalOutputDeliveryControlResult>();
    const h = harness({
      sendControl: (request) => (request.identity.kind === "close" ? close.promise : undefined),
    });
    await h.controller.receive(payload({ data: OPEN }), 1);
    const closing = h.controller.receive(
      payload({ envelopeId: 2, seqStart: 8, grantId: "grant-1", data: CLOSE }),
      2,
    );
    await Promise.resolve();
    const queued = h.controller.receive(
      payload({ envelopeId: 3, seqStart: 16, grantId: "grant-1", data: [65] }),
      3,
    );
    const closeIdentity = h.controlCalls.at(-1)!.identity;
    close.resolve({ kind: "rejected", identity: closeIdentity, error: new Error("rejected") });

    await expect(closing).resolves.toEqual({
      kind: "fail-stop",
      reason: "control:close:rejected",
    });
    await expect(queued).resolves.toEqual({
      kind: "fail-stop",
      reason: "control:close:rejected",
    });
    expect(h.transferRequests).toHaveLength(2);
  });

  it("fail-stops stale lifecycle identity and ingress sequence gaps", async () => {
    const stale = lifecycle();
    stale.visible.leaseToken = "old-token";
    const staleHarness = harness({ lifecycle: stale });
    await expect(staleHarness.controller.receive(payload({}), 1)).resolves.toEqual({
      kind: "fail-stop",
      reason: "surface:visible_lease_stale",
    });

    const gapHarness = harness();
    await expect(
      gapHarness.controller.receive(payload({ seqStart: 1, data: [65] }), 1),
    ).resolves.toEqual({ kind: "fail-stop", reason: "ingress:sequence" });
    expect(gapHarness.transferRequests).toHaveLength(0);
  });

  it("deduplicates the exact same envelope and fail-stops an identity payload conflict", async () => {
    const receipt = deferred<TerminalOutputDeliveryControlResult>();
    const h = harness({ receipt });
    const firstPayload = payload({ data: [65, 66] });

    const first = h.controller.receive(firstPayload, 1);
    const retry = h.controller.receive({ ...firstPayload, data: [65, 66] }, 2);
    expect(retry).toBe(first);
    await Promise.resolve();
    expect(h.transferRequests).toHaveLength(1);
    expect(h.controlCalls).toHaveLength(1);

    const conflict = await h.controller.receive({ ...firstPayload, data: [65, 67] }, 3);
    expect(conflict).toEqual({ kind: "fail-stop", reason: "envelope_identity_conflict" });
    receipt.resolve({ kind: "accepted", identity: h.controlCalls[0].identity });
    await expect(first).resolves.toEqual({
      kind: "fail-stop",
      reason: "envelope_identity_conflict",
    });
    expect(h.failStops).toEqual(["envelope_identity_conflict"]);
  });

  it("does not scan ordinary envelope bytes for an eager retry fingerprint", async () => {
    class ObservedBytes extends Uint8Array {
      iteratorCalls = 0;

      override [Symbol.iterator]() {
        this.iteratorCalls += 1;
        return super[Symbol.iterator]();
      }
    }
    const bytes = new ObservedBytes(64 * 1024);
    bytes.fill(65);
    const h = harness();

    await h.controller.receive(payload({ data: bytes }), 1);

    expect(bytes.iteratorCalls).toBe(0);
  });

  it("fail-stops synchronous partial ownership transfer before sending receipt", async () => {
    const h = harness({ transfer: () => ({ acceptedDeltaCount: 0 }) });

    const result = await h.controller.receive(payload({ data: [65, 66], deltaEnds: [1, 2] }), 1);

    expect(result).toEqual({ kind: "fail-stop", reason: "partial_transfer" });
    expect(h.controlCalls).toHaveLength(0);
    expect(h.failStops).toEqual(["partial_transfer"]);
  });

  it("absorbs a late parser callback after a control fail-stop", async () => {
    const h = harness({
      controlResult: {
        kind: "rejected",
        identity: {
          kind: "receipt",
          terminalId: "term-1",
          generation: 4,
          leaseToken: "lease-4",
          envelopeId: 1,
          grantId: null,
        },
        error: new Error("bridge down"),
      },
    });

    await expect(h.controller.receive(payload({}), 1)).resolves.toEqual({
      kind: "fail-stop",
      reason: "control:receipt:rejected",
    });
    h.transferRequests[0].complete({ kind: "parsed", visibleSeq: 2, checkpointSeq: 2 });
    await Promise.resolve();

    expect(h.failStops).toEqual(["control:receipt:rejected"]);
    expect(h.ingress.parsedSeq).toBe(0);
    expect(h.parsedAcks).toHaveLength(0);
  });

  it("sends a no-progress timeout abort with the last receipted opener identity", async () => {
    const h = harness({ timeoutMs: 5 });
    await h.controller.receive(payload({ data: OPEN }), 10);
    await h.controller.flushExpired(16);

    expect(h.controller.activeGrantId).toBeNull();
    expect(h.controlCalls.at(-1)).toMatchObject({
      identity: {
        kind: "close",
        terminalId: "term-1",
        generation: 4,
        leaseToken: "lease-4",
        envelopeId: 1,
        grantId: "grant-1",
      },
      payload: { closeSeq: 8, reason: "abort:timeout" },
    });
    expect(h.failStops).toHaveLength(0);
  });

  it("fail-stops parsed ACK rejection after advancing only the completed prefix", async () => {
    const parsedAck = vi.fn(() => Promise.resolve(false));
    const h = harness({ parsedAck });
    await h.controller.receive(payload({}), 1);

    h.transferRequests[0].complete({ kind: "parsed", visibleSeq: 2, checkpointSeq: 2 });
    await Promise.resolve();
    await Promise.resolve();

    expect(h.ingress.parsedSeq).toBe(2);
    expect(parsedAck).toHaveBeenCalledTimes(1);
    expect(h.failStops).toEqual(["parsed_ack_rejected"]);
  });
});
