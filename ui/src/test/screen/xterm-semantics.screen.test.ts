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

import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";
import { computeCellMetrics, computeHelperAnchorStyle } from "@/lib/ime-anchor";
import { createCodexTranscriptWheelHandler } from "@/lib/codex-transcript-wheel";
import { createScreenTerminal } from "./xterm-screen";

function stubMatchMedia() {
  if (window.matchMedia) return;
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      matches: false,
      media: "",
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

const mountedWheelTerminals: Terminal[] = [];

function mountWheelTerminal(options: { scrollSensitivity: number; fastScrollSensitivity: number }) {
  stubMatchMedia();
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: 400, configurable: true });
  document.body.appendChild(host);
  const terminal = new Terminal({
    allowProposedApi: true,
    cols: 40,
    rows: 6,
    ...options,
  });
  terminal.open(host);
  const screenElement = terminal.element!.querySelector<HTMLElement>(".xterm-screen")!;
  screenElement.style.paddingLeft = "0px";
  screenElement.style.paddingTop = "0px";
  // jsdom has no font layout. Seed the same private measurement boundary the
  // DOM renderer consumes so wheel coordinates and cell-height conversion are
  // meaningful against the real xterm bundle.
  const core = (
    terminal as unknown as {
      _core: {
        _charSizeService: { width: number; height: number };
        _renderService: { handleCharSizeChanged(): void };
      };
    }
  )._core;
  core._charSizeService.width = 10;
  core._charSizeService.height = 20;
  core._renderService.handleCharSizeChanged();
  mountedWheelTerminals.push(terminal);
  return terminal;
}

afterEach(() => {
  while (mountedWheelTerminals.length) mountedWheelTerminals.pop()?.dispose();
  document.body.replaceChildren();
});

describe("wheel sensitivity in application-owned terminal modes", () => {
  it("repeats mouse reports by the Alt fast-scroll multiplier", async () => {
    const terminal = mountWheelTerminal({ scrollSensitivity: 1, fastScrollSensitivity: 5 });
    const reports: string[] = [];
    terminal.onData((data) => reports.push(data));
    await writeTerminal(terminal, "\x1b[?1000h\x1b[?1006h");

    terminal.element!.dispatchEvent(
      new WheelEvent("wheel", {
        altKey: true,
        bubbles: true,
        cancelable: true,
        clientX: 1,
        clientY: 1,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY: 1,
      }),
    );

    expect(reports).toHaveLength(5);
    expect(reports).toEqual(Array(5).fill("\x1b[<73;1;1M"));
  });

  it("repeats fallback cursor keys by the Alt fast-scroll multiplier", async () => {
    const terminal = mountWheelTerminal({ scrollSensitivity: 1, fastScrollSensitivity: 5 });
    const data: string[] = [];
    terminal.onData((chunk) => data.push(chunk));
    await writeTerminal(terminal, "\x1b[?1049h");

    terminal.element!.dispatchEvent(
      new WheelEvent("wheel", {
        altKey: true,
        bubbles: true,
        cancelable: true,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY: 1,
      }),
    );

    // Keep every row as its own input emission. On Windows, sending one
    // concatenated chunk lets ConPTY collapse repeated cursor input into one
    // console key event, and Codex's transcript pager then advances one row.
    expect(data).toEqual(Array(5).fill("\x1b[B"));
  });

  it("accumulates a fractional multiplier until it reaches one application row", async () => {
    const terminal = mountWheelTerminal({ scrollSensitivity: 0.5, fastScrollSensitivity: 5 });
    const data: string[] = [];
    terminal.onData((chunk) => data.push(chunk));
    await writeTerminal(terminal, "\x1b[?1049h");
    const wheel = () =>
      terminal.element!.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          deltaY: 1,
        }),
      );

    wheel();
    expect(data).toEqual([]);
    wheel();
    expect(data.join("")).toBe("\x1b[B");
  });

  it("routes normal-buffer Codex transcript wheel input as discrete cursor keys", async () => {
    const terminal = mountWheelTerminal({ scrollSensitivity: 1, fastScrollSensitivity: 5 });
    const data: string[] = [];
    terminal.onData((chunk) => data.push(chunk));
    terminal.attachCustomWheelEventHandler(
      createCodexTranscriptWheelHandler({
        terminal,
        isCodexActive: () => true,
        isLocalControlAllowed: () => true,
      }),
    );
    await writeTerminal(
      terminal,
      "\x1b[2J\x1b[H/ T R A N S C R I P T\r\ncontent\r\n\r\n↑/↓ to scroll  pgup/pgdn to page  home/end to jump",
    );
    expect(terminal.buffer.active.type).toBe("normal");

    terminal.element!.dispatchEvent(
      new WheelEvent("wheel", {
        altKey: true,
        bubbles: true,
        cancelable: true,
        deltaMode: WheelEvent.DOM_DELTA_LINE,
        deltaY: 1,
      }),
    );

    expect(data).toEqual(Array(5).fill("\x1b[B"));
    expect(terminal.buffer.active.viewportY).toBe(terminal.buffer.active.baseY);
  });
});

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

describe("accepted write callback no-throw boundary (issue #624)", () => {
  it("keeps the real xterm parser draining when a completion step fails", async () => {
    const surface = createScreenTerminal({ cols: 20, rows: 3 });
    const completionErrors: string[] = [];

    const firstParsed = new Promise<void>((resolve) => {
      surface.terminal.write("first", () => {
        // Production isolates each embedder completion step at this boundary.
        // The failed step is recorded, but its exception must not escape into
        // xterm before xterm advances its own write-buffer accounting.
        try {
          throw new Error("completion failed");
        } catch (error) {
          completionErrors.push(error instanceof Error ? error.message : String(error));
        }
        resolve();
      });
    });
    const tailParsed = new Promise<void>((resolve) => {
      // Queue this immediately, before the first callback runs. It proves that
      // the real parser continues draining its already-queued tail.
      surface.terminal.write("tail", resolve);
    });

    await Promise.all([firstParsed, tailParsed]);

    expect(surface.capture().viewport[0].text.trimEnd()).toBe("firsttail");
    expect(completionErrors).toEqual(["completion failed"]);

    // The inverse case (letting a callback exception escape) intentionally
    // remains in TerminalView's faithful single-flight model: throwing from a
    // real xterm callback is reported by Vitest as an uncaught async error.
    surface.dispose();
  });
});

describe("xterm UTF-8 decoding precedes VT control parsing (issue #632)", () => {
  it("keeps a Korean OSC payload open until BEL despite its trailing 0x9c byte", async () => {
    const surface = createScreenTerminal({ cols: 20, rows: 3 });
    const payloads: string[] = [];
    const handler = surface.terminal.parser.registerOscHandler(0, (payload) => {
      payloads.push(payload);
      return true;
    });
    const prefix = new TextEncoder().encode("\x1b]0;한");

    await surface.write(prefix.slice(0, -1));
    expect(Array.from(prefix.slice(-3))).toEqual([0xed, 0x95, 0x9c]);
    expect(payloads).toEqual([]);
    await surface.write(prefix.slice(-1));
    expect(payloads).toEqual([]);

    await surface.write(Uint8Array.of(0x07));
    expect(payloads).toEqual(["한"]);

    handler.dispose();
    surface.dispose();
  });

  it("discards a standalone invalid UTF-8 C1 byte instead of treating it as ST", async () => {
    const surface = createScreenTerminal({ cols: 20, rows: 3 });
    const payloads: string[] = [];
    const handler = surface.terminal.parser.registerOscHandler(0, (payload) => {
      payloads.push(payload);
      return true;
    });

    await surface.write(Uint8Array.from([0x1b, 0x5d, 0x30, 0x3b, 0x9c]));
    expect(payloads).toEqual([]);
    await surface.write(Uint8Array.of(0x07));
    expect(payloads).toEqual([""]);

    handler.dispose();
    surface.dispose();
  });

  it("recognizes a valid UTF-8 encoding of the U+009C C1 scalar as ST", async () => {
    const surface = createScreenTerminal({ cols: 20, rows: 3 });
    const payloads: string[] = [];
    const handler = surface.terminal.parser.registerOscHandler(0, (payload) => {
      payloads.push(payload);
      return true;
    });

    await surface.write(Uint8Array.from([0x1b, 0x5d, 0x30, 0x3b, 0x6f, 0x6b, 0xc2, 0x9c]));
    expect(payloads).toEqual(["ok"]);

    handler.dispose();
    surface.dispose();
  });

  it("does not execute a CSI mode when a decoded non-ASCII scalar interrupts it", async () => {
    const surface = createScreenTerminal({ cols: 20, rows: 3 });
    const modes: number[][] = [];
    const handler = surface.terminal.parser.registerCsiHandler(
      { prefix: "?", final: "h" },
      (params) => {
        modes.push(params.toArray());
        return true;
      },
    );

    await surface.write(
      Uint8Array.from([0x1b, 0x5b, 0x3f, 0x32, 0x30, 0x32, 0x36, 0x3b, 0xe1, 0x80, 0x9b, 0x68]),
    );
    expect(modes).toEqual([]);

    handler.dispose();
    surface.dispose();
  });
});
