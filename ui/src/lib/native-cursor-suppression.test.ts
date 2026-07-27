import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";

import {
  XTERM_NATIVE_CURSOR_FIELDS,
  installNativeCursorSuppression,
  resolveNativeCursorGate,
} from "./native-cursor-suppression";

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

function mountTerminal() {
  stubMatchMedia();
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: 400, configurable: true });
  document.body.appendChild(host);
  const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 25 });
  terminal.open(host);
  mounted.push(terminal);
  return terminal;
}

/**
 * The exact field the renderers gate the cursor on, reached by walking the
 * exported field list rather than a second hardcoded path — so this helper and
 * the module cannot drift apart.
 */
function rendererSeesCursorHidden(terminal: Terminal): boolean {
  const path = XTERM_NATIVE_CURSOR_FIELDS as readonly string[];
  let value: unknown = terminal;
  for (const hop of path) {
    if (value === null || typeof value !== "object") return false;
    value = (value as Record<string, unknown>)[hop];
  }
  return value === true;
}

function decPrivateCursorStyle(terminal: Terminal): string | undefined {
  const core = (
    terminal as Terminal & {
      _core?: { coreService?: { decPrivateModes?: { cursorStyle?: string } } };
    }
  )._core;
  return core?.coreService?.decPrivateModes?.cursorStyle;
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

afterEach(() => {
  while (mounted.length) mounted.pop()?.dispose();
  document.body.replaceChildren();
});

describe("installNativeCursorSuppression", () => {
  it("reports unsupported instead of guessing when xterm's shape changed", () => {
    // Policy: turn ourselves off, never fall back to the colour disguise.
    const suppression = installNativeCursorSuppression({} as Terminal);
    expect(suppression.supported).toBe(false);
    suppression.setSuppressed(true);
    expect(suppression.suppressed).toBe(false);
  });

  it("resolves XTERM_NATIVE_CURSOR_FIELDS against a real Terminal down to a boolean gate", () => {
    // Asserting the constant against its own literal would prove nothing about
    // xterm. Walk it on a live instance instead: if a bump moves or renames any
    // hop, this fails naming the constant, which is what the ADR and the module
    // docstring claim happens.
    const terminal = mountTerminal();
    const path = XTERM_NATIVE_CURSOR_FIELDS as readonly string[];
    let value: unknown = terminal;
    for (const hop of path) {
      expect(value, `XTERM_NATIVE_CURSOR_FIELDS: no object to read "${hop}" from`).toBeTypeOf(
        "object",
      );
      expect(value, `XTERM_NATIVE_CURSOR_FIELDS: no object to read "${hop}" from`).not.toBeNull();
      expect(
        Object.prototype.hasOwnProperty.call(value as object, hop) ||
          hop in (value as Record<string, unknown>),
        `XTERM_NATIVE_CURSOR_FIELDS: xterm no longer exposes "${hop}"`,
      ).toBe(true);
      value = (value as Record<string, unknown>)[hop];
    }
    expect(value, "XTERM_NATIVE_CURSOR_FIELDS: the gate is no longer a boolean").toBeTypeOf(
      "boolean",
    );

    // The resolver the installer itself uses agrees, and points at the owner of
    // the leaf rather than the leaf.
    const gate = resolveNativeCursorGate(terminal);
    expect(gate).not.toBeNull();
    expect(gate?.field).toBe(path[path.length - 1]);
    expect(gate?.owner[gate.field]).toBe(value);
  });

  it("refuses to resolve a gate when a hop is missing", () => {
    expect(resolveNativeCursorGate({} as Terminal)).toBeNull();
    expect(
      resolveNativeCursorGate({ _core: { coreService: {} } } as unknown as Terminal),
    ).toBeNull();
  });

  it("hides the cursor for the renderer without claiming the app hid it", () => {
    const terminal = mountTerminal();
    const suppression = installNativeCursorSuppression(terminal);
    expect(suppression.supported).toBe(true);
    expect(rendererSeesCursorHidden(terminal)).toBe(false);

    suppression.setSuppressed(true);

    expect(rendererSeesCursorHidden(terminal)).toBe(true);
    // ADR-0011: the shadow cursor treats the app's DECTCEM as authoritative.
    // Suppression must not forge a hide the app never sent.
    expect(suppression.appCursorHidden).toBe(false);
  });

  it("stays hidden through the app's per-frame DECTCEM park", async () => {
    // Codex parks its caret with `?25l` CUP `?25h` after every frame. The show
    // half assigns the very field the renderer reads.
    const terminal = mountTerminal();
    const suppression = installNativeCursorSuppression(terminal);
    suppression.setSuppressed(true);

    await write(terminal, "\x1b[?25l\x1b[3;4H\x1b[?25h");

    expect(rendererSeesCursorHidden(terminal)).toBe(true);
    expect(suppression.appCursorHidden).toBe(false);
  });

  it("stays hidden whatever the cell background and DECSCUSR say", async () => {
    // The two premises #598 broke: an app-painted cell background and an
    // app-owned cursor shape. Neither reaches the gate we suppress at.
    const terminal = mountTerminal();
    const suppression = installNativeCursorSuppression(terminal);
    suppression.setSuppressed(true);

    // Codex's input box: rgb(41,41,41) background, then DECSCUSR every frame.
    await write(terminal, "\x1b[48;2;41;41;41m      \x1b[2 q");
    expect(decPrivateCursorStyle(terminal)).toBe("block");
    expect(rendererSeesCursorHidden(terminal)).toBe(true);

    await write(terminal, "\x1b[0 q");
    expect(decPrivateCursorStyle(terminal)).toBeUndefined();
    expect(rendererSeesCursorHidden(terminal)).toBe(true);

    // Options are the app's to override, which is why we no longer rely on them.
    expect(terminal.options.cursorStyle).not.toBe("none");
  });

  it("hands the field back when suppression is released", async () => {
    const terminal = mountTerminal();
    const suppression = installNativeCursorSuppression(terminal);
    suppression.setSuppressed(true);
    suppression.setSuppressed(false);

    expect(rendererSeesCursorHidden(terminal)).toBe(false);

    await write(terminal, "\x1b[?25l");
    expect(rendererSeesCursorHidden(terminal)).toBe(true);
    expect(suppression.appCursorHidden).toBe(true);
  });

  it("keeps the app's DECTCEM hide visible through suppression", async () => {
    const terminal = mountTerminal();
    const suppression = installNativeCursorSuppression(terminal);

    await write(terminal, "\x1b[?25l");
    suppression.setSuppressed(true);
    suppression.setSuppressed(false);

    // Releasing suppression must not turn the app's own hide into a show.
    expect(suppression.appCursorHidden).toBe(true);
    expect(rendererSeesCursorHidden(terminal)).toBe(true);
  });

  it("restores a plain writable field on dispose", async () => {
    const terminal = mountTerminal();
    const suppression = installNativeCursorSuppression(terminal);
    await write(terminal, "\x1b[?25l");
    suppression.setSuppressed(true);

    suppression.dispose();

    expect(suppression.supported).toBe(false);
    expect(rendererSeesCursorHidden(terminal)).toBe(true);
    await write(terminal, "\x1b[?25h");
    expect(rendererSeesCursorHidden(terminal)).toBe(false);
    // A disposed handle must not resurrect the gate on a live terminal.
    suppression.setSuppressed(true);
    expect(rendererSeesCursorHidden(terminal)).toBe(false);
  });
});

describe("xterm native cursor contract", () => {
  it("gates the cursor on coreService.isCursorHidden and lets DECTCEM write it", async () => {
    const terminal = mountTerminal();
    expect(rendererSeesCursorHidden(terminal)).toBe(false);

    await write(terminal, "\x1b[?25l");
    expect(rendererSeesCursorHidden(terminal)).toBe(true);

    await write(terminal, "\x1b[?25h");
    expect(rendererSeesCursorHidden(terminal)).toBe(false);
  });

  it("lets DECSCUSR outrank options.cursorStyle — the shape is never ours", async () => {
    // The measured cause of #598's block: `decPrivateModes.cursorStyle` wins, so
    // writing `options.cursorStyle = "bar"` is not a way to hide anything.
    const terminal = mountTerminal();
    terminal.options.cursorStyle = "bar";

    await write(terminal, "\x1b[2 q");

    expect(terminal.options.cursorStyle).toBe("bar");
    expect(decPrivateCursorStyle(terminal)).toBe("block");
  });
});
