import type { TerminalOutputControlMountScope } from "./terminal-output-control-registry";
import { settleTerminalOutputControl } from "./terminal-output-control-watchdog";

export const TERMINAL_OUTPUT_DELIVERY_CONTROL_TIMEOUT_MS = 5_000;
export const TERMINAL_OUTPUT_DELIVERY_CONTROL_ORPHAN_CAP = 6;

export type TerminalOutputDeliveryControlKind = "receipt" | "hold" | "close";

export interface TerminalOutputDeliveryControlIdentity {
  kind: TerminalOutputDeliveryControlKind;
  terminalId: string;
  generation: number;
  leaseToken: string;
  envelopeId: number;
  grantId: string | null;
}

export type TerminalOutputDeliveryControlRequest =
  | {
      identity: TerminalOutputDeliveryControlIdentity & { kind: "receipt" };
      payload: { seqEnd: number };
    }
  | {
      identity: TerminalOutputDeliveryControlIdentity & { kind: "hold" };
      payload: { frameStartSeq: number };
    }
  | {
      identity: TerminalOutputDeliveryControlIdentity & { kind: "close" };
      payload: { closeSeq: number; reason: string };
    };

export type ImmutableTerminalOutputDeliveryControlRequest =
  | {
      readonly identity: Readonly<TerminalOutputDeliveryControlIdentity & { kind: "receipt" }>;
      readonly payload: Readonly<{ seqEnd: number }>;
    }
  | {
      readonly identity: Readonly<TerminalOutputDeliveryControlIdentity & { kind: "hold" }>;
      readonly payload: Readonly<{ frameStartSeq: number }>;
    }
  | {
      readonly identity: Readonly<TerminalOutputDeliveryControlIdentity & { kind: "close" }>;
      readonly payload: Readonly<{ closeSeq: number; reason: string }>;
    };

export type TerminalOutputDeliveryControlResult =
  | {
      kind: "accepted";
      identity: Readonly<TerminalOutputDeliveryControlIdentity>;
    }
  | {
      kind: "stale";
      identity: Readonly<TerminalOutputDeliveryControlIdentity>;
    }
  | {
      kind: "rejected";
      identity: Readonly<TerminalOutputDeliveryControlIdentity>;
      error: unknown;
    }
  | TerminalOutputDeliveryControlFailStop;

export interface TerminalOutputDeliveryControlFailStop {
  kind: "fail-stop";
  reason: "identity_conflict" | "control_orphan_cap";
  identity: Readonly<TerminalOutputDeliveryControlIdentity>;
}

export interface TerminalOutputDeliveryControlSenderOptions {
  scope: TerminalOutputControlMountScope;
  invoke(request: ImmutableTerminalOutputDeliveryControlRequest): Promise<boolean>;
  isCurrent(request: ImmutableTerminalOutputDeliveryControlRequest): boolean;
  timeoutMs?: number;
  maxTimedOutOrphans?: number;
  maxRememberedIdentities?: number;
}

interface RequestRecord {
  fingerprint: string;
  request: ImmutableTerminalOutputDeliveryControlRequest;
  promise?: Promise<TerminalOutputDeliveryControlResult>;
  result?: TerminalOutputDeliveryControlResult;
}

interface CapacityWait {
  key: string;
  resolve(outcome: "ready" | "stale"): void;
}

/**
 * One ordered, generation-local sender for receipt/hold/close bridge calls.
 *
 * It never owns screen recovery. A bounded fail-stop result is handed to the
 * surface owner, which may expose diagnostics and require explicit
 * close/recreate without reset, replay, or replacement attach.
 */
export class TerminalOutputDeliveryControlSender {
  private readonly scope: TerminalOutputControlMountScope;
  private readonly invoke: TerminalOutputDeliveryControlSenderOptions["invoke"];
  private readonly isCurrent: TerminalOutputDeliveryControlSenderOptions["isCurrent"];
  private readonly timeoutMs: number;
  private readonly maxTimedOutOrphans: number;
  private readonly maxRememberedIdentities: number;
  private readonly records = new Map<string, RequestRecord>();
  private readonly completedKeys: string[] = [];
  private tail: Promise<void> = Promise.resolve();
  private capacityWait: CapacityWait | undefined;
  private failure: TerminalOutputDeliveryControlFailStop | undefined;
  private disposed = false;

  constructor(options: TerminalOutputDeliveryControlSenderOptions) {
    const timeoutMs = options.timeoutMs ?? TERMINAL_OUTPUT_DELIVERY_CONTROL_TIMEOUT_MS;
    const maxTimedOutOrphans =
      options.maxTimedOutOrphans ?? TERMINAL_OUTPUT_DELIVERY_CONTROL_ORPHAN_CAP;
    const maxRememberedIdentities = options.maxRememberedIdentities ?? 64;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new Error("terminal output delivery timeout must be nonnegative");
    }
    if (!isPositiveInteger(maxTimedOutOrphans)) {
      throw new Error("terminal output delivery orphan cap must be a positive integer");
    }
    if (!isPositiveInteger(maxRememberedIdentities)) {
      throw new Error("terminal output delivery identity history must be a positive integer");
    }

    this.scope = options.scope;
    this.invoke = options.invoke;
    this.isCurrent = options.isCurrent;
    this.timeoutMs = timeoutMs;
    this.maxTimedOutOrphans = maxTimedOutOrphans;
    this.maxRememberedIdentities = maxRememberedIdentities;
  }

  send(
    request: TerminalOutputDeliveryControlRequest,
  ): Promise<TerminalOutputDeliveryControlResult> {
    const immutable = normalizeRequest(request);
    if (this.failure) return Promise.resolve(this.failure);
    if (this.disposed || !this.current(immutable)) {
      return Promise.resolve(staleResult(immutable));
    }

    const key = identityKey(immutable.identity);
    const fingerprint = payloadFingerprint(immutable);
    const existing = this.records.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.resolve(this.failStop("identity_conflict", immutable.identity));
      }
      if (existing.result) return Promise.resolve(existing.result);
      if (existing.promise) return existing.promise;
    }

    const record: RequestRecord = { fingerprint, request: immutable };
    const promise = this.tail.then(() => this.execute(immutable));
    record.promise = promise;
    this.records.set(key, record);
    this.tail = promise.then(
      () => undefined,
      () => undefined,
    );
    void promise.then((result) => this.finishRecord(key, record, result));
    return promise;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scope.dispose();
    const waiting = this.capacityWait;
    this.capacityWait = undefined;
    waiting?.resolve("stale");
  }

  private async execute(
    request: ImmutableTerminalOutputDeliveryControlRequest,
  ): Promise<TerminalOutputDeliveryControlResult> {
    for (;;) {
      if (this.failure) return this.failure;
      if (this.disposed || !this.current(request)) {
        this.dispose();
        return staleResult(request);
      }
      if (this.orphanCapReached(request.identity.kind)) {
        return this.failStop("control_orphan_cap", request.identity);
      }

      const operation = this.scope.tryStart(request.identity.kind);
      if (!operation) {
        const capacity = await this.waitForCapacity(request);
        if (this.failure) return this.failure;
        if (capacity === "stale") return staleResult(request);
        continue;
      }

      let invocation: Promise<boolean>;
      try {
        invocation = Promise.resolve(this.invoke(request));
      } catch (error) {
        invocation = Promise.reject(error);
      }
      const outcome = await settleTerminalOutputControl(invocation, this.timeoutMs, {
        onTimeout: () => operation.markTimedOut(),
        onSettled: () => operation.settle(),
      });

      if (this.failure) return this.failure;
      if (this.disposed || !this.current(request)) {
        this.dispose();
        return staleResult(request);
      }
      if (outcome.kind === "resolved") {
        return outcome.value
          ? { kind: "accepted", identity: request.identity }
          : staleResult(request);
      }
      if (outcome.kind === "rejected") {
        return { kind: "rejected", identity: request.identity, error: outcome.error };
      }

      // The bridge Promise cannot be cancelled. Its registry lease stays
      // charged until late settlement, while the next iteration retries the
      // exact same frozen identity/payload.
      if (this.orphanCapReached(request.identity.kind)) {
        return this.failStop("control_orphan_cap", request.identity);
      }
    }
  }

  private waitForCapacity(
    request: ImmutableTerminalOutputDeliveryControlRequest,
  ): Promise<"ready" | "stale"> {
    if (this.disposed || !this.current(request)) return Promise.resolve("stale");
    const key = identityKey(request.identity);
    return new Promise((resolve) => {
      this.capacityWait = { key, resolve };
      this.scope.waitForCapacity(request.identity.kind, () => {
        const waiting = this.capacityWait;
        if (!waiting || waiting.key !== key) return;
        this.capacityWait = undefined;
        if (this.disposed || !this.current(request)) {
          // Consume and immediately release the reservation the registry made
          // for this waiter. No bridge call belongs to a stale token.
          this.scope.tryStart(request.identity.kind)?.settle();
          this.dispose();
          waiting.resolve("stale");
          return;
        }
        waiting.resolve("ready");
      });
    });
  }

  private current(request: ImmutableTerminalOutputDeliveryControlRequest): boolean {
    try {
      return this.isCurrent(request);
    } catch {
      return false;
    }
  }

  private orphanCapReached(kind: TerminalOutputDeliveryControlKind): boolean {
    return (
      this.scope.localTimedOut(kind) >= this.maxTimedOutOrphans ||
      this.scope.globalTimedOut(kind) >= this.maxTimedOutOrphans
    );
  }

  private failStop(
    reason: TerminalOutputDeliveryControlFailStop["reason"],
    identity: Readonly<TerminalOutputDeliveryControlIdentity>,
  ): TerminalOutputDeliveryControlFailStop {
    if (this.failure) return this.failure;
    this.failure = { kind: "fail-stop", reason, identity };
    this.dispose();
    return this.failure;
  }

  private finishRecord(
    key: string,
    record: RequestRecord,
    result: TerminalOutputDeliveryControlResult,
  ): void {
    if (this.records.get(key) !== record) return;
    record.promise = undefined;
    if (result.kind === "rejected") {
      this.records.delete(key);
      return;
    }
    record.result = result;
    this.completedKeys.push(key);
    while (this.completedKeys.length > this.maxRememberedIdentities) {
      const oldest = this.completedKeys.shift();
      if (oldest !== undefined && oldest !== key) this.records.delete(oldest);
    }
  }
}

function normalizeRequest(
  request: TerminalOutputDeliveryControlRequest,
): ImmutableTerminalOutputDeliveryControlRequest {
  const identity = request.identity;
  if (
    (identity.kind !== "receipt" && identity.kind !== "hold" && identity.kind !== "close") ||
    identity.terminalId.length === 0 ||
    !isNonnegativeSafeInteger(identity.generation) ||
    identity.leaseToken.length === 0 ||
    !isPositiveSafeInteger(identity.envelopeId) ||
    (identity.grantId !== null && identity.grantId.length === 0) ||
    (identity.kind !== "receipt" && identity.grantId === null)
  ) {
    throw new Error("invalid terminal output delivery control identity");
  }

  if (isReceiptRequest(request)) {
    if (
      !hasOnlyKeys(request.payload, ["seqEnd"]) ||
      !isNonnegativeSafeInteger(request.payload.seqEnd)
    ) {
      throw new Error("invalid terminal output receipt payload");
    }
    return Object.freeze({
      identity: Object.freeze({ ...request.identity }),
      payload: Object.freeze({ seqEnd: request.payload.seqEnd }),
    });
  }
  if (isHoldRequest(request)) {
    if (
      !hasOnlyKeys(request.payload, ["frameStartSeq"]) ||
      !isNonnegativeSafeInteger(request.payload.frameStartSeq)
    ) {
      throw new Error("invalid terminal output hold payload");
    }
    return Object.freeze({
      identity: Object.freeze({ ...request.identity }),
      payload: Object.freeze({ frameStartSeq: request.payload.frameStartSeq }),
    });
  }
  if (
    !hasOnlyKeys(request.payload, ["closeSeq", "reason"]) ||
    !isNonnegativeSafeInteger(request.payload.closeSeq) ||
    typeof request.payload.reason !== "string" ||
    request.payload.reason.length === 0
  ) {
    throw new Error("invalid terminal output close payload");
  }
  return Object.freeze({
    identity: Object.freeze({ ...request.identity }),
    payload: Object.freeze({
      closeSeq: request.payload.closeSeq,
      reason: request.payload.reason,
    }),
  });
}

function identityKey(identity: Readonly<TerminalOutputDeliveryControlIdentity>): string {
  return JSON.stringify([
    identity.kind,
    identity.terminalId,
    identity.generation,
    identity.leaseToken,
    identity.envelopeId,
    identity.grantId,
  ]);
}

function payloadFingerprint(request: ImmutableTerminalOutputDeliveryControlRequest): string {
  if (isImmutableReceiptRequest(request)) return JSON.stringify([request.payload.seqEnd]);
  if (isImmutableHoldRequest(request)) return JSON.stringify([request.payload.frameStartSeq]);
  return JSON.stringify([request.payload.closeSeq, request.payload.reason]);
}

function isReceiptRequest(
  request: TerminalOutputDeliveryControlRequest,
): request is Extract<TerminalOutputDeliveryControlRequest, { identity: { kind: "receipt" } }> {
  return request.identity.kind === "receipt";
}

function isHoldRequest(
  request: TerminalOutputDeliveryControlRequest,
): request is Extract<TerminalOutputDeliveryControlRequest, { identity: { kind: "hold" } }> {
  return request.identity.kind === "hold";
}

function isImmutableReceiptRequest(
  request: ImmutableTerminalOutputDeliveryControlRequest,
): request is Extract<
  ImmutableTerminalOutputDeliveryControlRequest,
  { identity: { kind: "receipt" } }
> {
  return request.identity.kind === "receipt";
}

function isImmutableHoldRequest(
  request: ImmutableTerminalOutputDeliveryControlRequest,
): request is Extract<
  ImmutableTerminalOutputDeliveryControlRequest,
  { identity: { kind: "hold" } }
> {
  return request.identity.kind === "hold";
}

function staleResult(
  request: ImmutableTerminalOutputDeliveryControlRequest,
): TerminalOutputDeliveryControlResult {
  return { kind: "stale", identity: request.identity };
}

function hasOnlyKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
