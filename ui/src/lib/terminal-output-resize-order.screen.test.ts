import { afterEach, describe, expect, it } from "vitest";
import {
  createScreenTerminal,
  diffScreens,
  screenRow,
  type ScreenTerminal,
} from "@/test/screen/xterm-screen";

/**
 * A geometry change cannot cross an unfinished VT sequence (issue #606,
 * ADR-0080). The component tests prove that TerminalView waits; this screen
 * test pins why the order matters against the real xterm parser and buffer.
 */

const OLD_COLS = 80;
const NEW_COLS = 40;
const ROWS = 4;
const surfaces: ScreenTerminal[] = [];

function surface(): ScreenTerminal {
  const created = createScreenTerminal({ cols: OLD_COLS, rows: ROWS });
  surfaces.push(created);
  return created;
}

afterEach(() => {
  while (surfaces.length > 0) surfaces.pop()?.dispose();
});

describe("split CSI and resize ordering on a real xterm", () => {
  it("changes the final cell grid when resize crosses the unfinished CSI", async () => {
    const completeBeforeResize = surface();
    await completeBeforeResize.write("\x1b[1;");
    await completeBeforeResize.write("70HX");
    completeBeforeResize.terminal.resize(NEW_COLS, ROWS);

    const resizeBeforeComplete = surface();
    await resizeBeforeComplete.write("\x1b[1;");
    resizeBeforeComplete.terminal.resize(NEW_COLS, ROWS);
    await resizeBeforeComplete.write("70HX");

    const expected = completeBeforeResize.capture();
    const reordered = resizeBeforeComplete.capture();

    expect(expected.cols).toBe(NEW_COLS);
    expect(reordered.cols).toBe(NEW_COLS);
    // On the old 80-column grid CUP 1;70 writes outside the future 40-column
    // viewport, so the shrink clips X. If the resize crosses the split CSI,
    // xterm clamps CUP to column 40 and X remains visibly painted there.
    expect(screenRow(expected, 0)).toBe("");
    expect(screenRow(reordered, 0)).toBe(`${" ".repeat(NEW_COLS - 1)}X`);
    expect(diffScreens(expected, reordered)).not.toBeNull();
  });
});
