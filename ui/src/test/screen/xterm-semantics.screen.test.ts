/**
 * xterm behaviours the mocked terminal cannot model, pinned against the real
 * bundle (issue #605).
 *
 * `TerminalView.test.tsx`'s mock defines `reset` as a bare `vi.fn()`: it neither
 * empties the buffer nor emits `onScroll`, and its `write` never reaches a VT
 * parser. Three claims the desktop terminal depends on are therefore invisible
 * there, and each one is a live issue:
 *
 * - `reset()` **is** a scroll event, synchronously (issue #602),
 * - cell widths and the caret column come from xterm's tables plus our Unicode
 *   provider, not from string length (issue #596),
 * - `ESC[K` erases from the cursor column only — the premise the whole
 *   differential-render argument in ADR-0072 rests on.
 *
 * These are harness-fidelity tests: they fix what the harness reports about a
 * real `Terminal`, so the screen tests built on it mean what they say. The
 * component-level consequences (where the composition anchor ends up, where the
 * overlay caret is painted) stay with their own issues.
 */

import { describe, expect, it } from "vitest";
import { computeCellMetrics, computeHelperAnchorStyle } from "@/lib/ime-anchor";
import { createScreenTerminal } from "./xterm-screen";

describe("reset() semantics the mocked xterm does not model (issue #602)", () => {
  it("clears the buffer and collapses the scrollback", async () => {
    const surface = createScreenTerminal({ cols: 40, rows: 6, scrollback: 200 });
    await surface.write("keep me\r\n");
    await surface.write("filler\r\n".repeat(30));
    const before = surface.capture();
    expect(before.baseY).toBeGreaterThan(0);

    surface.reset();

    const after = surface.capture();
    expect(after.baseY).toBe(0);
    expect(after.viewport.every((row) => row.text.trim() === "")).toBe(true);
    surface.dispose();
  });

  it("emits onScroll synchronously, so a baseY follower sees a negative row delta", async () => {
    const surface = createScreenTerminal({ cols: 40, rows: 6, scrollback: 200 });
    await surface.write("filler\r\n".repeat(30));
    const scrollbackHeight = surface.terminal.buffer.active.baseY;
    expect(scrollbackHeight).toBeGreaterThan(0);

    // Mirrors what TerminalView's composition scroll baseline does: remember
    // `baseY`, and on every scroll carry the open composition's absolute anchor
    // by the difference. It re-seeds instead of reporting when the buffer type
    // changes — which `reset()` does not do, so nothing catches this one.
    let baseline = scrollbackHeight;
    let bufferType = surface.terminal.buffer.active.type;
    const rowDeltas: number[] = [];
    const bufferTypeChanges: string[] = [];
    surface.terminal.onScroll(() => {
      const nextType = surface.terminal.buffer.active.type;
      const baseY = surface.terminal.buffer.active.baseY;
      if (nextType !== bufferType) {
        bufferTypeChanges.push(nextType);
        bufferType = nextType;
        baseline = baseY;
        return;
      }
      rowDeltas.push(baseY - baseline);
      baseline = baseY;
    });

    surface.reset();

    // Synchronous: already reported by the time `reset()` returns. A test that
    // awaited a tick could not tell this apart from a queued event, and the
    // ordering is what decides whether an anchor written after `reset()` wins.
    expect(rowDeltas).toEqual([-scrollbackHeight]);
    expect(bufferTypeChanges).toEqual([]);
    surface.dispose();
  });
});

describe("cell widths come from xterm's own tables (issue #596)", () => {
  it("spends two cells per full-width character", async () => {
    const surface = createScreenTerminal({ cols: 20, rows: 4 });
    await surface.write("ab가나");
    const row = surface.capture().viewport[0];

    expect(row.cells.slice(0, 6).map((cell) => [cell.chars, cell.width])).toEqual([
      ["a", 1],
      ["b", 1],
      ["가", 2],
      ["", 0],
      ["나", 2],
      ["", 0],
    ]);
    // The caret is at column 6, not at string index 4.
    expect(surface.terminal.buffer.active.cursorX).toBe(6);
    surface.dispose();
  });

  it("puts the composition anchor on the column a full-width run ends at", async () => {
    const cols = 20;
    const rows = 4;
    const surface = createScreenTerminal({ cols, rows });
    await surface.write("한글 입력");
    const buffer = surface.terminal.buffer.active;

    // Production geometry: cell size from the rendered rect, anchor from the
    // buffer cursor (`ime-anchor.ts`). A 200px-wide screen over 20 columns is
    // 10px per cell, so the expected offset is a plain multiple of the cursor
    // column — and that column is only right if the widths above are right.
    const metrics = computeCellMetrics(200, 80, cols, rows);
    expect(metrics).not.toBeNull();
    const style = computeHelperAnchorStyle({
      anchorCell: { column: buffer.cursorX, row: buffer.cursorY },
      metrics: metrics!,
      originLeft: 0,
      originTop: 0,
      devicePixelRatio: 1,
    });

    // 한글(4) + space(1) + 입력(4) = 9 cells.
    expect(buffer.cursorX).toBe(9);
    expect(style.left).toBe(90);
    expect(style.top).toBe(0);
    surface.dispose();
  });
});

describe("ESC[K erases from the cursor column only", () => {
  it("leaves the cells before the model's own column untouched", async () => {
    const surface = createScreenTerminal({ cols: 20, rows: 3 });
    await surface.write("ABCDEFGHIJ");
    // A differential renderer repositions to the column it believes changed and
    // erases from there. Everything to its left survives — and is never resent.
    await surface.write("\x1b[1;5H\x1b[K");

    const row = surface.capture().viewport[0];
    expect(row.text.replace(/\s+$/, "")).toBe("ABCD");
    surface.dispose();
  });
});
