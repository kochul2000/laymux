import { describe, expect, it } from "vitest";
import {
  TERMINAL_WRITE_BATCH_MAX_BYTES,
  TERMINAL_WRITE_BATCH_MAX_PARTS,
  TERMINAL_WRITE_ENQUEUE_SLICE_BYTES,
  TERMINAL_WRITE_FAIR_QUANTUM_BYTES,
  TerminalWriteBatchQueue,
  terminalWriteFairSlices,
  type TerminalWriteBatchMetadata,
  type TerminalWriteBatchRequest,
} from "./terminal-write-batch-queue";

type TestMetadata = TerminalWriteBatchMetadata & {
  marker?: string;
  needsSyncOutputMonitor?: boolean;
};

function request(
  bytes: number[],
  overrides: Partial<TerminalWriteBatchRequest<TestMetadata>> = {},
): TerminalWriteBatchRequest<TestMetadata> {
  return {
    data: new Uint8Array(bytes),
    metadata: { source: "live", attachEpoch: 7 },
    batchKey: "live:7:run-3",
    allowCoalescing: true,
    ...overrides,
  };
}

describe("TerminalWriteBatchQueue", () => {
  it("splits one ingress backing into zero-copy 64 KiB views", () => {
    const backing = new Uint8Array(TERMINAL_WRITE_ENQUEUE_SLICE_BYTES + 3);
    const slices = terminalWriteFairSlices(backing);

    expect(slices).toHaveLength(2);
    expect(slices[0].byteLength).toBe(TERMINAL_WRITE_ENQUEUE_SLICE_BYTES);
    expect(slices[1].byteLength).toBe(3);
    expect(slices[0].buffer).toBe(backing.buffer);
    expect(slices[1].buffer).toBe(backing.buffer);
    expect(slices[0].byteOffset).toBe(backing.byteOffset);
    expect(slices[1].byteOffset).toBe(backing.byteOffset + TERMINAL_WRITE_ENQUEUE_SLICE_BYTES);
  });

  it("dequeues an idle request immediately in FIFO order and tracks queue metrics", () => {
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    const firstId = queue.enqueue(request([1, 2]));
    const secondId = queue.enqueue(
      request([3], { allowCoalescing: false, metadata: { source: "live", attachEpoch: 7 } }),
    );

    expect(firstId).toBe(1);
    expect(secondId).toBe(2);
    expect(queue.depth).toBe(2);
    expect(queue.bytes).toBe(3);
    expect(queue.lastEnqueuedId).toBe(2);

    const first = queue.dequeue();
    expect(first?.entries.map(({ id }) => id)).toEqual([1]);
    expect(first?.data).toBe(first?.entries[0].data);
    expect(queue.depth).toBe(1);
    expect(queue.bytes).toBe(1);

    const second = queue.dequeue();
    expect(second?.entries.map(({ id }) => id)).toEqual([2]);
    expect(queue.depth).toBe(0);
    expect(queue.bytes).toBe(0);
    expect(queue.dequeue()).toBeUndefined();
  });

  it("materializes compatible live Uint8Array requests once in exact byte order", () => {
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    queue.enqueue(request([1, 2], { metadata: { source: "live", attachEpoch: 7, marker: "a" } }));
    queue.enqueue(
      request([3], {
        metadata: { source: "live", attachEpoch: 7, needsSyncOutputMonitor: true },
      }),
    );
    queue.enqueue(request([4, 5]));

    const batch = queue.dequeue();

    expect(batch).toMatchObject({
      byteLength: 5,
      partCount: 3,
      firstId: 1,
      lastId: 3,
      metadata: { source: "live", attachEpoch: 7, marker: "a" },
    });
    expect(batch?.data).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
    expect(batch?.entries.map(({ id }) => id)).toEqual([1, 2, 3]);
    expect(batch?.entries.map(({ metadata }) => metadata.needsSyncOutputMonitor === true)).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("restores a prepared batch at the head without copying it again", () => {
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    queue.enqueue(request([1, 2]));
    queue.enqueue(request([3, 4]));
    const prepared = queue.dequeue();
    expect(prepared).toBeDefined();
    const materialized = prepared?.data;
    expect(prepared?.warned).toBe(false);
    prepared!.warned = true;

    queue.enqueue(request([5], { allowCoalescing: false }));
    queue.restore(prepared!);

    expect(queue.depth).toBe(3);
    expect(queue.bytes).toBe(5);
    const retry = queue.dequeue();
    expect(retry).toBe(prepared);
    expect(retry?.data).toBe(materialized);
    expect(retry?.warned).toBe(true);
    expect(retry?.entries.map(({ id }) => id)).toEqual([1, 2]);
    expect(queue.dequeue()?.entries.map(({ id }) => id)).toEqual([3]);
  });

  it("rejects a duplicate or foreign restore", () => {
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    const foreignQueue = new TerminalWriteBatchQueue<TestMetadata>();
    queue.enqueue(request([1]));
    foreignQueue.enqueue(request([9]));
    const batch = queue.dequeue()!;
    const foreign = foreignQueue.dequeue()!;

    queue.restore(batch);
    expect(() => queue.restore(batch)).toThrow(/already queued/i);
    expect(() => queue.restore(foreign)).toThrow(/this queue/i);
  });

  it.each([
    ["onParsed callback", { onParsed: () => undefined }],
    ["onDiscard callback", { onDiscard: () => undefined }],
    ["coalescing opt-out", { allowCoalescing: false }],
    [
      "stabilized frame",
      { metadata: { source: "live" as const, attachEpoch: 7, stabilized: true } },
    ],
    ["park deadline", { metadata: { source: "live" as const, attachEpoch: 7, parkDeadline: 50 } }],
    [
      "authoritative frame end",
      {
        metadata: {
          source: "live" as const,
          attachEpoch: 7,
          frameEndCursorAuthoritative: true,
        },
      },
    ],
    [
      "active composition",
      { metadata: { source: "live" as const, attachEpoch: 7, compositionActive: true } },
    ],
    ["replay source", { metadata: { source: "replay" as const, attachEpoch: 7 } }],
    ["string data", { data: "x" }],
  ] satisfies Array<[string, Partial<TerminalWriteBatchRequest<TestMetadata>>]>)(
    "keeps $0 as a barrier on both sides",
    (_name, barrier) => {
      const queue = new TerminalWriteBatchQueue<TestMetadata>();
      queue.enqueue(request([1]));
      queue.enqueue(request([2], barrier));
      queue.enqueue(request([3]));

      expect(queue.dequeue()?.entries.map(({ id }) => id)).toEqual([1]);
      expect(queue.dequeue()?.entries.map(({ id }) => id)).toEqual([2]);
      expect(queue.dequeue()?.entries.map(({ id }) => id)).toEqual([3]);
    },
  );

  it("requires the same explicit batch key and matching safety metadata", () => {
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    queue.enqueue(request([1], { metadata: { source: "live", attachEpoch: 7, marker: "first" } }));
    queue.enqueue(request([2], { metadata: { source: "live", attachEpoch: 7, marker: "second" } }));
    queue.enqueue(request([3], { batchKey: "live:7:run-4" }));
    queue.enqueue(
      request([4], {
        batchKey: "live:7:run-4",
        metadata: { source: "live", attachEpoch: 8 },
      }),
    );

    // Incidental metadata is intentionally not shallow-compared; batchKey is
    // the caller's explicit equivalence contract.
    expect(queue.dequeue()?.entries.map(({ id }) => id)).toEqual([1, 2]);
    expect(queue.dequeue()?.entries.map(({ id }) => id)).toEqual([3]);
    expect(queue.dequeue()?.entries.map(({ id }) => id)).toEqual([4]);
  });

  it("coalesces explicitly compatible callbacks while retaining every entry", () => {
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    const parsed: number[] = [];
    const discarded: number[] = [];
    queue.enqueue(
      request([1], {
        coalesceCallbacks: true,
        onParsed: () => parsed.push(1),
        onDiscard: () => discarded.push(1),
      }),
    );
    queue.enqueue(
      request([2], {
        coalesceCallbacks: true,
        onParsed: () => parsed.push(2),
        onDiscard: () => discarded.push(2),
      }),
    );

    const batch = queue.dequeue();
    expect(batch).toMatchObject({ partCount: 2, data: new Uint8Array([1, 2]) });
    for (const entry of batch?.entries ?? []) entry.onParsed?.();

    expect(parsed).toEqual([1, 2]);
    expect(discarded).toEqual([]);
  });

  it("never materializes more than the fixed part budget", () => {
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    for (let value = 0; value < TERMINAL_WRITE_BATCH_MAX_PARTS + 2; value += 1) {
      queue.enqueue(request([value % 256]));
    }

    const first = queue.dequeue();
    const second = queue.dequeue();
    expect(first?.partCount).toBe(TERMINAL_WRITE_BATCH_MAX_PARTS);
    expect(first?.byteLength).toBe(TERMINAL_WRITE_BATCH_MAX_PARTS);
    expect(second?.partCount).toBe(2);
  });

  it("never materializes compatible requests past the fixed byte budget", () => {
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    const part = new Uint8Array(100 * 1024);
    queue.enqueue(request([], { data: part }));
    queue.enqueue(request([], { data: part }));
    queue.enqueue(request([], { data: part }));

    expect(queue.dequeue()).toMatchObject({ partCount: 2, byteLength: 200 * 1024 });
    expect(queue.dequeue()).toMatchObject({ partCount: 1, byteLength: 100 * 1024 });
    expect(TERMINAL_WRITE_BATCH_MAX_BYTES).toBe(256 * 1024);
  });

  it("coalesces two 64 KiB slices while another owner is waiting", () => {
    const fill = (queue: TerminalWriteBatchQueue<TestMetadata>) => {
      for (let index = 0; index < 4; index += 1) {
        queue.enqueue(request([], { data: new Uint8Array(TERMINAL_WRITE_ENQUEUE_SLICE_BYTES) }));
      }
    };
    const contended = new TerminalWriteBatchQueue<TestMetadata>();
    const idle = new TerminalWriteBatchQueue<TestMetadata>();
    fill(contended);
    fill(idle);

    expect(
      contended.dequeue(contended.lastEnqueuedId, true, TERMINAL_WRITE_FAIR_QUANTUM_BYTES),
    ).toMatchObject({ partCount: 2, byteLength: 128 * 1024 });
    expect(idle.dequeue(idle.lastEnqueuedId, true, TERMINAL_WRITE_BATCH_MAX_BYTES)).toMatchObject({
      partCount: 4,
      byteLength: 256 * 1024,
    });
    expect(TERMINAL_WRITE_ENQUEUE_SLICE_BYTES).toBe(64 * 1024);
    expect(TERMINAL_WRITE_FAIR_QUANTUM_BYTES).toBe(128 * 1024);
  });

  it("keeps a materialized retry intact when contention starts before retry", () => {
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    queue.enqueue(request([], { data: new Uint8Array(TERMINAL_WRITE_ENQUEUE_SLICE_BYTES) }));
    queue.enqueue(request([], { data: new Uint8Array(TERMINAL_WRITE_ENQUEUE_SLICE_BYTES) }));
    const prepared = queue.dequeue(queue.lastEnqueuedId, true, TERMINAL_WRITE_BATCH_MAX_BYTES)!;
    queue.restore(prepared);

    const retry = queue.dequeue(queue.lastEnqueuedId, true, TERMINAL_WRITE_FAIR_QUANTUM_BYTES);
    expect(retry).toBe(prepared);
    expect(retry).toMatchObject({ partCount: 2, byteLength: 128 * 1024 });
  });

  it("keeps replay quanta as separate callback barriers even for a sole owner", () => {
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    const parsed: number[] = [];
    for (let index = 0; index < 2; index += 1) {
      queue.enqueue(
        request([], {
          data: new Uint8Array(TERMINAL_WRITE_ENQUEUE_SLICE_BYTES),
          metadata: { source: "replay", attachEpoch: 7 },
          batchKey: "replay:7",
          allowCoalescing: true,
          coalesceCallbacks: true,
          onParsed: () => parsed.push(index),
        }),
      );
    }

    const first = queue.dequeue(queue.lastEnqueuedId, true, TERMINAL_WRITE_BATCH_MAX_BYTES);
    const second = queue.dequeue(queue.lastEnqueuedId, true, TERMINAL_WRITE_BATCH_MAX_BYTES);
    expect(first).toMatchObject({ partCount: 1, byteLength: 64 * 1024 });
    expect(second).toMatchObject({ partCount: 1, byteLength: 64 * 1024 });
    first?.entries[0].onParsed?.();
    second?.entries[0].onParsed?.();
    expect(parsed).toEqual([0, 1]);
  });

  it("allows one oversized or atomic head request to make progress alone", () => {
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    const oversized = new Uint8Array(TERMINAL_WRITE_BATCH_MAX_BYTES + 1);
    queue.enqueue(request([], { data: oversized }));
    queue.enqueue(request([2]));

    const first = queue.dequeue();
    expect(first).toMatchObject({ partCount: 1, byteLength: oversized.byteLength });
    expect(first?.data).toBe(oversized);
    expect(queue.dequeue()?.entries.map(({ id }) => id)).toEqual([2]);
  });

  it("does not dequeue or merge requests past maxId", () => {
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    queue.enqueue(request([1]));
    const cutoff = queue.enqueue(request([2]));
    queue.enqueue(request([3]));

    const beforeCutoff = queue.dequeue(cutoff);
    expect(beforeCutoff?.entries.map(({ id }) => id)).toEqual([1, 2]);
    expect(beforeCutoff?.lastId).toBeLessThanOrEqual(cutoff);
    expect(queue.dequeue(cutoff)).toBeUndefined();
    expect(queue.depth).toBe(1);
    expect(queue.dequeue()?.entries.map(({ id }) => id)).toEqual([3]);
  });

  it("honors the dequeue-time coalescing gate when composition starts after enqueue", () => {
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    queue.enqueue(request([1]));
    queue.enqueue(request([2]));

    const cutoff = queue.lastEnqueuedId;
    expect(queue.dequeue(cutoff, false)?.entries.map(({ id }) => id)).toEqual([1]);
    expect(queue.dequeue(cutoff, false)?.entries.map(({ id }) => id)).toEqual([2]);
  });

  it("does not return a restored prepared batch past a smaller cutoff", () => {
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    queue.enqueue(request([1]));
    queue.enqueue(request([2]));
    const prepared = queue.dequeue()!;
    queue.restore(prepared);

    expect(queue.dequeue(prepared.lastId - 1)).toBeUndefined();
    expect(queue.depth).toBe(2);
    expect(queue.dequeue(prepared.lastId)).toBe(prepared);
  });

  it("holds a restored multi-part retry while dequeue-time coalescing is disabled", () => {
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    queue.enqueue(request([1]));
    queue.enqueue(request([2]));
    const prepared = queue.dequeue()!;
    queue.restore(prepared);

    expect(queue.dequeue(queue.lastEnqueuedId, false)).toBeUndefined();
    expect(queue.depth).toBe(2);
    expect(queue.dequeue(queue.lastEnqueuedId, true)).toBe(prepared);
  });

  it("accounts string queue bytes as UTF-8 and never merges strings", () => {
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    queue.enqueue(request([], { data: "가" }));
    queue.enqueue(request([], { data: "나" }));

    expect(queue.bytes).toBe(6);
    expect(queue.dequeue()).toMatchObject({ byteLength: 3, partCount: 1 });
    expect(queue.dequeue()).toMatchObject({ byteLength: 3, partCount: 1 });
  });

  it("clears restored and queued entries in FIFO order and discards each exactly once", () => {
    const discarded: string[] = [];
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    queue.enqueue(request([1], { onDiscard: () => discarded.push("first") }));
    queue.enqueue(request([2], { onDiscard: () => discarded.push("second") }));
    const restored = queue.dequeue()!;
    queue.restore(restored);
    queue.enqueue(request([3], { onDiscard: () => discarded.push("third") }));

    queue.clear();
    queue.clear();

    expect(discarded).toEqual(["first", "second", "third"]);
    expect(queue.depth).toBe(0);
    expect(queue.bytes).toBe(0);
    expect(queue.dequeue()).toBeUndefined();
    expect(() => queue.restore(restored)).toThrow(/discarded/i);
    expect(queue.enqueue(request([4]))).toBe(4);
  });

  it("can clear silently and leaves an already dequeued in-flight batch to the caller", () => {
    const discarded: string[] = [];
    const queue = new TerminalWriteBatchQueue<TestMetadata>();
    queue.enqueue(request([1], { onDiscard: () => discarded.push("in-flight") }));
    queue.enqueue(request([2], { onDiscard: () => discarded.push("queued") }));
    const inFlight = queue.dequeue()!;

    queue.clear(false);
    expect(discarded).toEqual([]);
    expect(queue.depth).toBe(0);

    queue.restore(inFlight);
    expect(queue.dequeue()).toBe(inFlight);
  });
});
