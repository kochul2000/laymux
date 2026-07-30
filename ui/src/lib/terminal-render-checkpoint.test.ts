import { describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { activateTerminalUnicodeProvider } from "./terminal-unicode-width";
import { TerminalRenderCheckpointModel } from "./terminal-render-checkpoint";
import {
  createTerminalWriteFairOwner,
  TerminalWriteFairScheduler,
} from "./terminal-write-fair-scheduler";
import { TerminalParserAdmission } from "./terminal-parser-admission";
import {
  TERMINAL_WRITE_BATCH_MAX_BYTES,
  TERMINAL_WRITE_FAIR_QUANTUM_BYTES,
} from "./terminal-write-batch-queue";
import type {
  TerminalOutputAttachment,
  TerminalOutputAppliedSegment,
} from "./terminal-output-attach-coordinator";

const encoder = new TextEncoder();

function write(term: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function attachment(data: string, cols = 24, rows = 6): TerminalOutputAttachment {
  const snapshot = encoder.encode(data);
  return {
    state: {
      version: 1,
      generation: 11,
      snapshotStartSeq: 0,
      snapshotSeq: snapshot.length,
      sourceStartSeq: 0,
      sourceSeq: snapshot.length,
      snapshotKind: "raw",
      protocolRevision: 0,
      modes: { bracketedPaste: false },
      geometry: { revision: 1, cols, rows },
    },
    snapshot,
  };
}

function segment(
  seqStart: number,
  data: string,
  geometry = { revision: 1, cols: 24, rows: 6 },
): TerminalOutputAppliedSegment {
  const encoded = encoder.encode(data);
  return {
    generation: 11,
    seqStart,
    seqEnd: seqStart + encoded.length,
    data: encoded,
    geometry,
  };
}

function visibleLines(term: Terminal): string[] {
  return Array.from(
    { length: term.rows },
    (_, row) => term.buffer.active.getLine(row)?.translateToString(true) ?? "",
  );
}

describe("TerminalRenderCheckpointModel", () => {
  it("shares the app-wide parser admission slot with visible xterm work", async () => {
    const scheduled: Array<() => void> = [];
    const scheduler = new TerminalWriteFairScheduler((task) => scheduled.push(task));
    const checkpointOwner = createTerminalWriteFairOwner("checkpoint");
    const blockerOwner = createTerminalWriteFairOwner("visible-blocker");
    const admission = new TerminalParserAdmission(
      scheduler,
      checkpointOwner,
      () => "background",
      (task) => {
        scheduled.push(task);
        return () => {
          const index = scheduled.indexOf(task);
          if (index >= 0) scheduled.splice(index, 1);
        };
      },
    );
    const model = new TerminalRenderCheckpointModel({
      admission,
    });
    const attached = attachment("ready", 10, 3);
    await model.attach(attached);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();

    let releaseBlocker: (() => void) | undefined;
    scheduler.request(blockerOwner, (release) => {
      releaseBlocker = release;
    });
    const next = segment(attached.state.snapshotSeq, "-checkpoint", {
      revision: 1,
      cols: 10,
      rows: 3,
    });
    let settled = false;
    const applying = model.apply(next).then(() => {
      settled = true;
    });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(scheduled).toHaveLength(0);
    releaseBlocker?.();
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();
    await applying;

    expect(settled).toBe(true);
    model.dispose();
  });

  it("rejects an active scheduled write on dispose even if xterm never calls back", async () => {
    const scheduled: Array<() => void> = [];
    const scheduler = new TerminalWriteFairScheduler((task) => scheduled.push(task));
    const admission = new TerminalParserAdmission(
      scheduler,
      createTerminalWriteFairOwner("checkpoint"),
      () => "background",
      (task) => {
        scheduled.push(task);
        return () => {
          const index = scheduled.indexOf(task);
          if (index >= 0) scheduled.splice(index, 1);
        };
      },
    );
    let writeCount = 0;
    let settleActiveWrite: (() => void) | undefined;
    const model = new TerminalRenderCheckpointModel({
      admission,
      write: () => {
        writeCount += 1;
        if (writeCount === 1) return Promise.resolve();
        return new Promise<void>((resolve) => {
          settleActiveWrite = resolve;
        });
      },
    });
    const attached = attachment("ready", 10, 3);
    await model.attach(attached);
    expect(scheduled).toHaveLength(1);
    scheduled.shift()?.();

    const applying = model.apply(
      segment(attached.state.snapshotSeq, "-checkpoint", {
        revision: 1,
        cols: 10,
        rows: 3,
      }),
    );
    await Promise.resolve();
    model.dispose();

    await expect(applying).rejects.toThrow("terminal render checkpoint is disposed");
    const replacement = vi.fn((release: () => void) => release());
    scheduler.request(createTerminalWriteFairOwner("replacement"), replacement);
    expect(replacement).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(0);
    // A disposed xterm may still settle its already accepted callback. That
    // stale release is idempotent and cannot disturb the replacement turn.
    settleActiveWrite?.();
    await Promise.resolve();
    expect(scheduler.isIdleForTests()).toBe(true);
  });

  it.each([
    { contended: false, expected: [256 * 1024, 44 * 1024] },
    { contended: true, expected: [64 * 1024, 64 * 1024, 64 * 1024, 64 * 1024, 44 * 1024] },
  ])(
    "bounds checkpoint parser slices when contended=$contended",
    async ({ contended, expected }) => {
      const writes: number[] = [];
      const admission = {
        request: (
          _lane: Parameters<TerminalParserAdmission["request"]>[0],
          turn: Parameters<TerminalParserAdmission["request"]>[1],
        ) =>
          turn(() => {}, {
            contended,
            maxBytes: contended
              ? TERMINAL_WRITE_FAIR_QUANTUM_BYTES
              : TERMINAL_WRITE_BATCH_MAX_BYTES,
          }),
        cancel: () => {},
      };
      const model = new TerminalRenderCheckpointModel({
        admission,
        write: (data) => {
          writes.push(data.length);
          return Promise.resolve();
        },
      });
      const attached = attachment("ready", 10, 3);
      await model.attach(attached);
      writes.length = 0;
      const data = new Uint8Array(300 * 1024);
      const next: TerminalOutputAppliedSegment = {
        generation: 11,
        seqStart: attached.state.snapshotSeq,
        seqEnd: attached.state.snapshotSeq + data.length,
        data,
        geometry: { revision: 1, cols: 10, rows: 3 },
      };

      await model.apply(next);

      expect(writes).toEqual(expected);
      const checkpoint = await model.capture(
        { generation: 11, seq: next.seqEnd, geometry: next.geometry },
        4_096,
      );
      expect(checkpoint.seq).toBe(next.seqEnd);
      model.dispose();
    },
  );

  it("reconstructs a sparse TUI after far more output than the checkpoint budget", async () => {
    const initial = "\x1b[2J\x1b[HBASE-01\r\nBASE-02\r\nBASE-03\r\nBASE-04\r\nBASE-05\r\nBASE-06";
    const model = new TerminalRenderCheckpointModel();
    const attached = attachment(initial);
    await model.attach(attached);

    const patches = Array.from(
      { length: 1_200 },
      (_, index) => `\x1b[6;1HTICK-${String(index).padStart(4, "0")}`,
    ).join("");
    const next = segment(attached.state.snapshotSeq, patches);
    await model.apply(next);
    const seq = next.seqEnd;

    const checkpoint = await model.capture(
      {
        generation: 11,
        seq,
        geometry: { revision: 1, cols: 24, rows: 6 },
      },
      256,
    );

    expect(seq).toBeGreaterThan(16_000);
    expect(encoder.encode(checkpoint.data).length).toBeLessThan(seq);

    const restored = new Terminal({ cols: 24, rows: 6, allowProposedApi: true });
    activateTerminalUnicodeProvider(restored);
    await write(restored, checkpoint.data);
    expect(visibleLines(restored)).toEqual([
      "BASE-01",
      "BASE-02",
      "BASE-03",
      "BASE-04",
      "BASE-05",
      "TICK-1199",
    ]);
    restored.dispose();
    model.dispose();
  });

  it("serializes the normal buffer beneath an active alternate buffer", async () => {
    const initial = "NORMAL-SHELL\x1b[?1049h\x1b[2J\x1b[HALT-SCREEN";
    const model = new TerminalRenderCheckpointModel();
    const attached = attachment(initial, 20, 4);
    await model.attach(attached);

    const checkpoint = await model.capture(
      {
        generation: 11,
        seq: attached.state.snapshotSeq,
        geometry: { revision: 1, cols: 20, rows: 4 },
      },
      4_096,
    );

    const restored = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    activateTerminalUnicodeProvider(restored);
    await write(restored, checkpoint.data);
    expect(restored.buffer.active.type).toBe("alternate");
    expect(visibleLines(restored)[0]).toBe("ALT-SCREEN");

    await write(restored, "\x1b[?1049l");
    expect(restored.buffer.active.type).toBe("normal");
    expect(visibleLines(restored)[0]).toBe("NORMAL-SHELL");
    restored.dispose();
    model.dispose();
  });

  it("resizes at the sequenced geometry boundary before parsing a delta", async () => {
    const model = new TerminalRenderCheckpointModel();
    const attached = attachment("1234567890", 10, 3);
    await model.attach(attached);
    const next = segment(attached.state.snapshotSeq, "\x1b[2;1HSECOND", {
      revision: 2,
      cols: 8,
      rows: 4,
    });
    await model.apply(next);

    const checkpoint = await model.capture(
      { generation: 11, seq: next.seqEnd, geometry: next.geometry },
      4_096,
    );

    expect(checkpoint.geometry).toEqual(next.geometry);
    expect(checkpoint.seq).toBe(next.seqEnd);
    model.dispose();
  });

  it("adopts a geometry-only boundary when no output follows the resize", async () => {
    const model = new TerminalRenderCheckpointModel();
    const attached = attachment("prompt", 10, 3);
    await model.attach(attached);
    const geometry = { revision: 2, cols: 18, rows: 5 };

    const checkpoint = await model.capture(
      { generation: 11, seq: attached.state.snapshotSeq, geometry },
      4_096,
    );

    expect(checkpoint.geometry).toEqual(geometry);
    model.dispose();
  });

  it("waits for the initial raw attach after its provider is registered", async () => {
    const model = new TerminalRenderCheckpointModel();
    const attached = attachment("ready", 10, 3);
    const capture = model.capture(
      {
        generation: 11,
        seq: attached.state.snapshotSeq,
        geometry: attached.state.geometry,
      },
      4_096,
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    await model.attach(attached);

    await expect(capture).resolves.toMatchObject({
      generation: 11,
      seq: attached.state.snapshotSeq,
    });
    model.dispose();
  });

  it("refuses a generation whose initial raw snapshot was already truncated", async () => {
    const model = new TerminalRenderCheckpointModel();
    const truncated = attachment("tail");
    truncated.state.snapshotStartSeq = 100;
    truncated.state.snapshotSeq = 104;
    truncated.state.sourceStartSeq = 100;
    truncated.state.sourceSeq = 104;
    await model.attach(truncated);

    await expect(
      model.capture({ generation: 11, seq: 104, geometry: truncated.state.geometry }, 4_096),
    ).rejects.toThrow("not reconstructable");
    model.dispose();
  });
});
