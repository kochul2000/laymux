import { createRequire } from "node:module";
import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";

const { Terminal: RemoteTerminal } = createRequire(import.meta.url)(
  "../../../src-tauri/src/remote_server/assets/xterm.js",
) as { Terminal: typeof Terminal };

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

function openTerminalWith(TerminalConstructor: typeof Terminal) {
  stubMatchMedia();
  const host = document.createElement("div");
  Object.defineProperty(host, "clientWidth", { value: 800, configurable: true });
  Object.defineProperty(host, "clientHeight", { value: 400, configurable: true });
  document.body.appendChild(host);

  const terminal = new TerminalConstructor({ allowProposedApi: true, cols: 80, rows: 25 });
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
  return keydown;
}

function dispatchKeyup(textarea: HTMLTextAreaElement, key: string, code: string, keyCode: number) {
  const keyup = new KeyboardEvent("keyup", { key, code, bubbles: true });
  Object.defineProperty(keyup, "keyCode", { value: keyCode });
  textarea.dispatchEvent(keyup);
}

const flushEventLoop = () => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(async () => {
  await flushEventLoop();
  while (mounted.length) mounted.pop()?.dispose();
  document.body.replaceChildren();
});

describe.each([
  ["desktop", Terminal],
  ["remote", RemoteTerminal],
] as const)("%s xterm composition keypress reconciliation", (_surface, TerminalConstructor) => {
  const openTerminal = () => openTerminalWith(TerminalConstructor);
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

  it("does not replay a composition after Space keydown and native default insertion", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "이미");
    await flushEventLoop();

    const keydown = dispatchKeydown(textarea, " ", "Space", 32);
    const keypress = dispatchKeypress(textarea, " ");
    // jsdom does not apply the browser's keypress default action. A physical
    // Space can remain in the textarea after xterm already forwarded that key.
    if (!keydown.defaultPrevented && !keypress.defaultPrevented) {
      textarea.value += " ";
      textarea.dispatchEvent(
        new InputEvent("input", { data: " ", inputType: "insertText", bubbles: true }),
      );
    }
    endComposition(textarea, "이미");
    await flushEventLoop();

    expect(emitted.join("")).toBe("이미 ");
  });

  it("does not restore a committed word after Enter clears the textarea", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "이미");
    await flushEventLoop();

    dispatchKeydown(textarea, "Enter", "Enter", 13);
    expect(textarea.value).toBe("");
    endComposition(textarea, "이미");
    await flushEventLoop();

    expect(emitted.join("")).toBe("이미\r");
  });

  it("preserves the unsent suffix in a later composition commit", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "한");
    await flushEventLoop();

    dispatchKeydown(textarea, "ArrowRight", "ArrowRight", 39);
    textarea.value = "한글";
    endComposition(textarea, "한글");
    await flushEventLoop();

    expect(emitted.join("")).toBe("한\x1b[C글");
  });

  it("preserves the same word in the next composition before the previous timer flushes", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "이미");
    await flushEventLoop();

    dispatchKeydown(textarea, " ", "Space", 32);
    dispatchKeypress(textarea, " ");
    endComposition(textarea, "이미");
    startComposition(textarea, "이미");
    endComposition(textarea, "이미");
    await flushEventLoop();

    expect(emitted.join("")).toBe("이미 이미");
  });

  it("discards late compositionend after blur without swallowing the next physical key", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "이미");
    await flushEventLoop();

    dispatchKeydown(textarea, " ", "Space", 32);
    dispatchKeypress(textarea, " ");
    textarea.blur();
    endComposition(textarea, "이미");
    textarea.focus();
    const keydown = dispatchKeydown(textarea, "x", "KeyX", 88);
    if (!keydown.defaultPrevented) dispatchKeypress(textarea, "x");
    await flushEventLoop();

    expect(emitted.join("")).toBe("이미 x");
  });

  it("does not deduplicate repeated physical keys outside a composition", async () => {
    const { emitted, textarea } = openTerminal();
    textarea.focus();
    for (let index = 0; index < 2; index++) {
      const keydown = dispatchKeydown(textarea, "a", "KeyA", 65);
      if (!keydown.defaultPrevented) dispatchKeypress(textarea, "a");
    }
    await flushEventLoop();

    expect(emitted.join("")).toBe("aa");
  });

  it.each([false, true])(
    "reconciles input before native end with the provisional timer flushed=%s",
    async (flushBeforeEnd) => {
      const { emitted, textarea } = openTerminal();
      startComposition(textarea, "한");
      await flushEventLoop();

      dispatchKeydown(textarea, "ArrowRight", "ArrowRight", 39);
      textarea.value = "한글";
      textarea.dispatchEvent(
        new InputEvent("input", { data: "글", inputType: "insertText", bubbles: true }),
      );
      if (flushBeforeEnd) {
        await flushEventLoop();
        // An input-only continuation must be delivered without waiting for native end.
        expect(emitted.join("")).toBe("한\x1b[C글");
      }
      endComposition(textarea, "한글");
      await flushEventLoop();

      expect(emitted.join("")).toBe("한\x1b[C글");
    },
  );

  it.each([false, true])(
    "preserves repeated suffix input with a timer between observations=%s",
    async (flushBetweenInputs) => {
      const { emitted, textarea } = openTerminal();
      startComposition(textarea, "한");
      await flushEventLoop();

      dispatchKeydown(textarea, "ArrowRight", "ArrowRight", 39);
      for (const text of ["한글", "한글글"]) {
        textarea.value = text;
        textarea.dispatchEvent(
          new InputEvent("input", { data: "글", inputType: "insertText", bubbles: true }),
        );
        if (flushBetweenInputs) await flushEventLoop();
      }
      endComposition(textarea, "한글글");
      await flushEventLoop();

      expect(emitted.join("")).toBe("한\x1b[C글글");
    },
  );

  it("preserves ordinary physical text between Enter and the late native end", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "이미");
    await flushEventLoop();

    dispatchKeydown(textarea, "Enter", "Enter", 13);
    for (let index = 0; index < 2; index++) {
      const keydown = dispatchKeydown(textarea, "a", "KeyA", 65);
      if (!keydown.defaultPrevented) dispatchKeypress(textarea, "a");
    }
    endComposition(textarea, "이미");
    await flushEventLoop();

    expect(emitted.join("")).toBe("이미\raa");
  });

  it.each([false, true])(
    "preserves input-only text after Enter clears the textarea with a timer before end=%s",
    async (flushBeforeEnd) => {
      const { emitted, textarea } = openTerminal();
      startComposition(textarea, "이미");
      await flushEventLoop();

      dispatchKeydown(textarea, "Enter", "Enter", 13);
      expect(textarea.value).toBe("");
      textarea.value = "a";
      textarea.dispatchEvent(
        new InputEvent("input", { data: "a", inputType: "insertText", bubbles: true }),
      );
      if (flushBeforeEnd) {
        await flushEventLoop();
        expect(emitted.join("")).toBe("이미\ra");
      }
      endComposition(textarea, "이미");
      await flushEventLoop();

      expect(emitted.join("")).toBe("이미\ra");
    },
  );

  it.each(["한글", "다음"])(
    "keeps provisional input and native end isolated from the next composition %s",
    async (nextText) => {
      const { emitted, textarea } = openTerminal();
      startComposition(textarea, "한");
      await flushEventLoop();

      dispatchKeydown(textarea, "ArrowRight", "ArrowRight", 39);
      textarea.value = "한글";
      textarea.dispatchEvent(
        new InputEvent("input", { data: "글", inputType: "insertText", bubbles: true }),
      );
      endComposition(textarea, "한글");
      startComposition(textarea, nextText);
      endComposition(textarea, nextText);
      await flushEventLoop();

      expect(emitted.join("")).toBe(`한\x1b[C글${nextText}`);
    },
  );

  describe.each([
    ["a", "a"],
    ["한", "한글"],
  ])("ordinary input %s → %s across an Enter clear", (word, inserted) => {
    it.each([false, true])(
      "preserves the input with a timer before end=%s",
      async (flushBeforeEnd) => {
        const { emitted, textarea } = openTerminal();
        startComposition(textarea, word);
        await flushEventLoop();

        dispatchKeydown(textarea, "Enter", "Enter", 13);
        // Native InputEvents are composed. Releasing Enter opens xterm's input gate.
        dispatchKeyup(textarea, "Enter", "Enter", 13);
        expect(textarea.value).toBe("");
        textarea.value = inserted;
        textarea.dispatchEvent(
          new InputEvent("input", {
            data: inserted,
            inputType: "insertText",
            bubbles: true,
            composed: true,
          }),
        );
        if (flushBeforeEnd) {
          await flushEventLoop();
          expect(emitted.join("")).toBe(`${word}\r${inserted}`);
        }
        endComposition(textarea, word);
        await flushEventLoop();

        expect(emitted.join("")).toBe(`${word}\r${inserted}`);
      },
    );
  });

  it("preserves the same input across two explicit textarea clear boundaries", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "한");
    await flushEventLoop();

    for (let index = 0; index < 2; index++) {
      dispatchKeydown(textarea, "Enter", "Enter", 13);
      dispatchKeyup(textarea, "Enter", "Enter", 13);
      expect(textarea.value).toBe("");
      textarea.value = "a";
      textarea.dispatchEvent(
        new InputEvent("input", {
          data: "a",
          inputType: "insertText",
          bubbles: true,
          composed: true,
        }),
      );
      await flushEventLoop();
    }
    endComposition(textarea, "한");
    await flushEventLoop();

    expect(emitted.join("")).toBe("한\ra\ra");
  });

  it.each([false, true])(
    "does not replay IME-owned input after Enter clears the textarea with timer before end=%s",
    async (flushBeforeEnd) => {
      const { emitted, textarea } = openTerminal();
      startComposition(textarea, "이미");
      await flushEventLoop();

      dispatchKeydown(textarea, "Enter", "Enter", 13);
      dispatchKeyup(textarea, "Enter", "Enter", 13);
      textarea.value = "이미";
      textarea.dispatchEvent(
        new InputEvent("input", {
          data: "이미",
          inputType: "insertText",
          isComposing: true,
          bubbles: true,
          composed: true,
        }),
      );
      if (flushBeforeEnd) {
        await flushEventLoop();
        expect(emitted.join("")).toBe("이미\r");
      }
      endComposition(textarea, "이미");
      await flushEventLoop();

      expect(emitted.join("")).toBe("이미\r");
    },
  );

  it("does not replay a native suffix after a later explicit textarea clear", async () => {
    const { emitted, textarea } = openTerminal();
    startComposition(textarea, "한");
    await flushEventLoop();

    dispatchKeydown(textarea, "ArrowRight", "ArrowRight", 39);
    dispatchKeyup(textarea, "ArrowRight", "ArrowRight", 39);
    textarea.value = "한글";
    textarea.dispatchEvent(
      new InputEvent("input", {
        data: "글",
        inputType: "insertText",
        isComposing: true,
        bubbles: true,
        composed: true,
      }),
    );
    await flushEventLoop();
    expect(emitted.join("")).toBe("한\x1b[C글");
    dispatchKeydown(textarea, "Enter", "Enter", 13);
    dispatchKeyup(textarea, "Enter", "Enter", 13);
    endComposition(textarea, "한글");
    await flushEventLoop();

    expect(emitted.join("")).toBe("한\x1b[C글\r");
  });

  it.each([false, true])(
    "preserves repeated IME suffixes after Enter with timer between inputs=%s",
    async (flushBetweenInputs) => {
      const { emitted, textarea } = openTerminal();
      startComposition(textarea, "한");
      await flushEventLoop();

      dispatchKeydown(textarea, "Enter", "Enter", 13);
      dispatchKeyup(textarea, "Enter", "Enter", 13);
      for (const text of ["한글", "한글글"]) {
        textarea.value = text;
        textarea.dispatchEvent(
          new InputEvent("input", {
            data: "글",
            inputType: "insertText",
            isComposing: true,
            bubbles: true,
            composed: true,
          }),
        );
        if (flushBetweenInputs) await flushEventLoop();
      }
      endComposition(textarea, "한글글");
      await flushEventLoop();

      expect(emitted.join("")).toBe("한\r글글");
    },
  );

  describe.each(["ordinary-first", "native-first"] as const)(
    "mixed input ownership after Enter: %s",
    (order) => {
      it.each([false, true])(
        "preserves ordinary text and suppresses native replay with timer between inputs=%s",
        async (flushBetweenInputs) => {
          const { emitted, textarea } = openTerminal();
          startComposition(textarea, "한");
          await flushEventLoop();

          dispatchKeydown(textarea, "Enter", "Enter", 13);
          dispatchKeyup(textarea, "Enter", "Enter", 13);
          const observations = [
            { data: "x", isComposing: false },
            { data: "한", isComposing: true },
          ];
          if (order === "native-first") observations.reverse();
          for (let index = 0; index < observations.length; index++) {
            const observation = observations[index];
            textarea.value = observation.data;
            textarea.dispatchEvent(
              new InputEvent("input", {
                ...observation,
                inputType: "insertText",
                bubbles: true,
                composed: true,
              }),
            );
            if (flushBetweenInputs && index === 0) {
              await flushEventLoop();
              expect(emitted.join("")).toBe(order === "ordinary-first" ? "한\rx" : "한\r");
            }
          }
          endComposition(textarea, "한");
          await flushEventLoop();

          expect(emitted.join("")).toBe("한\rx");
        },
      );
    },
  );
});
