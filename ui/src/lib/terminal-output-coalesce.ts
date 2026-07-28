import type { TerminalOutputAppliedSegment } from "./terminal-output-attach-coordinator";

/**
 * Largest merged segment the coalescer will build.
 *
 * Mirrors `TERMINAL_WRITE_CHUNK_SIZE` in `TerminalView`: a merged segment is
 * handed straight to one `terminal.write`, and that FIFO already refuses to
 * hand xterm more than 1 MiB at a time (ADR-0026). Merging past the budget
 * would only be re-split one layer down.
 */
export const TERMINAL_OUTPUT_COALESCE_MAX_BYTES = 1024 * 1024;

/**
 * Merge byte-contiguous output segments so a backlog costs O(bytes), not
 * O(deltas) (issue #606).
 *
 * Every applied segment pays a per-segment constant that has nothing to do with
 * its size: one `terminal.write` plus its parse callback, one headless
 * checkpoint-model write (ADR-0069), one stabilizer push, one `TextDecoder`
 * round, and a full sweep of the activity/Codex/Claude detectors over their
 * 1 KiB / 16 KiB rolling windows. During an output flood those constants — not
 * the byte count — dominate the frontend main thread, so a backlog of small
 * deltas is far more expensive than the same bytes in one delta.
 *
 * Merging is only ever legal where the stream is genuinely one run of bytes on
 * one grid, so a merge is refused at:
 * - a generation change — a different PTY, different sequence space;
 * - a geometry revision change — the bytes on either side are addressed to
 *   different grids and the checkpoint model must resize between them
 *   (ADR-0069), exactly the boundary ADR-0072 refuses to repair across;
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
      previous.seqEnd === segment.seqStart &&
      runBytes + segment.data.length <= TERMINAL_OUTPUT_COALESCE_MAX_BYTES;
    if (!mergeable) flush();
    run.push(segment);
    runBytes += segment.data.length;
  }
  flush();
  return merged;
}
