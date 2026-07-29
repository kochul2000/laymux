import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/plugin-shell", () => ({ open: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TerminalOutputEnvelopePayload } from "./terminal-output-envelope";
import {
  acknowledgeTerminalOutputEnvelope,
  closeTerminalOutputContinuation,
  failStopTerminalOutputSurface,
  holdTerminalOutputContinuation,
  onTerminalOutputFailStopped,
  onTerminalOutputV3,
  repairTerminalOutputEnvelope,
  type TerminalOutputAttachmentPayload,
  type TerminalOutputEnvelopeRepairStatus,
} from "./tauri-api";

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("terminal output v3 Tauri API", () => {
  it("requires the next envelope identity in attach flow control", () => {
    expectTypeOf<
      TerminalOutputAttachmentPayload["flowControl"]["nextEnvelopeId"]
    >().toEqualTypeOf<number>();
  });

  it("listens on the terminal-scoped v3 event and forwards the payload without copying", async () => {
    mockListen.mockResolvedValue(vi.fn());
    const callback = vi.fn();
    await onTerminalOutputV3("term-7", callback);

    expect(mockListen).toHaveBeenCalledWith("terminal-output-v3-term-7", expect.any(Function));
    const handler = mockListen.mock.calls[0]?.[1] as
      | ((event: { payload: TerminalOutputEnvelopePayload }) => void)
      | undefined;
    const payload: TerminalOutputEnvelopePayload = {
      version: 3,
      generation: 9,
      leaseToken: "lease-9",
      envelopeId: 12,
      grantId: "grant-4",
      seqStart: 100,
      seqEnd: 102,
      data: new Uint8Array([65, 66]),
      deltaEnds: [1, 2],
      geometryRuns: [{ deltaIndex: 0, geometry: { revision: 3, cols: 120, rows: 40 } }],
    };

    handler?.({ payload });

    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0]).toBe(payload);
    expect(callback.mock.calls[0][0].data).toBe(payload.data);
  });

  it("acknowledges one full envelope identity and parsed receipt range", async () => {
    mockInvoke.mockResolvedValue(true);

    await expect(
      acknowledgeTerminalOutputEnvelope("term-7", 9, "lease-9", 12, "grant-4", 102),
    ).resolves.toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith("acknowledge_terminal_output_envelope", {
      id: "term-7",
      generation: 9,
      token: "lease-9",
      envelopeId: 12,
      grantId: "grant-4",
      seqEnd: 102,
    });
  });

  it("requests one exact envelope repair and preserves the typed status response", async () => {
    const response = {
      status: "exact" as const,
      envelope: {
        version: 3,
        generation: 9,
        leaseToken: "lease-9",
        envelopeId: 12,
        grantId: "grant-4",
        seqStart: 100,
        seqEnd: 102,
        data: [65, 66],
        deltaEnds: [1, 2],
        geometryRuns: [{ deltaIndex: 0, geometry: { revision: 3, cols: 120, rows: 40 } }],
      },
    };
    mockInvoke.mockResolvedValue(response);

    await expect(
      repairTerminalOutputEnvelope("term-7", 9, "lease-9", 12, "grant-4", 100),
    ).resolves.toBe(response);
    expect(mockInvoke).toHaveBeenCalledWith("repair_terminal_output_envelope", {
      id: "term-7",
      generation: 9,
      token: "lease-9",
      envelopeId: 12,
      grantId: "grant-4",
      seqStart: 100,
    });
    expectTypeOf<TerminalOutputEnvelopeRepairStatus>().toEqualTypeOf<
      "idle" | "exact" | "stale" | "alreadyReceipted" | "mismatch" | "exhausted"
    >();
  });

  it("holds continuation credit with the opener's full identity", async () => {
    mockInvoke.mockResolvedValue(false);

    await expect(
      holdTerminalOutputContinuation("term-7", 9, "lease-9", 12, "grant-4", 100),
    ).resolves.toBe(false);
    expect(mockInvoke).toHaveBeenCalledWith("hold_terminal_output_continuation", {
      id: "term-7",
      generation: 9,
      token: "lease-9",
      envelopeId: 12,
      grantId: "grant-4",
      frameStartSeq: 100,
    });
  });

  it("closes or aborts continuation with the grant identity and reason", async () => {
    mockInvoke.mockResolvedValue(true);

    await expect(
      closeTerminalOutputContinuation("term-7", 9, "lease-9", 12, "grant-4", 144, "abort:timeout"),
    ).resolves.toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith("close_terminal_output_continuation", {
      id: "term-7",
      generation: 9,
      token: "lease-9",
      envelopeId: 12,
      grantId: "grant-4",
      closeSeq: 144,
      reason: "abort:timeout",
    });
  });

  it("reports a typed current surface failure with the full lease identity", async () => {
    mockInvoke.mockResolvedValue(true);

    await expect(
      failStopTerminalOutputSurface("term-7", 9, "lease-9", "control_orphan_cap"),
    ).resolves.toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith("fail_stop_terminal_output_surface", {
      id: "term-7",
      generation: 9,
      token: "lease-9",
      reason: "control_orphan_cap",
    });
  });

  it("listens for backend surface fail-stop payloads on the shared event", async () => {
    mockListen.mockResolvedValue(vi.fn());
    const callback = vi.fn();
    await onTerminalOutputFailStopped(callback);

    expect(mockListen).toHaveBeenCalledWith("terminal-output-fail-stopped", expect.any(Function));
    const handler = mockListen.mock.calls[0]?.[1] as
      | ((event: {
          payload: {
            terminalId: string;
            generation: number;
            leaseToken: string;
            reason: string;
          };
        }) => void)
      | undefined;
    const payload = {
      terminalId: "term-7",
      generation: 9,
      leaseToken: "lease-9",
      reason: "continuation_expired",
    };

    handler?.({ payload });

    expect(callback).toHaveBeenCalledWith(payload);
  });

  it("propagates backend contract errors instead of translating them to stale", async () => {
    const failure = new Error("identity conflict");
    mockInvoke.mockRejectedValue(failure);

    await expect(
      closeTerminalOutputContinuation("term-7", 9, "lease-9", 12, "grant-4", 144, "close"),
    ).rejects.toBe(failure);
  });
});
