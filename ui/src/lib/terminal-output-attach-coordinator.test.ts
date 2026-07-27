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
      generation: 7,
      snapshotStartSeq,
      snapshotSeq: snapshotStartSeq + snapshot.length,
      sourceStartSeq: snapshotStartSeq,
      sourceSeq: snapshotStartSeq + snapshot.length,
      snapshotKind: "raw",
      protocolRevision: 2,
      modes: { bracketedPaste: true },
      geometry: { revision: 3, cols: 80, rows: 24 },
    },
    snapshot,
  };
}

function delta(seqStart: number, text: string, geometryRevision = 3) {
  const data = bytes(text);
  return {
    generation: 7,
    seqStart,
    seqEnd: seqStart + data.length,
    data,
    geometry: { revision: geometryRevision, cols: 80, rows: 24 },
  };
}

describe("TerminalOutputAttachCoordinator", () => {
  it("drops a buffered delta already covered by the snapshot", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    coordinator.ingest(delta(4, "def"));
    expect(coordinator.completeAttach(attachment(0, "abcdefg"))).toEqual({
      kind: "duplicate",
      chunks: [],
      segments: [],
    });
  });

  it("keeps only a buffered delta suffix crossing snapshotSeq", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    coordinator.ingest(delta(4, "efghi"));
    const result = coordinator.completeAttach(attachment(0, "abcdef"));
    expect(result.kind).toBe("apply");
    expect(new TextDecoder().decode(result.chunks[0])).toBe("ghi");
  });

  it("sorts buffered deltas and applies an exact contiguous stream", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    coordinator.ingest(delta(5, "fg"));
    coordinator.ingest(delta(3, "de"));
    const result = coordinator.completeAttach(attachment(0, "abc"));
    expect(result.chunks.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["de", "fg"]);
  });

  it("reports a gap instead of silently clamping", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    coordinator.completeAttach(attachment(0, "abc"));
    expect(coordinator.ingest(delta(5, "f"))).toMatchObject({
      kind: "gap",
      expectedSeq: 3,
      actualSeq: 5,
    });
  });

  it("keeps the gapped delta buffered so a repair can splice it back in", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    coordinator.completeAttach(attachment(0, "abc"));

    expect(coordinator.ingest(delta(5, "fg"))).toMatchObject({ kind: "gap" });

    expect(coordinator.beginRepair()).toBe(3);
    const result = coordinator.completeRepair(delta(3, "de"));

    expect(result.kind).toBe("apply");
    expect(result.chunks.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["de", "fg"]);
    expect(coordinator.ready).toBe(true);
  });

  it("trims a repair range that overlaps bytes the surface already applied", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    coordinator.completeAttach(attachment(0, "abc"));
    coordinator.ingest(delta(6, "g"));
    coordinator.beginRepair();

    // The backend serves `[3, 7)`; the buffered `[6, 7)` delta is a duplicate.
    const result = coordinator.completeRepair(delta(3, "defg"));

    expect(result.chunks.map((chunk) => new TextDecoder().decode(chunk))).toEqual(["defg"]);
    expect(coordinator.ingest(delta(7, "h")).kind).toBe("apply");
  });

  it("reports a gap when the repair itself does not reach the expected sequence", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    coordinator.completeAttach(attachment(0, "abc"));
    coordinator.ingest(delta(5, "f"));
    coordinator.beginRepair();

    expect(coordinator.completeRepair(delta(4, "e"))).toMatchObject({
      kind: "gap",
      expectedSeq: 3,
      actualSeq: 4,
    });
    expect(coordinator.ready).toBe(false);
  });

  it("refuses a repair that spans a geometry revision it cannot attribute", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    coordinator.completeAttach(attachment(0, "abc"));
    coordinator.ingest(delta(5, "f", 3));
    coordinator.beginRepair();

    expect(() => coordinator.completeRepair(delta(3, "de", 4))).toThrow(
      "terminal output repair spans a geometry change",
    );
    expect(coordinator.ready).toBe(false);
  });

  it("refuses a repair from another generation", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    coordinator.completeAttach(attachment(0, "abc"));
    coordinator.ingest(delta(5, "f"));
    coordinator.beginRepair();

    expect(() => coordinator.completeRepair({ ...delta(3, "de"), generation: 8 })).toThrow(
      "terminal output generation changed",
    );
  });

  it("cannot start a repair before the first attach completes", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    expect(() => coordinator.beginRepair()).toThrow("terminal output attach is not ready");
    expect(() => coordinator.completeRepair(delta(0, "a"))).toThrow(
      "terminal output repair is not pending",
    );
  });

  it("drops a pending repair when a full attach takes over", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    coordinator.completeAttach(attachment(0, "abc"));
    coordinator.ingest(delta(5, "f"));
    coordinator.beginRepair();

    coordinator.beginAttach();

    expect(() => coordinator.completeRepair(delta(3, "de"))).toThrow(
      "terminal output repair is not pending",
    );
  });

  it("rejects malformed ranges and unsupported versions", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    expect(() => coordinator.ingest({ ...delta(0, "x"), seqEnd: 2 })).toThrow(
      "invalid terminal output delta range",
    );
    expect(() =>
      coordinator.completeAttach({
        ...attachment(0, "x"),
        state: { ...attachment(0, "x").state, version: 2 },
      }),
    ).toThrow("unsupported terminal output protocol");
  });

  it("returns generation and geometry on each exact applied segment", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    coordinator.completeAttach(attachment(0, "abc"));

    const result = coordinator.ingest(delta(3, "def", 4));

    expect(result.segments).toEqual([
      {
        generation: 7,
        seqStart: 3,
        seqEnd: 6,
        data: bytes("def"),
        geometry: { revision: 4, cols: 80, rows: 24 },
      },
    ]);
  });

  it("rejects a delta from another generation", () => {
    const coordinator = new TerminalOutputAttachCoordinator();
    coordinator.completeAttach(attachment(0, "abc"));

    expect(() => coordinator.ingest({ ...delta(3, "d"), generation: 8 })).toThrow(
      "terminal output generation changed",
    );
  });

  it.each([
    ["negative protocol revision", { protocolRevision: -1 }],
    ["fractional protocol revision", { protocolRevision: 1.5 }],
    ["unsafe protocol revision", { protocolRevision: Number.MAX_SAFE_INTEGER + 1 }],
    ["missing modes", { modes: undefined }],
    ["null modes", { modes: null }],
    ["array modes", { modes: [] }],
    ["non-boolean bracketed paste", { modes: { bracketedPaste: "true" } }],
    ["missing geometry", { geometry: undefined }],
    ["zero columns", { geometry: { revision: 0, cols: 0, rows: 24 } }],
    ["screen snapshot on the raw desktop attach path", { snapshotKind: "screen" }],
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
