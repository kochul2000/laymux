/**
 * In-memory stand-in for the backend's sequenced output ring.
 *
 * Models exactly the three operations the desktop output protocol exposes
 * (`docs/architecture/data-flow.md` §8.8, [ADR-0072]):
 *
 * - `record()` — the PTY callback: append bytes to the ring, hand back the
 *   `terminal-output-v2` delta that *would* be emitted. Whether the test then
 *   delivers that delta is what makes a delivery gap.
 * - `attach()` — `attach_terminal_output`: the retained bytes as one snapshot.
 *   When eviction has already dropped the head, `snapshotStartSeq > 0`, which
 *   is precisely the "replay starting at an arbitrary byte offset" the ADR says
 *   cannot restore a differentially rendered screen.
 * - `resume()` — `resume_terminal_output`: the exact `[seq, writeSeq)` range, or
 *   `null` when the generation changed or the range is no longer retained. No
 *   clamping, same as the Rust side.
 *
 * Eviction is byte-granular because the real ring is a byte ring: it has no
 * frame boundaries to preserve.
 */

import type {
  TerminalAttachState,
  TerminalGeometry,
  TerminalOutputAttachment,
  TerminalOutputDelta,
} from "@/lib/terminal-output-attach-coordinator";
import { TERMINAL_OUTPUT_PROTOCOL_VERSION } from "@/lib/terminal-output-attach-coordinator";

export interface OutputRingOptions {
  /** Retention budget. The production desktop ring is 1 MiB. */
  maxBytes?: number;
  generation?: number;
  cols?: number;
  rows?: number;
  bracketedPaste?: boolean;
}

export interface OutputRing {
  readonly generation: number;
  /** Sequence one past the last recorded byte. */
  readonly writeSeq: number;
  /** Sequence of the oldest byte still retained. */
  readonly retainedStartSeq: number;
  readonly geometry: TerminalGeometry;
  record(data: string | Uint8Array): TerminalOutputDelta;
  attach(): TerminalOutputAttachment;
  resume(generation: number, seq: number): TerminalOutputDelta | null;
  /** Bump the geometry revision the way a PTY resize does, before later bytes. */
  resize(cols: number, rows: number): void;
  /** Replace the session, as a terminal re-create does. */
  regenerate(): void;
  /**
   * Drop everything before `seq`, as retention pressure eventually does.
   *
   * Tests use this instead of tuning `maxBytes` when they need the cut to land
   * on a frame boundary. The real ring has no frame boundaries, so a byte-budget
   * cut usually lands mid-escape — and a replay that starts mid-escape fails for
   * a second, uninteresting reason. Cutting cleanly keeps the control group's
   * failure attributable to the one thing under test: cells the program never
   * repaints.
   */
  evictTo(seq: number): void;
}

const encoder = new TextEncoder();

export function toBytes(data: string | Uint8Array): Uint8Array {
  return typeof data === "string" ? encoder.encode(data) : data;
}

export function createOutputRing(options: OutputRingOptions = {}): OutputRing {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  let generation = options.generation ?? 1;
  let geometry: TerminalGeometry = {
    revision: 0,
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
  };
  const bracketedPaste = options.bracketedPaste ?? false;
  let retained = new Uint8Array(0);
  let retainedStartSeq = 0;
  let writeSeq = 0;

  const evict = () => {
    if (retained.length <= maxBytes) return;
    const drop = retained.length - maxBytes;
    retained = retained.slice(drop);
    retainedStartSeq += drop;
  };

  return {
    get generation() {
      return generation;
    },
    get writeSeq() {
      return writeSeq;
    },
    get retainedStartSeq() {
      return retainedStartSeq;
    },
    get geometry() {
      return geometry;
    },
    record(data) {
      const bytes = toBytes(data);
      const seqStart = writeSeq;
      writeSeq += bytes.length;
      const next = new Uint8Array(retained.length + bytes.length);
      next.set(retained, 0);
      next.set(bytes, retained.length);
      retained = next;
      evict();
      return {
        generation,
        seqStart,
        seqEnd: writeSeq,
        data: bytes,
        geometry,
      };
    },
    attach(): TerminalOutputAttachment {
      const state: TerminalAttachState = {
        version: TERMINAL_OUTPUT_PROTOCOL_VERSION,
        generation,
        snapshotStartSeq: retainedStartSeq,
        snapshotSeq: writeSeq,
        sourceStartSeq: retainedStartSeq,
        sourceSeq: writeSeq,
        snapshotKind: "raw",
        protocolRevision: 0,
        modes: { bracketedPaste },
        geometry,
      };
      return { state, snapshot: retained.slice() };
    },
    resume(requestedGeneration, seq) {
      if (requestedGeneration !== generation) return null;
      if (seq < retainedStartSeq || seq > writeSeq) return null;
      return {
        generation,
        seqStart: seq,
        seqEnd: writeSeq,
        data: retained.slice(seq - retainedStartSeq),
        geometry,
      };
    },
    evictTo(seq) {
      const target = Math.min(Math.max(seq, retainedStartSeq), writeSeq);
      const drop = target - retainedStartSeq;
      if (drop <= 0) return;
      retained = retained.slice(drop);
      retainedStartSeq = target;
    },
    resize(cols, rows) {
      geometry = { revision: geometry.revision + 1, cols, rows };
    },
    regenerate() {
      generation += 1;
      retained = new Uint8Array(0);
      retainedStartSeq = 0;
      writeSeq = 0;
    },
  };
}
