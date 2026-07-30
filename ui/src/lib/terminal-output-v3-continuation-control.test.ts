import { beforeEach, describe, expect, it, vi } from "vitest";

import type {
  TerminalOutputDeliveryControlRequest,
  TerminalOutputDeliveryControlResult,
} from "./terminal-output-delivery-control";
import type { TerminalOutputEnvelopeIngress } from "./terminal-output-envelope-ingress";
import type {
  TerminalOutputFrameContinuationGrant,
  TerminalOutputFrameContinuationTransition,
} from "./terminal-output-frame-continuation";
import { TerminalOutputV3ContinuationControl } from "./terminal-output-v3-continuation-control";
import { resetTerminalOutputV3DiagnosticsForTest } from "./terminal-output-v3-diagnostics";

const TERMINAL_ID = "terminal-pane-test";
const GENERATION = 2;
const LEASE_TOKEN = "1";

function grant(grantId: string, envelopeId: number): TerminalOutputFrameContinuationGrant {
  return {
    terminalId: TERMINAL_ID,
    generation: GENERATION,
    leaseToken: LEASE_TOKEN,
    envelopeId,
    grantId,
  };
}

function opened(
  grantId: string,
  envelopeId: number,
  frameStartSeq: number,
): TerminalOutputFrameContinuationTransition {
  return {
    type: "opened",
    envelopeId,
    frameStartSeq,
    frameEndSeq: 0,
    grant: grant(grantId, envelopeId),
    grantResult: "open",
    reason: null,
  } as unknown as TerminalOutputFrameContinuationTransition;
}

function closed(
  grantId: string,
  envelopeId: number,
  frameEndSeq: number,
): TerminalOutputFrameContinuationTransition {
  return {
    type: "closed",
    envelopeId,
    frameStartSeq: 0,
    frameEndSeq,
    grant: grant(grantId, envelopeId),
    grantResult: "close",
    reason: null,
  } as unknown as TerminalOutputFrameContinuationTransition;
}

function setup() {
  const sent: TerminalOutputDeliveryControlRequest[] = [];
  const failStops: string[] = [];
  let failed = false;

  const ingress = {
    terminalId: TERMINAL_ID,
    generation: GENERATION,
    leaseToken: LEASE_TOKEN,
  } as unknown as TerminalOutputEnvelopeIngress;

  const control = new TerminalOutputV3ContinuationControl({
    ingress,
    deliveryControl: {
      send: (request: TerminalOutputDeliveryControlRequest) => {
        sent.push(request);
        return Promise.resolve({
          kind: "accepted",
          identity: request.identity,
        } as TerminalOutputDeliveryControlResult);
      },
    },
    isFailStopped: () => failed,
    failStop: (reason: string) => {
      failed = true;
      failStops.push(reason);
      return { kind: "fail-stop", reason } as never;
    },
    resumeEnvelope: vi.fn(),
  });

  return { control, sent, failStops };
}

describe("TerminalOutputV3ContinuationControl one-grant-per-envelope", () => {
  beforeEach(() => {
    resetTerminalOutputV3DiagnosticsForTest();
  });

  /**
   * Regression for the Codex-frame flood fail-stop.
   *
   * The backend keys its hold dedup on the opener envelope identity with the
   * grant id stripped (`delivery_continuation.rs` `last_hold`). A second hold
   * carrying the same `envelopeId` with a different grant/frameStart is
   * therefore not a new identity but a reuse, and Rust answers
   * `terminal output hold identity was reused with different payload`
   * -> `identity_conflict` fail-stop.
   *
   * Under backpressure a 64 KiB envelope carries many small DECSET 2026 frames,
   * so a later frame in the *same* envelope must never open a second backend
   * continuation, no matter when the earlier close response settles.
   */
  it("does not open a second continuation for a later frame in the same envelope", () => {
    const { control, failStops } = setup();

    const first = control.controlsForTransitions([opened("grant-a", 285, 12_330_039)], 285);
    expect(first?.map((c) => c.identity.kind)).toEqual(["hold"]);

    // The close response has not settled yet, so `grant`/`closing` are still
    // whatever the first pass left. Re-entering for the SAME envelope must not
    // produce a second hold for a different frame.
    const second = control.controlsForTransitions([opened("grant-b", 285, 12_367_433)], 285);

    expect(failStops).toEqual([]);
    expect(second?.filter((c) => c.identity.kind === "hold")).toEqual([]);
  });

  it("still holds once for a frame that opens in a later envelope", () => {
    const { control, failStops } = setup();

    control.controlsForTransitions([opened("grant-a", 285, 1_000)], 285);
    const closeControls = control.controlsForTransitions([closed("grant-a", 285, 2_000)], 285);
    expect(closeControls?.map((c) => c.identity.kind)).toEqual(["close"]);

    expect(failStops).toEqual([]);
  });
});
