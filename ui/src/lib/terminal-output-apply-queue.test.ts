import { describe, expect, it } from "vitest";
import { TerminalOutputApplyQueue } from "./terminal-output-apply-queue";
import type { TerminalOutputAppliedSegment } from "./terminal-output-attach-coordinator";

function segment(
  seqStart: number,
  bytes: number[],
  overrides: Partial<TerminalOutputAppliedSegment> = {},
): TerminalOutputAppliedSegment {
  return {
    generation: 1,
    seqStart,
    seqEnd: seqStart + bytes.length,
    data: new Uint8Array(bytes),
    geometry: { revision: 0, cols: 80, rows: 24 },
    ...overrides,
  };
}

function harness(startBusy = false) {
  let busy = startBusy;
  const batches: TerminalOutputAppliedSegment[][] = [];
  const queue = new TerminalOutputApplyQueue({
    isSurfaceBusy: () => busy,
    apply: (segments) => batches.push(segments),
  });
  return {
    queue,
    batches,
    setBusy: (value: boolean) => {
      busy = value;
    },
    /** Every byte the surface received, in order. */
    bytes: () => {
      const out: number[] = [];
      for (const batch of batches) for (const s of batch) out.push(...s.data);
      return out;
    },
    /** How many surface writes were performed in total. */
    writes: () => batches.reduce((total, batch) => total + batch.length, 0),
  };
}

describe("TerminalOutputApplyQueue", () => {
  it("applies immediately while the surface is idle, one write per delta", () => {
    const h = harness();
    h.queue.push([segment(0, [1, 2])]);
    h.queue.push([segment(2, [3])]);

    expect(h.writes()).toBe(2);
    expect(h.bytes()).toEqual([1, 2, 3]);
    expect(h.queue.depth).toBe(0);
  });

  it("holds deltas while the surface is behind and merges them into one write", () => {
    const h = harness(true);
    for (let i = 0; i < 50; i += 1) h.queue.push([segment(i, [i])]);

    // Nothing reached the surface yet — that is what makes the merge possible.
    expect(h.writes()).toBe(0);
    expect(h.queue.depth).toBe(50);

    h.queue.flush();

    // 50 deltas, one write. This ratio is the whole fix for issue #606: the
    // per-segment constant (write callback, checkpoint write, detector sweep) is
    // paid once instead of fifty times.
    expect(h.writes()).toBe(1);
    expect(h.bytes()).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });

  it("keeps byte order across a held batch and the deltas that follow it", () => {
    const h = harness(true);
    h.queue.push([segment(0, [1, 2])]);
    h.queue.push([segment(2, [3, 4])]);
    h.queue.flush();
    h.setBusy(false);
    h.queue.push([segment(4, [5])]);

    expect(h.bytes()).toEqual([1, 2, 3, 4, 5]);
  });

  it("does not merge across a geometry revision change", () => {
    const h = harness(true);
    h.queue.push([segment(0, [1])]);
    h.queue.push([segment(1, [2], { geometry: { revision: 1, cols: 80, rows: 12 } })]);
    h.queue.flush();

    // The checkpoint model has to resize between these bytes (ADR-0069), so the
    // boundary must survive coalescing.
    expect(h.writes()).toBe(2);
    expect(h.bytes()).toEqual([1, 2]);
  });

  it("applies a multi-segment push as one batch so a repair keeps its order", () => {
    const h = harness();
    // What `completeRepair` returns: the served range plus the deltas it splices
    // in front of, already in sequence order.
    h.queue.push([segment(0, [1, 2]), segment(2, [3, 4])]);

    expect(h.batches).toHaveLength(1);
    expect(h.writes()).toBe(1);
    expect(h.bytes()).toEqual([1, 2, 3, 4]);
  });

  it("empties itself before applying, so a re-entrant flush cannot double-write", () => {
    let busy = true;
    const batches: TerminalOutputAppliedSegment[][] = [];
    const queue: TerminalOutputApplyQueue = new TerminalOutputApplyQueue({
      isSurfaceBusy: () => busy,
      apply: (segments) => {
        batches.push(segments);
        // Mirrors production: applying goes through the write FIFO, whose
        // completion callback flushes this queue again.
        busy = false;
        queue.flush();
      },
    });

    queue.push([segment(0, [1])]);
    queue.push([segment(1, [2])]);
    queue.flush();

    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(1);
    expect(batches[0][0].data).toEqual(new Uint8Array([1, 2]));
  });

  it("drops held segments on clear so a re-attach replay is not written over", () => {
    const h = harness(true);
    h.queue.push([segment(0, [1, 2])]);
    h.queue.clear();
    h.queue.flush();

    expect(h.writes()).toBe(0);
    expect(h.queue.depth).toBe(0);
  });

  it("reports the queue depth after every push", () => {
    const depths: number[] = [];
    const queue = new TerminalOutputApplyQueue({
      isSurfaceBusy: () => true,
      apply: () => {},
      onDepth: (depth) => depths.push(depth),
    });
    queue.push([segment(0, [1])]);
    queue.push([segment(1, [2]), segment(2, [3])]);

    expect(depths).toEqual([1, 3]);
  });

  it("ignores an empty push instead of reporting a depth change", () => {
    const depths: number[] = [];
    const queue = new TerminalOutputApplyQueue({
      isSurfaceBusy: () => false,
      apply: () => {
        throw new Error("must not apply an empty push");
      },
      onDepth: (depth) => depths.push(depth),
    });
    queue.push([]);
    expect(depths).toEqual([]);
  });
});
