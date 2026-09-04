import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";

type PatchedCompositionHelper = {
  _compositionPosition: { start: number };
  _dataAlreadySent: string;
  _isSendingComposition: boolean;
  _textarea: HTMLTextAreaElement;
};

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

function openTerminal() {
  stubMatchMedia();
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: 400, configurable: true });
  document.body.appendChild(host);

  const terminal = new Terminal({ allowProposedApi: true, cols: 80, rows: 25 });
  terminal.open(host);
  mounted.push(terminal);

  const textarea = terminal.textarea;
  if (!textarea) throw new Error("xterm helper textarea was not created");
  const emitted: string[] = [];
  terminal.onData((data) => emitted.push(data));
  return { emitted, terminal, textarea };
}

function readCompositionHelper(terminal: Terminal): PatchedCompositionHelper {
  return (
    terminal as Terminal & {
      _core: { _compositionHelper: PatchedCompositionHelper };
    }
  )._core._compositionHelper;
}

/**
 * Mirrors the superseded ADR-0062 TerminalView guard for one contrast case.
 * It can only inspect the textarea before xterm's deferred finalizer runs.
 */
function attachSupersededExternalGuard(terminal: Terminal, textarea: HTMLTextAreaElement) {
  let capturedStart: number | null = null;
  textarea.addEventListener("compositionstart", () => {
    capturedStart = null;
  });
  textarea.addEventListener("compositionend", () => {
    capturedStart = readCompositionHelper(terminal)._compositionPosition.start;
  });
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keypress" || capturedStart === null) return true;
    const helper = readCompositionHelper(terminal);
    if (!helper._isSendingComposition) return true;
    const candidate = helper._textarea.value.slice(capturedStart + helper._dataAlreadySent.length);
    if (!candidate || !candidate.endsWith(event.key)) return true;
    event.preventDefault();
    return false;
  });
}

function startComposition(textarea: HTMLTextAreaElement, text: string) {
  textarea.focus();
  textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
  textarea.value = text;
  textarea.selectionStart = text.length;
  textarea.selectionEnd = text.length;
  textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: text, bubbles: true }));
}

function endComposition(textarea: HTMLTextAreaElement, text: string) {
  textarea.dispatchEvent(new CompositionEvent("compositionend", { data: text, bubbles: true }));
}

function dispatchKeypress(textarea: HTMLTextAreaElement, text: string) {
  const keypress = new KeyboardEvent("keypress", {
    key: text,
    bubbles: true,
    cancelable: true,
  });
  // jsdom omits Chromium's legacy charCode field that xterm 6.0.0 still reads.
  Object.defineProperty(keypress, "charCode", { value: text.charCodeAt(0) });
  Object.defineProperty(keypress, "keyCode", { value: 0 });
  textarea.dispatchEvent(keypress);
  return keypress;
}

function dispatchKeydown(
  textarea: HTMLTextAreaElement,
  key: string,
  code: string,
  keyCode: number,
) {
  const keydown = new KeyboardEvent("keydown", { key, code, bubbles: true, cancelable: true });
  Object.defineProperty(keydown, "keyCode", { value: keyCode });
  textarea.dispatchEvent(keydown);
}

const flushEventLoop = () => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(async () => {
  await flushEventLoop();
  while (mounted.length) mounted.pop()?.dispose();
  document.body.replaceChildren();
});

describe("patched xterm composition keypress reconciliation", () => {
  it("keeps an ordinary non-composition keypress on the immediate path", () => {
    const { emitted, textarea } = openTerminal();

    const keypress = dispatchKeypress(textarea, "a");

    expect(keypress.defaultPrevented).toBe(false);
    expect(emitted).toEqual(["a"]);
  });

  it("keeps ordinary insertText input on the immediate path", () => {
    const { emitted, textarea } = openTerminal();

    textarea.dispatchEvent(
      new InputEvent("input", { data: "a", inputType: "insertText", bubbles: true }),
    );

    expect(emitted).toEqual(["a"]);
  });

  it("restores a racing Hangul keypress after compositionend cleared the textarea", async () => {
    const { emitted, terminal, textarea } = openTerminal();
    attachSupersededExternalGuard(terminal, textarea);
    startComposition(textarea, "한");
    await flushEventLoop();

    // IBus/WebView2 can clear the helper at compositionend and restore the same
    // candidate through input after legacy keypress. ADR-0062's external suffix
    // guard cannot suppress this sequence because its pending slice is empty at
    // keypress time; the xterm state machine must hold and reconcile the text.
    textarea.value = "";
    endComposition(textarea, "한");
    const helper = readCompositionHelper(terminal);
    expect(helper._isSendingComposition).toBe(true);

    dispatchKeypress(textarea, "한");
    expect(emitted).toEqual([]);

    textarea.value = "한";
    textarea.dispatchEvent(
      new InputEvent("input", { data: "한", inputType: "insertText", bubbles: true }),
    );
    await flushEventLoop();

    expect(emitted.join("")).toBe("한");
  });

  it("keeps composition-first order when the keypress overlaps the candidate suffix", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "가한");
    await flushEventLoop();

    endComposition(textarea, "가한");
    dispatchKeypress(textarea, "한");
    await flushEventLoop();

    expect(emitted.join("")).toBe("가한");
  });

  it("emits an unmatched keypress before the propagated composition candidate", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "한");
    await flushEventLoop();

    textarea.value = "a";
    textarea.selectionStart = 1;
    textarea.selectionEnd = 1;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "a", bubbles: true }));
    endComposition(textarea, "a");
    dispatchKeypress(textarea, "한");
    await flushEventLoop();

    expect(emitted.join("")).toBe("한a");
  });

  it("does not repeat a keypress already contained in the composition candidate", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "한");
    await flushEventLoop();

    textarea.value = "한a";
    textarea.selectionStart = 2;
    textarea.selectionEnd = 2;
    textarea.dispatchEvent(
      new CompositionEvent("compositionupdate", { data: "한a", bubbles: true }),
    );
    endComposition(textarea, "한a");
    dispatchKeypress(textarea, "한");
    await flushEventLoop();

    expect(emitted.join("")).toBe("한a");
  });

  it("merges multiple deferred keypresses with partial candidate overlap", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "한");
    await flushEventLoop();

    endComposition(textarea, "한");
    dispatchKeypress(textarea, "a");
    dispatchKeypress(textarea, "b");
    textarea.value = "한a";
    await flushEventLoop();

    expect(emitted.join("")).toBe("한ab");
  });

  it("keeps multiple unmatched keypresses ordered before the candidate", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "한");
    await flushEventLoop();

    endComposition(textarea, "한");
    dispatchKeypress(textarea, "a");
    dispatchKeypress(textarea, "b");
    await flushEventLoop();

    expect(emitted.join("")).toBe("ab한");
  });

  it("reconciles buffered keypress text before an ordinary keydown finalizes immediately", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "한");
    await flushEventLoop();

    textarea.value = "";
    endComposition(textarea, "한");
    dispatchKeypress(textarea, "한");
    textarea.value = "한";
    textarea.selectionStart = 1;
    textarea.selectionEnd = 1;
    dispatchKeydown(textarea, "a", "KeyA", 65);
    await flushEventLoop();

    expect(emitted.join("")).toBe("한a");
  });

  it("reconciles input propagation before the matching legacy keypress", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "한");
    await flushEventLoop();

    textarea.value = "";
    endComposition(textarea, "한");
    textarea.value = "한";
    textarea.dispatchEvent(
      new InputEvent("input", { data: "한", inputType: "insertText", bubbles: true }),
    );
    dispatchKeypress(textarea, "한");
    await flushEventLoop();

    expect(emitted.join("")).toBe("한");
  });

  it("prevents a consumed legacy keypress from default-inserting after a separator", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "면");
    await flushEventLoop();

    endComposition(textarea, "면");
    textarea.value = "면 ";
    textarea.selectionStart = 2;
    textarea.selectionEnd = 2;
    textarea.dispatchEvent(
      new InputEvent("input", { data: " ", inputType: "insertText", bubbles: true }),
    );
    const propagatedKeypress = dispatchKeypress(textarea, "면");

    // jsdom does not execute keypress default actions. Model WebView2 inserting
    // the propagated syllable only when xterm leaves the event uncancelled.
    if (!propagatedKeypress.defaultPrevented) {
      textarea.value = "면 면";
      textarea.selectionStart = 3;
      textarea.selectionEnd = 3;
    }
    await flushEventLoop();

    expect(propagatedKeypress.defaultPrevented).toBe(true);
    expect(emitted.join("")).toBe("면 ");
  });

  it("emits an input-only propagated composition exactly once", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "한");
    await flushEventLoop();

    textarea.value = "";
    endComposition(textarea, "한");
    textarea.value = "한";
    textarea.dispatchEvent(
      new InputEvent("input", { data: "한", inputType: "insertText", bubbles: true }),
    );
    await flushEventLoop();

    expect(emitted.join("")).toBe("한");
  });

  it("keeps consecutive composition generations isolated before either timer flushes", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "한");
    await flushEventLoop();

    textarea.value = "";
    endComposition(textarea, "한");
    dispatchKeypress(textarea, "한");

    startComposition(textarea, "글");
    endComposition(textarea, "글");
    dispatchKeypress(textarea, "글");
    await flushEventLoop();

    expect(emitted.join("")).toBe("한글");
  });

  it("keeps the full commit when Windows IME replaces retained textarea text", async () => {
    const { emitted, textarea } = openTerminal();
    textarea.focus();
    textarea.value = "이미 전송된 긴 입력";
    textarea.selectionStart = textarea.value.length;
    textarea.selectionEnd = textarea.value.length;

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    textarea.value += "수";
    textarea.dispatchEvent(
      new CompositionEvent("compositionupdate", { data: "수", bubbles: true }),
    );
    await flushEventLoop();

    // Windows TSF can select the whole helper textarea and replace it. The
    // composition start offset now points beyond the new value.
    textarea.value = "수정을 해야 할거 아냐";
    textarea.selectionStart = 0;
    textarea.selectionEnd = textarea.value.length;
    textarea.dispatchEvent(
      new CompositionEvent("compositionupdate", { data: textarea.value, bubbles: true }),
    );
    await flushEventLoop();
    endComposition(textarea, textarea.value);
    await flushEventLoop();

    expect(emitted.join("")).toBe("수정을 해야 할거 아냐");
  });

  it("keeps consecutive generations separate when the next composition replaces the textarea", async () => {
    const { emitted, textarea } = openTerminal();

    startComposition(textarea, "가");
    endComposition(textarea, "가");
    startComposition(textarea, "나");
    endComposition(textarea, "나");
    await flushEventLoop();

    expect(emitted.join("")).toBe("가나");
  });

  it("flushes input-first reconciliation once before an interleaved ordinary keydown", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "한");
    await flushEventLoop();

    textarea.value = "";
    endComposition(textarea, "한");
    textarea.value = "한";
    textarea.selectionStart = 1;
    textarea.selectionEnd = 1;
    textarea.dispatchEvent(
      new InputEvent("input", { data: "한", inputType: "insertText", bubbles: true }),
    );
    dispatchKeypress(textarea, "한");
    dispatchKeydown(textarea, "a", "KeyA", 65);
    await flushEventLoop();

    expect(emitted.join("")).toBe("한a");
  });

  it("does not duplicate Hangul when a pre-composition 229 diff timer fires after compositionend", async () => {
    // Windows IME delivers keydown 229 before compositionstart. That schedules
    // `_handleAnyTextareaChanges` with setTimeout(0). A main-thread stall
    // (output flood) lets compositionend run first, so the deferred diff sees
    // `!_isComposing` and sends the same syllable the finalizer will send.
    const { emitted, textarea } = openTerminal();
    textarea.focus();
    dispatchKeydown(textarea, "Process", "Process", 229);
    startComposition(textarea, "가");
    endComposition(textarea, "가");
    textarea.dispatchEvent(
      new InputEvent("input", { data: "가", inputType: "insertText", bubbles: true }),
    );
    await flushEventLoop();

    expect(emitted.join("")).toBe("가");
  });

  it("does not replay Hangul after an immediate finalize from a following keydown", async () => {
    // 229 schedules the textarea-diff timer, compositionend queues the
    // delayed finalizer, then a real keydown force-finalizes and clears
    // `_isSendingComposition`. The earlier timer must not send `가` again
    // after that (`가a가`).
    const { emitted, textarea } = openTerminal();
    textarea.focus();
    dispatchKeydown(textarea, "Process", "Process", 229);
    startComposition(textarea, "가");
    endComposition(textarea, "가");
    dispatchKeydown(textarea, "a", "KeyA", 65);
    await flushEventLoop();

    expect(emitted.join("")).toBe("가a");
  });

  it("still forwards a 229 textarea insertion when no composition starts", async () => {
    const { emitted, textarea } = openTerminal();
    textarea.focus();
    dispatchKeydown(textarea, "Process", "Process", 229);
    textarea.value = "2";
    textarea.selectionStart = 1;
    textarea.selectionEnd = 1;
    await flushEventLoop();

    expect(emitted.join("")).toBe("2");
  });
});
