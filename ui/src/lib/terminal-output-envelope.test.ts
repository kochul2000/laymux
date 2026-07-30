import { describe, expect, it } from "vitest";
import {
  TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES,
  TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS,
  normalizeTerminalOutputEnvelope,
  type TerminalOutputEnvelopePayload,
} from "./terminal-output-envelope";

const geometry = (revision: number) => ({ revision, cols: 80, rows: 24 });

function payload(
  data: Uint8Array = new TextEncoder().encode("abcdef"),
  overrides: Partial<TerminalOutputEnvelopePayload> = {},
): TerminalOutputEnvelopePayload {
  return {
    version: 3,
    generation: 7,
    leaseToken: "lease-7",
    envelopeId: 41,
    grantId: null,
    seqStart: 10,
    seqEnd: 10 + data.length,
    data,
    deltaEnds: [2, 4, data.length],
    geometryRuns: [
      { deltaIndex: 0, geometry: geometry(3) },
      { deltaIndex: 2, geometry: geometry(4) },
    ],
    ...overrides,
  };
}

describe("normalizeTerminalOutputEnvelope", () => {
  it("reconstructs every delta as a zero-copy view with its geometry run", () => {
    const source = new TextEncoder().encode("abcdef");
    const envelope = normalizeTerminalOutputEnvelope(payload(source));

    expect(envelope.backing).toBe(source);
    expect(envelope.deltas.map((delta) => new TextDecoder().decode(delta.data))).toEqual([
      "ab",
      "cd",
      "ef",
    ]);
    expect(envelope.deltas.every((delta) => delta.data.buffer === source.buffer)).toBe(true);
    expect(envelope.deltas.map((delta) => delta.data.byteOffset)).toEqual([0, 2, 4]);
    expect(envelope.deltas.map((delta) => delta.geometry.revision)).toEqual([3, 3, 4]);
    expect(envelope.receiptIdentity).toEqual({
      generation: 7,
      leaseToken: "lease-7",
      envelopeId: 41,
      grantId: null,
    });
  });

  it("accepts the exact 64 KiB and 8,192-delta bounds", () => {
    const source = new Uint8Array(TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES);
    const deltaEnds = Array.from(
      { length: TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS },
      (_, index) => (index + 1) * 8,
    );
    const envelope = normalizeTerminalOutputEnvelope(
      payload(source, {
        seqStart: 0,
        seqEnd: source.length,
        deltaEnds,
        geometryRuns: [{ deltaIndex: 0, geometry: geometry(0) }],
      }),
    );

    expect(envelope.backing.byteLength).toBe(TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES);
    expect(envelope.deltas).toHaveLength(TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS);
  });

  it("rejects bytes or delta counts one past their hard bounds", () => {
    const oversized = new Uint8Array(TERMINAL_OUTPUT_ENVELOPE_MAX_BYTES + 1);
    expect(() =>
      normalizeTerminalOutputEnvelope(
        payload(oversized, {
          seqStart: 0,
          seqEnd: oversized.length,
          deltaEnds: [oversized.length],
          geometryRuns: [{ deltaIndex: 0, geometry: geometry(0) }],
        }),
      ),
    ).toThrow("data");

    const tooManyEnds = Array.from(
      { length: TERMINAL_OUTPUT_ENVELOPE_MAX_DELTAS + 1 },
      (_, index) => index + 1,
    );
    expect(() =>
      normalizeTerminalOutputEnvelope(
        payload(new Uint8Array(tooManyEnds.length), {
          seqStart: 0,
          seqEnd: tooManyEnds.length,
          deltaEnds: tooManyEnds,
          geometryRuns: [{ deltaIndex: 0, geometry: geometry(0) }],
        }),
      ),
    ).toThrow("delta");
  });

  it.each([
    ["empty lease token", { leaseToken: "" }],
    ["empty grant id", { grantId: "" }],
    ["non-positive envelope id", { envelopeId: 0 }],
    ["source range mismatch", { seqEnd: 99 }],
    ["non-monotonic delta ends", { deltaEnds: [2, 2, 6] }],
    ["incomplete delta ends", { deltaEnds: [2, 4, 5] }],
    [
      "geometry not starting at delta zero",
      { geometryRuns: [{ deltaIndex: 1, geometry: geometry(3) }] },
    ],
    [
      "non-monotonic geometry runs",
      {
        geometryRuns: [
          { deltaIndex: 0, geometry: geometry(3) },
          { deltaIndex: 0, geometry: geometry(4) },
        ],
      },
    ],
  ] as const)("rejects %s", (_name, overrides) => {
    expect(() =>
      normalizeTerminalOutputEnvelope(
        payload(undefined, overrides as Partial<TerminalOutputEnvelopePayload>),
      ),
    ).toThrow("terminal output envelope");
  });

  it("validates number-array bytes before allocating the backing Uint8Array", () => {
    const invalid = payload();
    invalid.data = [65, 256, 66];
    invalid.seqEnd = invalid.seqStart + invalid.data.length;
    invalid.deltaEnds = [invalid.data.length];
    invalid.geometryRuns = [{ deltaIndex: 0, geometry: geometry(0) }];

    expect(() => normalizeTerminalOutputEnvelope(invalid)).toThrow("data");
  });
});
