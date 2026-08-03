import { SerializeAddon } from "@xterm/addon-serialize";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createScreenTerminal, diffScreens, type ScreenTerminal } from "@/test/screen/xterm-screen";
import { TerminalOutputControlOperationRegistry } from "./terminal-output-control-registry";
import { TerminalOutputV3Runtime } from "./terminal-output-v3-runtime";

vi.mock("./tauri-api", () => ({
  acknowledgeTerminalOutputEnvelope: vi.fn(() => Promise.resolve(true)),
  closeTerminalOutputContinuation: vi.fn(() => Promise.resolve(true)),
  holdTerminalOutputContinuation: vi.fn(() => Promise.resolve(true)),
}));

const encoder = new TextEncoder();
const terminals: ScreenTerminal[] = [];

function envelope(envelopeId: number, seqStart: number, text: string) {
  const data = encoder.encode(text);
  return {
    version: 3,
    generation: 1,
    leaseToken: "screen-lease",
    envelopeId,
    grantId: null,
    seqStart,
    seqEnd: seqStart + data.byteLength,
    data,
    deltaEnds: [data.byteLength],
    geometryRuns: [{ deltaIndex: 0, geometry: { revision: 1, cols: 80, rows: 12 } }],
  };
}

function screen(): { surface: ScreenTerminal; serialize: SerializeAddon } {
  const surface = createScreenTerminal({ cols: 80, rows: 12, scrollback: 32 });
  const serialize = new SerializeAddon();
  surface.terminal.loadAddon(serialize);
  terminals.push(surface);
  return { surface, serialize };
}

afterEach(() => {
  while (terminals.length > 0) terminals.pop()?.dispose();
});

describe("v3 exact envelope repair on a real xterm", () => {
  it("is lossless after one dropped event and the duplicate-sabotage control detects reapply", async () => {
    const firstText = "\x1b[2J\x1b[Halpha\r\n";
    const repairedText = "repair-once\r\n";
    const successorText = "tail";
    const first = envelope(1, 0, firstText);
    const repaired = envelope(2, first.seqEnd, repairedText);
    const successor = envelope(3, repaired.seqEnd, successorText);

    const baseline = screen();
    await baseline.surface.write(encoder.encode(firstText + repairedText + successorText));

    const visible = screen();
    const checkpoint = screen();
    const writes: Promise<void>[] = [];
    const registry = new TerminalOutputControlOperationRegistry();
    const runtime = new TerminalOutputV3Runtime({
      terminalId: "screen-terminal",
      generation: 1,
      leaseToken: "screen-lease",
      attachEpoch: 1,
      initialSeq: 0,
      initialEnvelopeId: 1,
      controlTimeoutMs: 100,
      repairTimeoutMs: 100,
      scope: registry.mount("screen-terminal"),
      isCurrent: () => true,
      getLifecycleFacts: () => ({
        parsersReady: true,
        disposed: false,
        failStoppedReason: null,
        stabilizerHolding: false,
        capacityWaiting: false,
      }),
      applyCheckpoint(delta) {
        const write = checkpoint.surface.write(delta.data);
        writes.push(write);
        return write;
      },
      enqueueVisible(delta, onParsed, onDiscard) {
        const write = visible.surface
          .write(delta.data)
          .then(onParsed, (error) =>
            onDiscard(error instanceof Error ? error.message : "screen write failed"),
          );
        writes.push(write);
      },
      sendParsedRange: () => Promise.resolve(true),
      repairEnvelope: () => Promise.resolve({ status: "exact", envelope: repaired }),
      onRepairEventPending: () => undefined,
      onFailStop: (reason) => {
        throw new Error(reason);
      },
    });

    await runtime.receive(first, 1);
    // The event for envelope 2 is intentionally omitted. Envelope 3 forces an
    // exact immutable pull before it may enter either xterm parser.
    await runtime.receive(successor, 2);
    await Promise.all(writes);

    expect(diffScreens(baseline.surface.capture(), visible.surface.capture())).toBeNull();
    expect(diffScreens(baseline.surface.capture(), checkpoint.surface.capture())).toBeNull();
    expect(visible.serialize.serialize({ scrollback: 32 })).toBe(
      baseline.serialize.serialize({ scrollback: 32 }),
    );
    expect(checkpoint.serialize.serialize({ scrollback: 32 })).toBe(
      baseline.serialize.serialize({ scrollback: 32 }),
    );
    expect(runtime.diagnostics()).toMatchObject({
      admittedSeq: successor.seqEnd,
      parsedSeq: successor.seqEnd,
      repairCount: 1,
      lastRepairReason: "event-gap:exact",
    });

    const sabotage = screen();
    await sabotage.surface.write(
      encoder.encode(firstText + repairedText + repairedText + successorText),
    );
    expect(diffScreens(baseline.surface.capture(), sabotage.surface.capture())).not.toBeNull();
    expect(sabotage.serialize.serialize({ scrollback: 32 })).not.toBe(
      baseline.serialize.serialize({ scrollback: 32 }),
    );

    runtime.dispose();
  });
});
