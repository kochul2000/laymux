import type { TerminalOutputEnvelopePayload } from "./terminal-output-envelope";

export interface TerminalOutputBinaryNotice {
  transport: "binary";
  version: number;
  generation: number;
  leaseToken: string;
  envelopeId: number;
  grantId: string | null;
  seqStart: number;
  seqEnd: number;
}

const MAX_PACKET_BYTES = 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Metadata is decoded once; raw data remains a view of the IPC buffer. */
export function decodeTerminalOutputBinary(packet: ArrayBuffer): TerminalOutputEnvelopePayload {
  if (
    !(packet instanceof ArrayBuffer) ||
    packet.byteLength < 5 ||
    packet.byteLength >= MAX_PACKET_BYTES
  ) {
    throw new Error("invalid terminal output binary packet size");
  }
  const headerBytes = new DataView(packet).getUint32(0, true);
  if (headerBytes === 0 || 4 + headerBytes >= packet.byteLength) {
    throw new Error("invalid terminal output binary metadata boundary");
  }
  const metadata: unknown = JSON.parse(decoder.decode(new Uint8Array(packet, 4, headerBytes)));
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("invalid terminal output binary metadata");
  }
  // The existing v3 normalizer validates identity, geometry and ranges.
  return {
    ...metadata,
    data: new Uint8Array(packet, 4 + headerBytes),
  } as TerminalOutputEnvelopePayload;
}

function isNotice(value: unknown): value is TerminalOutputBinaryNotice {
  return (
    !!value && typeof value === "object" && "transport" in value && value.transport === "binary"
  );
}

/** Notifications are hints; immutable bytes remain in the bounded Rust slot. */
export class TerminalOutputBinaryReceiver {
  private pending: TerminalOutputBinaryNotice | undefined;
  private reading = false;
  private disposed = false;

  constructor(
    private readonly pull: (notice: TerminalOutputBinaryNotice) => Promise<ArrayBuffer>,
    private readonly receive: (envelope: TerminalOutputEnvelopePayload) => void,
    private readonly invalid: (error: Error) => void,
  ) {}

  accept(payload: TerminalOutputEnvelopePayload | TerminalOutputBinaryNotice): void {
    if (this.disposed) return;
    if (!isNotice(payload)) {
      this.receive(payload);
      return;
    }
    this.pending = payload;
    if (!this.reading) void this.drain();
  }

  dispose(): void {
    this.disposed = true;
    this.pending = undefined;
  }

  private async drain(): Promise<void> {
    this.reading = true;
    try {
      while (this.pending && !this.disposed) {
        const notice = this.pending;
        this.pending = undefined;
        let packet: ArrayBuffer;
        try {
          packet = await this.pull(notice);
        } catch {
          // The exact watchdog repairs notification/read loss. Do not start
          // timeout retries beside an uncancellable physical read.
          continue;
        }
        if (this.disposed) return;
        if (packet.byteLength === 0) continue; // receipt/retirement won the race
        try {
          this.receive(decodeTerminalOutputBinary(packet));
        } catch (error) {
          this.invalid(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.reading = false;
    }
  }
}
