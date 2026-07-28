/**
 * What a DEC 2026 (synchronized output) frame does to xterm's **renderer**,
 * pinned against the real bundle (issue #610, [ADR-0079]).
 *
 * Issue #610 was opened on the premise that `.terminal-sync-output-active
 * .xterm-cursor { opacity: 0 }` leaves a hole: CSS cannot reach the WebGL
 * addon's canvas, so "the native cursor keeps being drawn during the frame".
 * The premise is wrong, and these tests are why. `RenderService.refreshRows`
 * and `RenderService._renderRows` both return early while
 * `decPrivateModes.synchronizedOutput` is set, so **no** row is rendered for
 * the duration of a frame — not by a write, not by an explicit
 * `terminal.refresh()`, not by the cursor-blink redraw. Nothing new is drawn,
 * so there is nothing to suppress; what is on screen is the last pre-frame
 * paint, frozen, which is what synchronized output means.
 *
 * The same tests kill fix option (a) from the issue — "OR `syncOutputActive`
 * into `hideNativeCursor` and refresh". Writing the renderer gate at the
 * earliest possible moment (a `CSI ? h` handler, which runs *before*
 * `InputHandler` sets the mode, so a refresh from it is not rejected on
 * arrival) still paints nothing: the render is animation-frame debounced and by
 * the time the frame callback runs the mode is on and the render is swallowed.
 * So the gate would be written and reverted between two paints and no pixel
 * would ever differ.
 *
 * These are renderer-level claims, so unlike the rest of this directory they
 * need `terminal.open()` — `RenderService` does not exist before it. jsdom has
 * no WebGL context, so the renderer under test is the DOM one; the two are the
 * same on the point being made, because the suppression is in `RenderService`,
 * above both, and the cursor gate is the identical field in both
 * (`WebglRenderer` model build, `DomRendererRowFactory` row build — pinned in
 * `native-cursor-suppression.test.ts`).
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

/** A rendered terminal: opened, focused, with the cursor element materialised. */
async function mountRenderedTerminal() {
  stubMatchMedia();
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: 400, configurable: true });
  document.body.appendChild(host);
  const terminal = new Terminal({ allowProposedApi: true, cols: 40, rows: 6 });
  terminal.open(host);
  mounted.push(terminal);
  // `isCursorInitialized` is what both renderers check before the gate; DECTCEM
  // show is one of the two things that sets it.
  await write(terminal, "\x1b[?25h");
  terminal.focus();
  await write(terminal, "ready");
  await settleRenders();
  return terminal;
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

/** Let the render debouncer's animation frame run, then drain the task queue. */
function settleRenders(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

function countCursorElements(): number {
  return document.querySelectorAll(".xterm-cursor").length;
}

/** Records every `onRender` as `"start-end"`, newest last. */
function recordRenders(terminal: Terminal): string[] {
  const renders: string[] = [];
  terminal.onRender((e) => renders.push(`${e.start}-${e.end}`));
  return renders;
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.dispose();
  document.body.replaceChildren();
});

describe("a DEC 2026 frame stops rendering outright (issue #610)", () => {
  it("renders no row while the frame is open, then flushes once on close", async () => {
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

  it("swallows an explicit refresh until the frame closes, keeping its range", async () => {
    const terminal = await mountRenderedTerminal();
    const renders = recordRenders(terminal);

    await write(terminal, "\x1b[?2026h");
    terminal.refresh(1, 1);
    await settleRenders();

    expect(renders).toEqual([]);

    // Not lost: the buffered range is merged into the frame-close flush, which
    // is why laymux's own `refresh()` calls do not need to know about frames.
    await write(terminal, "\x1b[?2026l");
    await settleRenders();
    expect(renders).toEqual([`0-${terminal.rows - 1}`]);
  });
});

describe("the renderer cursor gate cannot be applied inside a frame (ADR-0079)", () => {
  it("leaves the painted cursor on screen even when the gate is set before the mode flips", async () => {
    const terminal = await mountRenderedTerminal();
    const suppression = installNativeCursorSuppression(terminal);
    expect(suppression.supported).toBe(true);
    expect(countCursorElements()).toBe(1);
    const renders = recordRenders(terminal);
    const modeSeenByHandler: boolean[] = [];
    const decPrivateModes = (
      terminal as Terminal & {
        _core: { coreService: { decPrivateModes: { synchronizedOutput: boolean } } };
      }
    )._core.coreService.decPrivateModes;

    // Registered after `InputHandler`'s, and CSI handlers run newest first, so
    // this is the earliest any laymux code can act on `?2026h` — exactly where
    // `setSyncOutputActive(true)` is called from today.
    terminal.parser.registerCsiHandler({ prefix: "?", final: "h" }, (params) => {
      if (params.includes(2026)) {
        modeSeenByHandler.push(decPrivateModes.synchronizedOutput);
        suppression.setSuppressed(true);
        terminal.refresh(0, terminal.rows - 1);
      }
      return false;
    });

    await write(terminal, "\x1b[?2026h");
    await settleRenders();

    // The handler really did run ahead of the mode being set...
    expect(modeSeenByHandler).toEqual([false]);
    expect(decPrivateModes.synchronizedOutput).toBe(true);
    // ...and it still bought nothing: no paint, so the cursor drawn by the last
    // pre-frame render is still there. Option (a) of issue #610 is not costly,
    // it is inert.
    expect(renders).toEqual([]);
    expect(countCursorElements()).toBe(1);
  });

  it("hides the cursor as soon as the same gate is applied outside a frame", async () => {
    // The control case: the gate itself works (ADR-0073). Only the frame is
    // unreachable, which is what makes joining sync-output to it pointless.
    const terminal = await mountRenderedTerminal();
    const suppression = installNativeCursorSuppression(terminal);
    expect(countCursorElements()).toBe(1);

    suppression.setSuppressed(true);
    terminal.refresh(0, terminal.rows - 1);
    await settleRenders();

    expect(countCursorElements()).toBe(0);
  });
});
