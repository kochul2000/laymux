import type { TerminalOutputAppliedSegment } from "./terminal-output-attach-coordinator";
import { TERMINAL_WRITE_BATCH_MAX_BYTES } from "./terminal-write-batch-queue";

/**
 * Largest merged segment the coalescer will build.
 *
 * Shared with the visible xterm write FIFO so both renderer-facing parsers get
 * bounded chunks. The checkpoint merge is independent from visible-write
 * batching: stabilizers and state detectors still consume original boundaries.
 */
export const TERMINAL_OUTPUT_COALESCE_MAX_BYTES = TERMINAL_WRITE_BATCH_MAX_BYTES;

/**
 * Merge byte-contiguous output segments for the rendererless checkpoint model
 * (issue #606, ADR-0080). This helper must not sit above
 * `processLiveTerminalOutput`: native stabilization depends on both arrival time
 * and chunk boundaries, and the state detectors observe each emission in order.
 *
 * Merging is only ever legal where the stream is genuinely one run of bytes on
 * one grid, so a merge is refused at:
 * - a generation change — a different PTY, different sequence space;
 * - any geometry change — the bytes on either side are addressed to different
 *   grids and the checkpoint model must resize between them (ADR-0069), exactly
 *   the boundary ADR-0072 refuses to repair across; checking dimensions as well
 *   as revision also preserves detection of contradictory metadata;
 * - a sequence discontinuity — a hole must stay visible to the gap logic;
 * - {@link TERMINAL_OUTPUT_COALESCE_MAX_BYTES}.
 *
 * Byte order is preserved exactly, and the merged segment's
 * `seqStart`/`seqEnd` describe precisely the bytes it carries, so it stays a
 * valid input to `TerminalOutputAttachCoordinator` bookkeeping and to the
 * checkpoint model's sequence assertions.
 */
export function coalesceTerminalOutputSegments(
  segments: readonly TerminalOutputAppliedSegment[],
): TerminalOutputAppliedSegment[] {
  const merged: TerminalOutputAppliedSegment[] = [];
  // Parts of the run currently being accumulated. Kept as a list so a run of
  // one segment is emitted by reference and never copied.
  let run: TerminalOutputAppliedSegment[] = [];
  let runBytes = 0;

  const flush = () => {
    if (run.length === 0) return;
    if (run.length === 1) {
      merged.push(run[0]);
    } else {
      const data = new Uint8Array(runBytes);
      let offset = 0;
      for (const part of run) {
        data.set(part.data, offset);
        offset += part.data.length;
      }
      merged.push({
        generation: run[0].generation,
        seqStart: run[0].seqStart,
        seqEnd: run[run.length - 1].seqEnd,
        data,
        geometry: run[0].geometry,
      });
    }
    run = [];
    runBytes = 0;
  };

  for (const segment of segments) {
    // A zero-byte segment carries no bytes to write; its sequence boundary is
    // already covered by the coordinator, so emitting it would only cost an
    // extra xterm write.
    if (segment.data.length === 0) continue;
    const previous = run[run.length - 1];
    const mergeable =
      previous !== undefined &&
      previous.generation === segment.generation &&
      previous.geometry.revision === segment.geometry.revision &&
      previous.geometry.cols === segment.geometry.cols &&
      previous.geometry.rows === segment.geometry.rows &&
      previous.seqEnd === segment.seqStart &&
      runBytes + segment.data.length <= TERMINAL_OUTPUT_COALESCE_MAX_BYTES;
    if (!mergeable) flush();
    run.push(segment);
    runBytes += segment.data.length;
  }
  flush();
  return merged;
}
