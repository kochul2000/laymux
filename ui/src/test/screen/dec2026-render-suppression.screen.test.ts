/**
 * DEC 2026 (synchronized output) cursor behavior against the real xterm bundle
 * (issue #610, ADR-0079).
 *
 * Standard row requests are held by `RenderService.refreshRows` and
 * `RenderService._renderRows`. That is not a universal paint barrier: the DOM
 * renderer's focus, blur, and selection handlers call `renderRows` directly.
 * Such a lifecycle refresh can expose a mid-frame buffer position without an
 * `onRender` event. Laymux therefore keeps the raw cursor gate active for the
 * frame. This prevents a misplaced cursor on both renderer models; it does not
 * claim to make all DOM content atomic.
 *
 * The gate is set by a `CSI ? h` handler before xterm enables the mode, without
 * changing cursor options or requesting a render. Normal `?2026l` releases it
 * before xterm's mandatory full flush. If xterm's one-second safety timeout
 * closes the mode, TerminalView's rAF monitor releases the gate and requests
 * one recovery refresh; it may coalesce with xterm's own pending full render.
 *
 * These renderer-level claims require `terminal.open()`. jsdom has no WebGL
 * context, so direct lifecycle repaint assertions are deliberately DOM-specific.
 * The raw gate itself is shared by the DOM row factory and WebGL model builder;
 * that private-field contract is pinned in `native-cursor-suppression.test.ts`.
 */

import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";

import { installNativeCursorSuppression } from "@/lib/native-cursor-suppression";

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

const mounted: Terminal[] = [];

async function mountRenderedTerminal() {
  stubMatchMedia();
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: 400, configurable: true });
  document.body.appendChild(host);
  const terminal = new Terminal({ allowProposedApi: true, cols: 40, rows: 6 });
  terminal.open(host);
  mounted.push(terminal);
  await write(terminal, "\x1b[?25h");
  terminal.focus();
  await write(terminal, "ready");
  await settleRenders();
  return terminal;
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function settleRenders(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function countCursorElements(): number {
  return document.querySelectorAll(".xterm-cursor").length;
}

function renderedText(): string {
  return document.querySelector(".xterm-rows")?.textContent ?? "";
}

function renderedCursorRow(): number {
  const cursor = document.querySelector(".xterm-cursor");
  if (!cursor) return -1;
  return Array.from(document.querySelectorAll(".xterm-rows > div")).findIndex((row) =>
    row.contains(cursor),
  );
}

function recordRenders(terminal: Terminal): string[] {
  const renders: string[] = [];
  terminal.onRender((event) => renders.push(`${event.start}-${event.end}`));
  return renders;
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.dispose();
  document.body.replaceChildren();
});

describe("DEC 2026 standard render-service suppression (issue #610)", () => {
  it("renders no standard row request while open, then flushes once on close", async () => {
    const terminal = await mountRenderedTerminal();
    const renders = recordRenders(terminal);

    await write(terminal, "\x1b[?2026h");
    await write(terminal, "\r\nin-frame output");
    await settleRenders();

    expect(renders).toEqual([]);

    await write(terminal, "\x1b[?2026l");
    await settleRenders();

    expect(renders).toEqual([`0-${terminal.rows - 1}`]);
  });

  it("buffers an explicit refresh until the frame closes", async () => {
    const terminal = await mountRenderedTerminal();
    const renders = recordRenders(terminal);

    await write(terminal, "\x1b[?2026h");
    terminal.refresh(1, 1);
    await settleRenders();

    expect(renders).toEqual([]);

    await write(terminal, "\x1b[?2026l");
    await settleRenders();
    expect(renders).toEqual([`0-${terminal.rows - 1}`]);
  });
});

describe("DEC 2026 direct-render cursor gate (ADR-0079)", () => {
  it("prevents blur/focus from moving the cursor to a mid-frame position", async () => {
    const terminal = await mountRenderedTerminal();
    const suppression = installNativeCursorSuppression(terminal);
    expect(suppression.supported).toBe(true);
    await write(terminal, "\x1b[2J\x1b[HOLD\x1b[1;4H");
    await settleRenders();
    expect(renderedText()).toContain("OLD");
    expect(renderedCursorRow()).toBe(0);
    const renders = recordRenders(terminal);

    terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (params.includes(2026)) suppression.setSuppressed(true);
      return false;
    });
    terminal.parser.registerCsiHandler({ prefix: "?", final: "l" }, (params) => {
      if (params.includes(2026)) suppression.setSuppressed(false);
      return false;
    });

    await write(terminal, "\x1b[?2026h");
    await write(terminal, "\x1b[2J\x1b[HNEW\x1b[4;10H");
    await settleRenders();

    expect(renders).toEqual([]);
    expect(renderedText()).toContain("OLD");
    expect(countCursorElements()).toBe(1);

    // DOM focus lifecycle bypasses RenderService and paints the updated rows.
    // The raw gate keeps the new, uncommitted cursor out of that direct paint.
    terminal.blur();
    terminal.focus();
    expect(renders).toEqual([]);
    expect(renderedText()).toContain("NEW");
    expect(countCursorElements()).toBe(0);

    // Our reset handler runs before xterm's own full-flush handler.
    await write(terminal, "\x1b[?2026l");
    await settleRenders();
    expect(countCursorElements()).toBe(1);
    expect(renderedCursorRow()).toBe(3);
  });

  it("recovers the cursor when the safety timeout closes the mode", async () => {
    const terminal = await mountRenderedTerminal();
    const suppression = installNativeCursorSuppression(terminal);
    const renders = recordRenders(terminal);
    let recoveryRefreshes = 0;
    let monitorFrame: number | undefined;
    const monitorMode = () => {
      if (terminal.modes.synchronizedOutputMode) {
        monitorFrame = requestAnimationFrame(monitorMode);
        return;
      }
      monitorFrame = undefined;
      suppression.setSuppressed(false);
      recoveryRefreshes += 1;
      terminal.refresh(0, terminal.rows - 1);
    };
    terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (params.includes(2026)) {
        suppression.setSuppressed(true);
        monitorFrame ??= requestAnimationFrame(monitorMode);
      }
      return false;
    });

    await write(terminal, "\x1b[?2026h\r\ntimeout body\x1b[4;10H");
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    await settleRenders();

    expect(renders).toContain(`0-${terminal.rows - 1}`);
    expect(recoveryRefreshes).toBe(1);
    expect(countCursorElements()).toBe(1);
    expect(renderedCursorRow()).toBe(3);
  });
});
