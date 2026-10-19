import { describe, expect, it, vi } from "vitest";
import {
  decodeTerminalOutputBinary,
  TerminalOutputBinaryReceiver,
  type TerminalOutputBinaryNotice,
} from "./terminal-output-binary";

const notice: TerminalOutputBinaryNotice = {
  transport: "binary",
  version: 3,
  generation: 1,
  leaseToken: "lease",
  envelopeId: 2,
  grantId: null,
  seqStart: 10,
  seqEnd: 13,
};
function frame(): ArrayBuffer {
  const header = new TextEncoder().encode(
    JSON.stringify({
      version: 3,
      generation: 1,
      leaseToken: "한글",
      envelopeId: 2,
      grantId: null,
      seqStart: 10,
      seqEnd: 13,
      deltaEnds: [3],
      geometryRuns: [{ deltaIndex: 0, geometry: { revision: 1, cols: 80, rows: 24 } }],
    }),
  );
  const result = new Uint8Array(4 + header.length + 3);
  new DataView(result.buffer).setUint32(0, header.length, true);
  result.set(header, 4);
  result.set([0, 128, 255], 4 + header.length);
  return result.buffer;
}

describe("terminal output binary delivery", () => {
  it("decodes UTF-8 metadata and views all byte values without copying", () => {
    const packet = frame();
    const decoded = decodeTerminalOutputBinary(packet);
    expect(decoded.leaseToken).toBe("한글");
    expect(decoded.data).toEqual(new Uint8Array([0, 128, 255]));
    expect((decoded.data as Uint8Array).buffer).toBe(packet);
  });
  it("rejects a truncated or out-of-bounds binary header", () => {
    expect(() => decodeTerminalOutputBinary(new ArrayBuffer(3))).toThrow();
    const packet = frame();
    new DataView(packet).setUint32(0, packet.byteLength, true);
    expect(() => decodeTerminalOutputBinary(packet)).toThrow();
  });
  it("keeps one binary pull in flight and only the newest notification hint", async () => {
    let complete!: (data: ArrayBuffer) => void;
    const pull = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ArrayBuffer>((r) => {
            complete = r;
          }),
      )
      .mockResolvedValue(new ArrayBuffer(0));
    const receive = vi.fn();
    const invalid = vi.fn();
    const receiver = new TerminalOutputBinaryReceiver(pull, receive, invalid);
    receiver.accept(notice);
    receiver.accept({ ...notice, envelopeId: 3 });
    receiver.accept({ ...notice, envelopeId: 4 });
    expect(pull).toHaveBeenCalledTimes(1);
    complete(frame());
    await vi.waitFor(() => expect(pull).toHaveBeenCalledTimes(2));
    expect(pull.mock.calls[1][0].envelopeId).toBe(4);
    expect(receive).toHaveBeenCalledTimes(1);
    expect(invalid).not.toHaveBeenCalled();
  });
  it("ignores a late completion after disposal", async () => {
    let complete!: (data: ArrayBuffer) => void;
    const receive = vi.fn();
    const receiver = new TerminalOutputBinaryReceiver(
      () =>
        new Promise<ArrayBuffer>((r) => {
          complete = r;
        }),
      receive,
      vi.fn(),
    );
    receiver.accept(notice);
    receiver.dispose();
    complete(frame());
    await Promise.resolve();
    expect(receive).not.toHaveBeenCalled();
  });
});
