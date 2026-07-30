import { SerializeAddon } from "@xterm/addon-serialize";
import { Terminal } from "@xterm/xterm";
import { activateTerminalUnicodeProvider } from "./terminal-unicode-width";
import type {
  TerminalGeometry,
  TerminalOutputAppliedSegment,
  TerminalOutputAttachment,
} from "./terminal-output-attach-coordinator";
import type { TerminalParserAdmission } from "./terminal-parser-admission";
import {
  TERMINAL_WRITE_BATCH_MAX_BYTES,
  TERMINAL_WRITE_FAIR_QUANTUM_BYTES,
} from "./terminal-write-batch-queue";

const CAPTURE_WAIT_MS = 3_000;
const CAPTURE_POLL_MS = 10;
const CHECKPOINT_ABSOLUTE_MAX_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

export interface TerminalRenderCheckpointTarget {
  generation: number;
  seq: number;
  geometry: TerminalGeometry;
}

export interface TerminalRenderCheckpoint {
  generation: number;
  seq: number;
  geometry: TerminalGeometry;
  data: string;
}

export interface TerminalRenderCheckpointModelOptions {
  admission?: Pick<TerminalParserAdmission, "request" | "cancel">;
  write?: (data: Uint8Array) => Promise<void>;
}

function writeTerminal(term: Terminal, data: string | Uint8Array): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function sameGeometry(left: TerminalGeometry, right: TerminalGeometry): boolean {
  return left.revision === right.revision && left.cols === right.cols && left.rows === right.rows;
}

/**
 * Rendererless xterm mirror used only to create reconstructable Remote attach
 * checkpoints. It consumes the same sequenced PTY bytes as the visible xterm,
 * but always uses the backend-owned PTY geometry.
 */
export class TerminalRenderCheckpointModel {
  private readonly terminal: Terminal;
  private readonly serializeAddon: SerializeAddon;
  private writeChain = Promise.resolve();
  private generation: number | null = null;
  private seq = 0;
  private geometry: TerminalGeometry | null = null;
  private reconstructable = false;
  private disposed = false;
  private readonly admission: Pick<TerminalParserAdmission, "request" | "cancel"> | undefined;
  private readonly write: (data: Uint8Array) => Promise<void>;
  private rejectScheduledWrite: ((error: Error) => void) | undefined;

  constructor(options: TerminalRenderCheckpointModelOptions = {}) {
    this.admission = options.admission;
    this.terminal = new Terminal({
      allowProposedApi: true,
      cols: 80,
      rows: 24,
      scrollback: 10_000,
      windowsPty: { backend: "conpty", buildNumber: 21376 },
    });
    activateTerminalUnicodeProvider(this.terminal);
    this.serializeAddon = new SerializeAddon();
    this.terminal.loadAddon(this.serializeAddon);
    this.write = options.write ?? ((data) => writeTerminal(this.terminal, data));
  }

  attach(attachment: TerminalOutputAttachment): Promise<void> {
    return this.enqueue(async () => {
      this.terminal.reset();
      this.resize(attachment.state.geometry);
      if (attachment.snapshot.length > 0) {
        await this.writeData(attachment.snapshot);
      }
      this.generation = attachment.state.generation;
      this.seq = attachment.state.snapshotSeq;
      this.geometry = { ...attachment.state.geometry };
      this.reconstructable = attachment.state.snapshotStartSeq === 0;
    });
  }

  apply(segment: TerminalOutputAppliedSegment): Promise<void> {
    return this.enqueue(async () => {
      if (this.generation !== segment.generation) {
        throw new Error("terminal render checkpoint generation changed");
      }
      if (segment.seqStart !== this.seq) {
        throw new Error(
          `terminal render checkpoint sequence gap: expected ${this.seq}, got ${segment.seqStart}`,
        );
      }
      const currentGeometry = this.geometry;
      if (!currentGeometry || segment.geometry.revision < currentGeometry.revision) {
        throw new Error("terminal render checkpoint geometry moved backwards");
      }
      if (
        segment.geometry.revision === currentGeometry.revision &&
        !sameGeometry(segment.geometry, currentGeometry)
      ) {
        throw new Error("terminal render checkpoint geometry revision is inconsistent");
      }
      if (!sameGeometry(segment.geometry, currentGeometry)) this.resize(segment.geometry);
      if (segment.data.length > 0) await this.writeData(segment.data);
      this.seq = segment.seqEnd;
      this.geometry = { ...segment.geometry };
    });
  }

  async capture(
    target: TerminalRenderCheckpointTarget,
    maxBytes: number,
  ): Promise<TerminalRenderCheckpoint> {
    const deadline = Date.now() + CAPTURE_WAIT_MS;
    while (true) {
      const pendingWrites = this.writeChain;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(
          `terminal render checkpoint did not reach seq ${target.seq} (at ${this.seq})`,
        );
      }
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          pendingWrites,
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () =>
                reject(
                  new Error(
                    `terminal render checkpoint did not reach seq ${target.seq} (at ${this.seq})`,
                  ),
                ),
              remaining,
            );
          }),
        ]);
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
      if (this.disposed) throw new Error("terminal render checkpoint is disposed");
      if (this.generation === null || !this.geometry) {
        await new Promise((resolve) => setTimeout(resolve, CAPTURE_POLL_MS));
        continue;
      }
      this.assertUsable(target);
      if (this.seq >= target.seq) {
        // A resize can be the latest sequenced boundary without any following
        // PTY bytes. In that case no delta event exists to carry the geometry;
        // adopting the target is safe only at the exact same byte prefix.
        if (this.seq === target.seq && this.geometry) {
          if (target.geometry.revision < this.geometry.revision) {
            throw new Error("terminal render checkpoint geometry moved backwards");
          }
          if (
            target.geometry.revision === this.geometry.revision &&
            !sameGeometry(target.geometry, this.geometry)
          ) {
            throw new Error("terminal render checkpoint geometry revision is inconsistent");
          }
          if (!sameGeometry(target.geometry, this.geometry)) {
            this.resize(target.geometry);
            this.geometry = { ...target.geometry };
          }
        }
        break;
      }
      if (Date.now() >= deadline)
        throw new Error(
          `terminal render checkpoint did not reach seq ${target.seq} (at ${this.seq})`,
        );
      await new Promise((resolve) => setTimeout(resolve, CAPTURE_POLL_MS));
    }

    const data = this.serializeWithinBudget(maxBytes);
    if (encoder.encode(data).length > CHECKPOINT_ABSOLUTE_MAX_BYTES) {
      throw new Error("terminal render checkpoint exceeds the absolute size limit");
    }
    return {
      generation: this.generation as number,
      seq: this.seq,
      geometry: { ...(this.geometry as TerminalGeometry) },
      data,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.admission?.cancel("checkpoint");
    this.rejectScheduledWrite?.(new Error("terminal render checkpoint is disposed"));
    this.rejectScheduledWrite = undefined;
    this.terminal.dispose();
  }

  private writeData(data: Uint8Array): Promise<void> {
    const admission = this.admission;
    if (!admission) return this.write(data);

    return new Promise<void>((resolve, reject) => {
      let offset = 0;
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        this.rejectScheduledWrite = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      this.rejectScheduledWrite = fail;
      const requestNext = () => {
        if (this.disposed) {
          fail(new Error("terminal render checkpoint is disposed"));
          return;
        }
        admission.request("checkpoint", (release, { contended }) => {
          if (this.disposed) {
            release();
            fail(new Error("terminal render checkpoint is disposed"));
            return;
          }
          const maxBytes = contended
            ? TERMINAL_WRITE_FAIR_QUANTUM_BYTES
            : TERMINAL_WRITE_BATCH_MAX_BYTES;
          const end = Math.min(data.length, offset + maxBytes);
          void this.write(data.subarray(offset, end)).then(
            () => {
              offset = end;
              if (offset < data.length) requestNext();
              release();
              if (offset === data.length && !settled) {
                settled = true;
                this.rejectScheduledWrite = undefined;
                resolve();
              }
            },
            (error) => {
              release();
              fail(error);
            },
          );
        });
      };
      requestNext();
    });
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.writeChain.then(() => {
      if (this.disposed) throw new Error("terminal render checkpoint is disposed");
      return operation();
    });
    this.writeChain = queued.catch(() => {});
    return queued;
  }

  private resize(geometry: TerminalGeometry): void {
    if (this.terminal.cols !== geometry.cols || this.terminal.rows !== geometry.rows) {
      this.terminal.resize(geometry.cols, geometry.rows);
    }
  }

  private assertUsable(target: TerminalRenderCheckpointTarget): void {
    if (this.disposed) throw new Error("terminal render checkpoint is disposed");
    if (!this.reconstructable) {
      throw new Error("terminal render checkpoint is not reconstructable");
    }
    if (this.generation !== target.generation) {
      throw new Error("terminal render checkpoint generation changed");
    }
    if (!this.geometry) throw new Error("terminal render checkpoint is not attached");
  }

  private serializeWithinBudget(requestedMaxBytes: number): string {
    const budget = Math.min(
      CHECKPOINT_ABSOLUTE_MAX_BYTES,
      Math.max(0, Math.floor(requestedMaxBytes)),
    );
    const maximumScrollback = this.terminal.buffer.normal.baseY;
    const minimum = this.serializeAddon.serialize({ scrollback: 0 });
    if (encoder.encode(minimum).length > budget || maximumScrollback === 0) return minimum;

    let low = 0;
    let high = maximumScrollback;
    let best = minimum;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = this.serializeAddon.serialize({ scrollback: middle });
      if (encoder.encode(candidate).length <= budget) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return best;
  }
}
