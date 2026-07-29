import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";

import {
  XTERM_PENDING_COMPOSITION_FIELDS,
  readPendingCompositionSend,
} from "./xterm-pending-composition";
import { createTerminalFocusOwnership } from "./terminal-focus-ownership";

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
  const helper = host.querySelector(".xterm-helper-textarea") as HTMLTextAreaElement;
  return { terminal, helper };
}

/** Compose one Hangul syllable and commit it, leaving the send pending. */
function composeAndCommit(helper: HTMLTextAreaElement, syllable = "가") {
  helper.focus();
  helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
  helper.value = syllable;
  helper.selectionStart = syllable.length;
  helper.selectionEnd = syllable.length;
  helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: syllable }));
  helper.dispatchEvent(new CompositionEvent("compositionend", { data: syllable }));
}

const flushFinalizer = () => new Promise((resolve) => setTimeout(resolve, 5));

const writeTerminal = (terminal: Terminal, data: string) =>
  new Promise<void>((resolve) => terminal.write(data, resolve));

function readXtermComposing(terminal: Terminal): boolean {
  return (
    terminal as Terminal & { _core?: { _compositionHelper?: { _isComposing?: unknown } } }
  )._core?._compositionHelper?._isComposing === true;
}

afterEach(async () => {
  // Some blur-contract cases intentionally leave xterm's private composition
  // flag set after their assertions. End that synthetic composition before
  // dispose so CompositionHelper's queued position-update timer cannot run
  // against a torn-down render service under a busy, parallel full-suite run.
  for (const terminal of mounted) {
    if (readXtermComposing(terminal)) {
      terminal.textarea?.dispatchEvent(new CompositionEvent("compositionend", { data: "" }));
    }
  }
  await flushFinalizer();
  while (mounted.length) mounted.pop()?.dispose();
  document.body.replaceChildren();
});

describe("xterm app-focus recovery with a new IME composition (issue #620)", () => {
  it("cancels the queued refresh without extra focus reports and commits once", async () => {
    const { terminal, helper } = mountTerminal();
    await writeTerminal(terminal, "\x1b[?1004h");

    const data: string[] = [];
    terminal.onData((value) => data.push(value));
    helper.focus();
    expect(data).toEqual(["\x1b[I"]);
    data.length = 0;

    let reclaimFrame: (() => void) | undefined;
    const ownership = createTerminalFocusOwnership({
      getContainer: () => terminal.element,
      refreshActiveHelper: true,
      scheduleFrame: (callback) => {
        reclaimFrame = callback;
      },
    });
    helper.addEventListener("compositionstart", () => ownership.releaseForHelperInput(helper));

    // WebView2 can leave the helper DOM-active across app deactivation. The
    // focus controller schedules a blur/focus refresh, but a real IME can start
    // using the recovered helper before that next animation frame arrives.
    expect(ownership.captureOnAppBlur()).toBe(true);
    expect(ownership.reclaimOnAppFocus()).toBe(true);
    expect(reclaimFrame).toBeTypeOf("function");

    helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    helper.value = "ㄱ";
    helper.selectionStart = 1;
    helper.selectionEnd = 1;
    helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ㄱ" }));
    helper.dispatchEvent(new Event("input", { bubbles: true }));

    reclaimFrame?.();

    // A late refresh would make real xterm emit DEC focus-out/focus-in reports
    // and clear the helper value in its blur handler, interrupting this new IME
    // composition. Input ownership must cancel that frame instead.
    expect(data).toEqual([]);
    expect(document.activeElement).toBe(helper);
    expect(helper.value).toBe("ㄱ");

    helper.value = "가";
    helper.selectionStart = 1;
    helper.selectionEnd = 1;
    helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "가" }));
    helper.dispatchEvent(new CompositionEvent("compositionend", { data: "가" }));
    await flushFinalizer();

    expect(data).toEqual(["가"]);
    expect(document.activeElement).toBe(helper);
    ownership.dispose();
  });
});

describe("xterm pending-composition contract", () => {
  it("exposes the pending flag used by blur recovery", () => {
    // A version bump must not silently disable issue #555's blur recovery.
    const { terminal, helper } = mountTerminal();
    composeAndCommit(helper);

    const pending = readPendingCompositionSend(terminal);
    expect(pending).not.toBeNull();
    expect(pending!.pending).toBe(true);
  });

  it("names the fields it depends on so a break is readable", () => {
    expect(XTERM_PENDING_COMPOSITION_FIELDS).toEqual([
      "_compositionHelper",
      "_isSendingComposition",
    ]);
  });

  it("reports no pending send once the finalizer has run", async () => {
    const { terminal, helper } = mountTerminal();
    composeAndCommit(helper);
    await flushFinalizer();

    expect(readPendingCompositionSend(terminal)?.pending).toBe(false);
  });

  it("returns null for an object that is not a terminal", () => {
    expect(readPendingCompositionSend({} as never)).toBeNull();
  });
});

describe("xterm blur contract during composition (issue #555)", () => {
  /**
   * The load-bearing assumption behind committing an interrupted composition
   * ourselves. If a future xterm starts sending the in-flight text on blur, our
   * commit becomes a duplicate — so these assertions have to fail loudly rather
   * than let the duplication ship.
   */
  it("sends nothing and clears the textarea when a blur interrupts a composition", async () => {
    const { terminal, helper } = mountTerminal();
    const data: string[] = [];
    terminal.onData((d) => data.push(d));

    helper.focus();
    helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    helper.value = "\uac00";
    helper.selectionStart = 1;
    helper.selectionEnd = 1;
    helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\uac00" }));
    helper.dispatchEvent(new Event("input"));
    expect(helper.value).toBe("\uac00");

    helper.dispatchEvent(new Event("blur"));
    await flushFinalizer();

    // Nothing reached the PTY, and the only copy of the text is gone.
    expect(data).toEqual([]);
    expect(helper.value).toBe("");
    // xterm also leaves its own composition flag set, which is why the controller
    // still has to reset on blur even now that it commits.
    expect(readXtermComposing(terminal)).toBe(true);
  });

  it("cannot recover the text from a compositionend that arrives after the blur", async () => {
    // Slice source already empty, so the deferred finalizer has nothing to send.
    const { terminal, helper } = mountTerminal();
    const data: string[] = [];
    terminal.onData((d) => data.push(d));

    helper.focus();
    helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    helper.value = "\uac00";
    helper.selectionStart = 1;
    helper.selectionEnd = 1;
    helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\uac00" }));
    helper.dispatchEvent(new Event("input"));
    helper.dispatchEvent(new Event("blur"));
    await flushFinalizer();

    helper.dispatchEvent(new CompositionEvent("compositionend", { data: "\uac00" }));
    await flushFinalizer();

    expect(data).toEqual([]);
  });

  it("loses the text when the blur lands inside the deferred send window", async () => {
    // The ordering the real WebView2 + Windows IME produces, and the sole basis for
    // keying the blur commit off xterm's pending flag: `compositionend` schedules the
    // finalizer, the blur clears the textarea before it runs, and the slice comes out
    // empty. If a future xterm ever sends here, the controller's commit becomes a
    // duplicate on every focus change — so this has to fail loudly rather than let
    // that ship.
    const { terminal, helper } = mountTerminal();
    const data: string[] = [];
    terminal.onData((d) => data.push(d));

    helper.focus();
    helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    helper.value = "\uac00";
    helper.selectionStart = 1;
    helper.selectionEnd = 1;
    helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\uac00" }));
    helper.dispatchEvent(new Event("input"));
    helper.dispatchEvent(new CompositionEvent("compositionend", { data: "\uac00" }));

    // The send is scheduled but has not run.
    expect(readPendingCompositionSend(terminal)?.pending).toBe(true);

    helper.dispatchEvent(new Event("blur"));
    // Still pending, and the source xterm would slice is already gone.
    expect(readPendingCompositionSend(terminal)?.pending).toBe(true);
    expect(helper.value).toBe("");

    await flushFinalizer();
    expect(data).toEqual([]);
    expect(readPendingCompositionSend(terminal)?.pending).toBe(false);
  });
  it("does send it when compositionend comes before the blur", async () => {
    // The ordering where xterm really does send. The controller stays out of this path
    // by reading xterm's pending flag — NOT by its own phase, which is
    // `pending-finalize` in both this ordering and the losing one above. An earlier form
    // of this comment claimed the phase check was load-bearing; it was wrong, and the
    // measurement in the previous test is what corrected it.
    const { terminal, helper } = mountTerminal();
    const data: string[] = [];
    terminal.onData((d) => data.push(d));

    composeAndCommit(helper, "\uac00");
    await flushFinalizer();
    expect(data).toEqual(["\uac00"]);

    helper.dispatchEvent(new Event("blur"));
    await flushFinalizer();

    // Still exactly once — the blur itself adds nothing.
    expect(data).toEqual(["\uac00"]);
  });
});
