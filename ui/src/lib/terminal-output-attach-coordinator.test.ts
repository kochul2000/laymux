import { describe, expect, it } from "vitest";
import {
  normalizeTerminalOutputAttachment,
  TerminalOutputAttachCoordinator,
  type TerminalAttachState,
  type TerminalOutputAttachment,
} from "./terminal-output-attach-coordinator";

const bytes = (value: string) => new TextEncoder().encode(value);

function attachment(snapshotStartSeq: number, text: string): TerminalOutputAttachment {
  const snapshot = bytes(text);
  return {
    state: {
      version: 1,
      snapshotStartSeq,
      snapshotSeq: snapshotStartSeq + snapshot.length,
      protocolRevision: 2,
      modes: { bracketedPaste: true },
    },
    snapshot,
  };
}

describe("TerminalOutputAttachCoordinator", () => {
  it("drops a buffered delta already covered by the snapshot", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    coordinator.ingest({ seqStart: 4, seqEnd: 7, data: bytes("def") });
    expect(coordinator.completeAttach(attachment(0, "abcdefg"))).toEqual({
      kind: "duplicate",
      chunks: [],
    });
  });

  it("keeps only a buffered delta suffix crossing snapshotSeq", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    coordinator.ingest({ seqStart: 4, seqEnd: 9, data: bytes("efghi") });
    const result = coordinator.completeAttach(attachment(0, "abcdef"));
    expect(result.kind).toBe("apply");
    expect(new TextDecoder().decode(result.chunks[0])).toBe("ghi");
  });

  it("sorts buffered deltas and applies an exact contiguous stream", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    coordinator.ingest({ seqStart: 5, seqEnd: 7, data: bytes("fg") });
    coordinator.ingest({ seqStart: 3, seqEnd: 5, data: bytes("de") });
    const result = coordinator.completeAttach(attachment(0, "abc"));
    expect(result.chunks.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["de", "fg"]);
  });

  it("reports a gap instead of silently clamping", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    coordinator.completeAttach(attachment(0, "abc"));
    expect(coordinator.ingest({ seqStart: 5, seqEnd: 6, data: bytes("f") })).toMatchObject({
      kind: "gap",
      expectedSeq: 3,
      actualSeq: 5,
    });
  });

  it("rejects malformed ranges and unsupported versions", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    expect(() => coordinator.ingest({ seqStart: 0, seqEnd: 2, data: bytes("x") })).toThrow(
      "invalid terminal output delta range",
    );
    expect(() =>
      coordinator.completeAttach({
        ...attachment(0, "x"),
        state: { ...attachment(0, "x").state, version: 2 },
      }),
    ).toThrow("unsupported terminal output protocol");
  });

  it.each([
    ["negative protocol revision", { protocolRevision: -1 }],
    ["fractional protocol revision", { protocolRevision: 1.5 }],
    ["unsafe protocol revision", { protocolRevision: Number.MAX_SAFE_INTEGER + 1 }],
    ["missing modes", { modes: undefined }],
    ["null modes", { modes: null }],
    ["array modes", { modes: [] }],
    ["non-boolean bracketed paste", { modes: { bracketedPaste: "true" } }],
  ])("rejects malformed attach metadata: %s", (_name, statePatch) => {
    const coordinator = new TerminalOutputAttachCoordinator();
    coordinator.completeAttach(attachment(0, "old"));
    const valid = attachment(0, "new");
    const malformed = {
      ...valid,
      state: { ...valid.state, ...statePatch } as unknown as TerminalAttachState,
    };

    expect(() => coordinator.completeAttach(malformed)).toThrow(
      "invalid terminal output attachment state",
    );
    expect(coordinator.ready).toBe(false);
  });

  it("validates normalized IPC attachments before they can be applied", () => {
    const valid = attachment(0, "snapshot");
    expect(() =>
      normalizeTerminalOutputAttachment({
        state: {
          ...valid.state,
          modes: { bracketedPaste: 1 },
        } as unknown as TerminalAttachState,
        snapshot: [...valid.snapshot],
      }),
    ).toThrow("invalid terminal output attachment state");
  });
});
