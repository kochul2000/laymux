import { describe, expect, it } from "vitest";
import {
  TerminalOutputEnvelopeIngress,
  TerminalOutputEnvelopeIngressError,
  type TerminalOutputParsedIdentity,
  type TerminalOutputReceiptIdentity,
} from "./terminal-output-envelope-ingress";
import type { TerminalOutputEnvelopePayload } from "./terminal-output-envelope";

const geometry = { revision: 3, cols: 80, rows: 24 };

function payload(
  envelopeId: number,
  seqStart: number,
  text: string,
  overrides: Partial<TerminalOutputEnvelopePayload> = {},
): TerminalOutputEnvelopePayload {
  const data = new TextEncoder().encode(text);
  return {
    version: 3,
    generation: 7,
    leaseToken: "lease-7",
    envelopeId,
    grantId: null,
    seqStart,
    seqEnd: seqStart + data.length,
    data,
    deltaEnds: [data.length],
    geometryRuns: [{ deltaIndex: 0, geometry }],
    ...overrides,
  };
}

function ingress() {
  return new TerminalOutputEnvelopeIngress({
    terminalId: "terminal-1",
    generation: 7,
    leaseToken: "lease-7",
    initialSeq: 10,
    initialEnvelopeId: 41,
  });
}

function identity(overrides: Partial<TerminalOutputReceiptIdentity> = {}) {
  return {
    terminalId: "terminal-1",
    generation: 7,
    leaseToken: "lease-7",
    envelopeId: 41,
    grantId: null,
    ...overrides,
  } satisfies TerminalOutputReceiptIdentity;
}

function parsed(seq: number, overrides: Partial<TerminalOutputParsedIdentity> = {}) {
  return {
    terminalId: "terminal-1",
    generation: 7,
    leaseToken: "lease-7",
    seq,
    ...overrides,
  } satisfies TerminalOutputParsedIdentity;
}

describe("TerminalOutputEnvelopeIngress", () => {
  it("admits one exact generation/token/envelope/sequence and retains its backing until receipt", () => {
    const target = ingress();
    const source = new TextEncoder().encode("abc");
    const accepted = target.accept(payload(41, 10, "abc", { data: source }));

    expect(accepted.backing).toBe(source);
    expect(target.admittedSeq).toBe(13);
    expect(target.expectedEnvelopeId).toBe(42);
    expect(target.unreceipted?.backing).toBe(source);
    expect(target.unreceipted?.identity).toEqual(identity());
    expect(target.unparsed).toEqual([
      {
        envelopeId: 41,
        grantId: null,
        seqStart: 10,
        seqEnd: 13,
        sourceBytes: 3,
        originalDeltaCount: 1,
      },
    ]);
  });

  it("allows only one unreceipted backing, then admits the next envelope after exact receipt", () => {
    const target = ingress();
    target.accept(payload(41, 10, "abc"));

    expect(() => target.accept(payload(42, 13, "def"))).toThrowError(
      expect.objectContaining({ code: "receipt-pending" }),
    );
    expect(target.admittedSeq).toBe(13);
    expect(target.expectedEnvelopeId).toBe(42);

    expect(target.completeReceipt(identity())).toBe("accepted");
    expect(target.unreceipted).toBeUndefined();
    target.accept(payload(42, 13, "def"));
    expect(target.admittedSeq).toBe(16);
    expect(target.expectedEnvelopeId).toBe(43);
  });

  it("keeps receipt and parsed frontiers independent in both completion orders", () => {
    const receiptFirst = ingress();
    receiptFirst.accept(payload(41, 10, "abc"));
    expect(receiptFirst.completeReceipt(identity())).toBe("accepted");
    expect(receiptFirst.parsedSeq).toBe(10);
    expect(receiptFirst.unparsed).toHaveLength(1);
    expect(receiptFirst.completeParsed(parsed(13))).toBe("accepted");
    expect(receiptFirst.parsedSeq).toBe(13);
    expect(receiptFirst.unparsed).toEqual([]);

    const parsedFirst = ingress();
    parsedFirst.accept(payload(41, 10, "abc"));
    expect(parsedFirst.completeParsed(parsed(13))).toBe("accepted");
    expect(parsedFirst.parsedSeq).toBe(13);
    expect(parsedFirst.unparsed).toEqual([]);
    expect(parsedFirst.unreceipted?.identity).toEqual(identity());
    expect(parsedFirst.completeReceipt(identity())).toBe("accepted");
  });

  it("treats stale receipt completions as no-ops and exact retries as idempotent", () => {
    const target = ingress();
    target.accept(payload(41, 10, "abc"));

    expect(target.completeReceipt(identity({ leaseToken: "old-lease" }))).toBe("stale");
    expect(target.completeReceipt(identity({ grantId: "foreign-grant" }))).toBe("stale");
    expect(target.unreceipted?.identity).toEqual(identity());
    expect(target.completeReceipt(identity())).toBe("accepted");
    expect(target.completeReceipt(identity())).toBe("duplicate");
    expect(target.admittedSeq).toBe(13);
    expect(target.parsedSeq).toBe(10);
    expect(target.completeParsed(parsed(13, { leaseToken: "old-lease" }))).toBe("stale");
    expect(target.parsedSeq).toBe(10);
  });

  it.each([
    ["generation", { generation: 8 }, "session-mismatch"],
    ["lease token", { leaseToken: "lease-8" }, "session-mismatch"],
    ["envelope id", { envelopeId: 42 }, "envelope-order"],
    ["source sequence", { seqStart: 11, seqEnd: 14 }, "sequence"],
  ] as const)("rejects an out-of-order %s without mutation", (_name, overrides, code) => {
    const target = ingress();
    const before = target.snapshot();

    expect(() => target.accept(payload(41, 10, "abc", overrides))).toThrowError(
      expect.objectContaining({ code }),
    );
    expect(target.snapshot()).toEqual(before);
  });

  it("prevalidates the whole malformed envelope before mutating any ingress ledger", () => {
    const target = ingress();
    const malformed = payload(41, 10, "abcdef", { deltaEnds: [2, 9] });
    const before = target.snapshot();

    expect(() => target.accept(malformed)).toThrow("terminal output envelope");
    expect(target.snapshot()).toEqual(before);
  });

  it("rejects parsed regressions and prefixes beyond admitted bytes without ledger mutation", () => {
    const target = ingress();
    target.accept(payload(41, 10, "abcdef"));
    target.completeParsed(parsed(13));
    const before = target.snapshot();

    for (const seq of [12, 17]) {
      expect(() => target.completeParsed(parsed(seq))).toThrowError(
        expect.objectContaining({ code: "parsed-range" }),
      );
      expect(target.snapshot()).toEqual(before);
    }
  });

  it("trims only parsed ranges while preserving transport receipt ownership", () => {
    const target = ingress();
    target.accept(payload(41, 10, "abcdef"));
    target.completeParsed(parsed(13));

    expect(target.unparsed).toEqual([
      {
        envelopeId: 41,
        grantId: null,
        seqStart: 13,
        seqEnd: 16,
        sourceBytes: 3,
        originalDeltaCount: 1,
      },
    ]);
    expect(target.unreceipted?.identity).toEqual(identity());
  });

  it("uses a typed error for ingress contract failures", () => {
    const target = ingress();
    target.accept(payload(41, 10, "abc"));

    try {
      target.accept(payload(42, 13, "def"));
      throw new Error("expected admission to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TerminalOutputEnvelopeIngressError);
    }
  });
});
