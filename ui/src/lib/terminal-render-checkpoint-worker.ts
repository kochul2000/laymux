import type {
  TerminalRenderCheckpoint,
  TerminalRenderCheckpointTarget,
} from "./terminal-render-checkpoint";
import type {
  TerminalOutputAppliedSegment,
  TerminalOutputAttachment,
} from "./terminal-output-attach-coordinator";
import type { TerminalParserAdmission } from "./terminal-parser-admission";
import { TERMINAL_WRITE_BATCH_MAX_BYTES } from "./terminal-write-batch-queue";
import { TERMINAL_CHECKPOINT_CAPTURE_WAIT_MS } from "./terminal-checkpoint-timeouts";

export type CheckpointWorkerRequest = { id: number } & (
  | { op: "attach"; attachment: TerminalOutputAttachment }
  | { op: "apply"; segment: TerminalOutputAppliedSegment }
  | { op: "capture"; target: TerminalRenderCheckpointTarget; maxBytes: number }
);
export type CheckpointWorkerResponse =
  | { id: number; ok: true; result?: TerminalRenderCheckpoint }
  | { id: number; ok: false; error: string };
export interface CheckpointWorkerPort {
  onmessage: ((event: MessageEvent<CheckpointWorkerResponse>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  onmessageerror: ((event: MessageEvent) => void) | null;
  postMessage(message: CheckpointWorkerRequest, transfer: Transferable[]): void;
  terminate(): void;
}
interface Options {
  admission?: Pick<TerminalParserAdmission, "request" | "cancel">;
  createWorker?: () => CheckpointWorkerPort;
  timeoutMs?: number;
}
const RESPONSE_TIMEOUT_MS = 4_000;

/** The admission owner stays on the UI thread; the mirror lives in a Worker. */
export class TerminalRenderCheckpointWorker {
  private readonly worker: CheckpointWorkerPort;
  private readonly admission: Options["admission"];
  private readonly timeoutMs: number;
  private sequence = 0;
  private disposed = false;
  private failure: Error | undefined;
  private chain = Promise.resolve();
  private rejectScheduled: ((error: Error) => void) | undefined;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  constructor(options: Options = {}) {
    this.admission = options.admission;
    this.timeoutMs = options.timeoutMs ?? RESPONSE_TIMEOUT_MS;
    this.worker =
      options.createWorker?.() ??
      new Worker(new URL("./terminal-render-checkpoint.worker.ts", import.meta.url), {
        type: "module",
      });
    this.worker.onmessage = ({ data }) => {
      const request = this.pending.get(data.id);
      if (!request) return;
      this.pending.delete(data.id);
      clearTimeout(request.timer);
      if (data.ok) request.resolve(data.result);
      else request.reject(new Error(data.error));
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.fail(new Error(`checkpoint Worker failed: ${event.message}`));
    };
    this.worker.onmessageerror = () => this.fail(new Error("checkpoint Worker message failed"));
  }

  attach(attachment: TerminalOutputAttachment): Promise<void> {
    return this.enqueue(async () => {
      // Reset/adopt geometry first, then admit snapshot bytes in bounded turns.
      await this.request<void>({
        op: "attach",
        attachment: {
          ...attachment,
          state: { ...attachment.state, snapshotSeq: attachment.state.snapshotStartSeq },
          snapshot: new Uint8Array(),
        },
      });
      await this.writeChunks({
        generation: attachment.state.generation,
        seqStart: attachment.state.snapshotStartSeq,
        seqEnd: attachment.state.snapshotSeq,
        data: attachment.snapshot,
        geometry: attachment.state.geometry,
      });
    });
  }

  apply(segment: TerminalOutputAppliedSegment): Promise<void> {
    return this.enqueue(() => this.writeChunks(segment));
  }

  async capture(
    target: TerminalRenderCheckpointTarget,
    maxBytes: number,
  ): Promise<TerminalRenderCheckpoint> {
    // Wait for writes already accepted here, without blocking later writes
    // needed to reach a target. The Worker's model owns atomic serialization.
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.chain.then(() => {
          if (expired)
            throw new Error(`terminal render checkpoint did not reach seq ${target.seq}`);
          return this.request<TerminalRenderCheckpoint>({ op: "capture", target, maxBytes });
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            reject(new Error(`terminal render checkpoint did not reach seq ${target.seq}`));
          }, TERMINAL_CHECKPOINT_CAPTURE_WAIT_MS);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.admission?.cancel("checkpoint");
    const error = new Error("terminal render checkpoint is disposed");
    this.rejectScheduled?.(error);
    this.rejectScheduled = undefined;
    this.fail(error);
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.chain.then(() => {
      if (this.disposed || this.failure)
        throw this.failure ?? new Error("terminal render checkpoint is disposed");
      return operation();
    });
    this.chain = result.catch(() => {});
    return result;
  }

  private writeChunks(segment: TerminalOutputAppliedSegment): Promise<void> {
    if (segment.seqEnd - segment.seqStart !== segment.data.length) {
      return Promise.reject(new Error("checkpoint Worker source range mismatch"));
    }
    if (segment.data.length === 0) return this.request<void>({ op: "apply", segment });
    let offset = 0;
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        this.rejectScheduled = undefined;
        reject(error);
      };
      this.rejectScheduled = fail;
      const next = () => {
        if (this.disposed || this.failure) {
          fail(this.failure ?? new Error("terminal render checkpoint is disposed"));
          return;
        }
        const run = (release: () => void, maxBytes: number) => {
          if (settled) {
            release();
            return;
          }
          const end = Math.min(segment.data.length, offset + maxBytes);
          // The ingress buffer still belongs to visible xterm. Transfer only
          // this independent copy, never the shared backing or its subarray.
          const data = segment.data.slice(offset, end);
          const piece = {
            ...segment,
            data,
            seqStart: segment.seqStart + offset,
            seqEnd: segment.seqStart + end,
          };
          void this.request<void>({ op: "apply", segment: piece }, [data.buffer]).then(
            () => {
              offset = end;
              if (offset < segment.data.length) next();
              release();
              if (offset === segment.data.length && !settled) {
                settled = true;
                this.rejectScheduled = undefined;
                resolve();
              }
            },
            (error: Error) => {
              release();
              fail(error);
            },
          );
        };
        if (this.admission)
          this.admission.request(
            "checkpoint",
            (release, { maxBytes }) => run(release, maxBytes),
            segment.data.length - offset,
          );
        else run(() => {}, TERMINAL_WRITE_BATCH_MAX_BYTES);
      };
      next();
    });
  }

  private request<T>(
    message:
      | Omit<Extract<CheckpointWorkerRequest, { op: "attach" }>, "id">
      | Omit<Extract<CheckpointWorkerRequest, { op: "apply" }>, "id">
      | Omit<Extract<CheckpointWorkerRequest, { op: "capture" }>, "id">,
    transfer: Transferable[] = [],
  ): Promise<T> {
    if (this.disposed || this.failure)
      return Promise.reject(this.failure ?? new Error("terminal render checkpoint is disposed"));
    return new Promise<T>((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(
        () => this.fail(new Error("checkpoint Worker response timed out")),
        this.timeoutMs,
      );
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.worker.postMessage({ ...message, id }, transfer);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.admission?.cancel("checkpoint");
    this.rejectScheduled?.(error);
    this.rejectScheduled = undefined;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.worker.terminate();
  }
}
