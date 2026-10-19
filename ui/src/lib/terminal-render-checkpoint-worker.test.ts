import { describe, expect, it, vi } from "vitest";
import {
  TerminalRenderCheckpointWorker,
  type CheckpointWorkerPort,
  type CheckpointWorkerRequest,
  type CheckpointWorkerResponse,
} from "./terminal-render-checkpoint-worker";
import type { TerminalOutputAttachment } from "./terminal-output-attach-coordinator";
import type { TerminalRenderCheckpoint } from "./terminal-render-checkpoint";

class Port implements CheckpointWorkerPort {
  onmessage: CheckpointWorkerPort["onmessage"] = null;
  onerror: CheckpointWorkerPort["onerror"] = null;
  onmessageerror: CheckpointWorkerPort["onmessageerror"] = null;
  messages: CheckpointWorkerRequest[] = [];
  transfers: Transferable[][] = [];
  terminated = false;
  postMessage(message: CheckpointWorkerRequest, transfer: Transferable[]) {
    this.messages.push(message);
    this.transfers.push(transfer);
  }
  terminate() {
    this.terminated = true;
  }
  reply(id: number, result?: TerminalRenderCheckpoint) {
    this.onmessage?.({ data: { id, ok: true, result } } as MessageEvent<CheckpointWorkerResponse>);
  }
}
const geometry = { revision: 1, cols: 80, rows: 24 };
const attachment = {
  state: { generation: 1, snapshotStartSeq: 0, snapshotSeq: 0, geometry },
  snapshot: new Uint8Array(),
} as TerminalOutputAttachment;
async function attach(model: TerminalRenderCheckpointWorker, port: Port) {
  const result = model.attach(attachment);
  await vi.waitFor(() => expect(port.messages).toHaveLength(1));
  port.reply(port.messages[0].id);
  await vi.waitFor(() => expect(port.messages).toHaveLength(2));
  port.reply(port.messages[1].id);
  await result;
}
describe("checkpoint Worker admission and ownership", () => {
  it("includes admission queue time in the capture deadline", async () => {
    const port = new Port();
    const admission = { request: vi.fn(), cancel: vi.fn() };
    const model = new TerminalRenderCheckpointWorker({ admission, createWorker: () => port });
    await attach(model, port);
    const applying = model.apply({
      generation: 1,
      seqStart: 0,
      seqEnd: 1,
      data: new Uint8Array([65]),
      geometry,
    });
    await vi.waitFor(() => expect(admission.request).toHaveBeenCalled());
    vi.useFakeTimers();
    try {
      const capturing = model.capture({ generation: 1, seq: 1, geometry }, 1024);
      const rejected = expect(capturing).rejects.toThrow("did not reach seq");
      await vi.advanceTimersByTimeAsync(3_000);
      await rejected;
      expect(port.messages).toHaveLength(2);
      model.dispose();
      await expect(applying).rejects.toThrow("disposed");
    } finally {
      model.dispose();
      vi.useRealTimers();
    }
  });
  it("allows later writes while capture waits for a future source target", async () => {
    const port = new Port();
    const model = new TerminalRenderCheckpointWorker({ createWorker: () => port });
    await attach(model, port);
    const capturing = model.capture({ generation: 1, seq: 1, geometry }, 1024);
    await vi.waitFor(() => expect(port.messages).toHaveLength(3));
    const applying = model.apply({
      generation: 1,
      seqStart: 0,
      seqEnd: 1,
      data: new Uint8Array([65]),
      geometry,
    });
    await vi.waitFor(() => expect(port.messages).toHaveLength(4));
    port.reply(port.messages[3].id);
    await applying;
    const checkpoint = { generation: 1, seq: 1, geometry, data: "A" };
    port.reply(port.messages[2].id, checkpoint);
    await expect(capturing).resolves.toEqual(checkpoint);
    model.dispose();
  });
  it("terminates a worker that never acknowledges an accepted request", async () => {
    const port = new Port();
    const model = new TerminalRenderCheckpointWorker({ createWorker: () => port, timeoutMs: 20 });
    await expect(model.attach(attachment)).rejects.toThrow("timed out");
    expect(port.terminated).toBe(true);
  });
  it("transfers a private slice and releases admission only after the Worker ACK", async () => {
    const port = new Port();
    let grant: ((release: () => void, turn: { maxBytes: number }) => void) | undefined;
    const admission = {
      request: vi.fn((_lane, callback) => {
        grant = callback;
      }),
      cancel: vi.fn(),
    };
    const model = new TerminalRenderCheckpointWorker({ admission, createWorker: () => port });
    await attach(model, port);
    const source = new Uint8Array([65, 66, 67]);
    const applying = model.apply({ generation: 1, seqStart: 0, seqEnd: 3, data: source, geometry });
    await vi.waitFor(() => expect(admission.request).toHaveBeenCalledTimes(1));
    expect(port.messages).toHaveLength(2);
    const release = vi.fn();
    grant?.(release, { maxBytes: 64 * 1024 });
    const message = port.messages[2];
    expect(message.op).toBe("apply");
    if (message.op !== "apply") throw new Error("expected apply");
    expect(message.segment.data.buffer).not.toBe(source.buffer);
    expect(port.transfers[2]).toEqual([message.segment.data.buffer]);
    expect(source).toEqual(new Uint8Array([65, 66, 67]));
    expect(release).not.toHaveBeenCalled();
    port.reply(message.id);
    await applying;
    expect(release).toHaveBeenCalledTimes(1);
    model.dispose();
  });
  it("rejects an accepted write on disposal and ignores its late ACK", async () => {
    const port = new Port();
    const model = new TerminalRenderCheckpointWorker({ createWorker: () => port });
    await attach(model, port);
    const applying = model.apply({
      generation: 1,
      seqStart: 0,
      seqEnd: 1,
      data: new Uint8Array([65]),
      geometry,
    });
    await vi.waitFor(() => expect(port.messages).toHaveLength(3));
    model.dispose();
    await expect(applying).rejects.toThrow("disposed");
    port.reply(port.messages[2].id);
    expect(port.terminated).toBe(true);
  });
  it("a Worker communication failure rejects pending work", async () => {
    const port = new Port();
    const model = new TerminalRenderCheckpointWorker({ createWorker: () => port });
    const attaching = model.attach(attachment);
    await vi.waitFor(() => expect(port.messages).toHaveLength(1));
    port.onerror?.(new ErrorEvent("error", { message: "crash" }));
    await expect(attaching).rejects.toThrow("crash");
    expect(port.terminated).toBe(true);
  });
});
