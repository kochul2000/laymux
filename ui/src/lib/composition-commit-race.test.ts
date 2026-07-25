import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it } from "vitest";

import {
  decideCommitRace,
  isDuplicateOfPendingCommit,
  keypressText,
  resolvePendingCommitText,
} from "./composition-commit-race";
import {
  XTERM_PENDING_COMPOSITION_FIELDS,
  readPendingCompositionSend,
} from "./xterm-pending-composition";

// ---------------------------------------------------------------------------
// Pure decision
// ---------------------------------------------------------------------------

describe("resolvePendingCommitText", () => {
  it("slices the same range xterm's finalizer will read", () => {
    expect(
      resolvePendingCommitText({
        textareaValue: "가",
        compositionStart: 0,
        dataAlreadySentLength: 0,
      }),
    ).toBe("가");
  });

  it("skips text the finalizer already sent", () => {
    expect(
      resolvePendingCommitText({
        textareaValue: "안녕하세요",
        compositionStart: 0,
        dataAlreadySentLength: 2,
      }),
    ).toBe("하세요");
  });

  it("returns empty for a start past the end of the value", () => {
    expect(
      resolvePendingCommitText({
        textareaValue: "가",
        compositionStart: 5,
        dataAlreadySentLength: 0,
      }),
    ).toBe("");
  });

  it("returns empty for nonsense offsets instead of throwing", () => {
    expect(
      resolvePendingCommitText({
        textareaValue: "가",
        compositionStart: Number.NaN,
        dataAlreadySentLength: 0,
      }),
    ).toBe("");
    expect(
      resolvePendingCommitText({
        textareaValue: "가",
        compositionStart: -3,
        dataAlreadySentLength: 0,
      }),
    ).toBe("");
  });
});

describe("isDuplicateOfPendingCommit", () => {
  it("treats identical text as a duplicate", () => {
    expect(isDuplicateOfPendingCommit("가", "가")).toBe(true);
  });

  it("treats a contained character as a duplicate", () => {
    expect(isDuplicateOfPendingCommit("안녕하", "녕")).toBe(true);
  });

  it("treats a boundary overlap at the end as a duplicate", () => {
    // The case a naive `===` misses: several syllables commit and the IME still
    // emits a keypress for the last one.
    expect(isDuplicateOfPendingCommit("안녕", "녕")).toBe(true);
  });

  it("does not treat an unrelated character as a duplicate", () => {
    expect(isDuplicateOfPendingCommit("가", "a")).toBe(false);
    expect(isDuplicateOfPendingCommit("안녕", "하")).toBe(false);
  });

  it("never reports a duplicate against an empty pending commit", () => {
    // Nothing to duplicate → suppressing would be pure loss.
    expect(isDuplicateOfPendingCommit("", "가")).toBe(false);
    expect(isDuplicateOfPendingCommit("가", "")).toBe(false);
  });
});

describe("keypressText", () => {
  it("reads a single-character key", () => {
    expect(keypressText({ key: "가" })).toBe("가");
    expect(keypressText({ key: "a" })).toBe("a");
  });

  it("treats named keys as sending no text", () => {
    expect(keypressText({ key: "Enter" })).toBe("");
    expect(keypressText({ key: "Backspace" })).toBe("");
    expect(keypressText({ key: "Unidentified" })).toBe("");
  });

  it("handles a surrogate pair as one character", () => {
    expect(keypressText({ key: "\u{1f600}" })).toBe("\u{1f600}");
  });

  it("falls back to charCode when key is unusable", () => {
    expect(keypressText({ charCode: 44032 })).toBe("가");
    expect(keypressText({ key: "", charCode: 97 })).toBe("a");
  });

  it("returns empty when neither source carries text", () => {
    expect(keypressText({})).toBe("");
    expect(keypressText({ key: "", charCode: 0 })).toBe("");
  });
});

describe("decideCommitRace", () => {
  const state = { textareaValue: "가", compositionStart: 0, dataAlreadySentLength: 0 };

  it("delivers when no commit is pending", () => {
    // The guard must be invisible to ordinary typing.
    expect(decideCommitRace({ pending: false, state, keypress: { key: "가" } })).toMatchObject({
      suppress: false,
      reason: "no-pending-commit",
    });
  });

  it("suppresses the duplicate while a commit is pending", () => {
    expect(decideCommitRace({ pending: true, state, keypress: { key: "가" } })).toMatchObject({
      suppress: true,
      reason: "duplicate-of-pending-commit",
    });
  });

  it("delivers a character the user typed during the pending window", () => {
    expect(decideCommitRace({ pending: true, state, keypress: { key: "a" } })).toMatchObject({
      suppress: false,
      reason: "not-in-pending-commit",
    });
  });

  it("delivers when the pending state could not be read", () => {
    // Better a possible duplicate than swallowing input on an unknown xterm shape.
    expect(decideCommitRace({ pending: true, state: null, keypress: { key: "가" } })).toMatchObject(
      {
        suppress: false,
        reason: "pending-state-unavailable",
      },
    );
  });

  it("delivers a keypress that carries no text", () => {
    expect(decideCommitRace({ pending: true, state, keypress: { key: "Enter" } })).toMatchObject({
      suppress: false,
      reason: "keypress-sends-no-text",
    });
  });
});

// ---------------------------------------------------------------------------
// Against the real xterm code path
// ---------------------------------------------------------------------------

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

function racingKeypress(char: string): KeyboardEvent {
  const event = new KeyboardEvent("keypress", { key: char, bubbles: true, cancelable: true });
  Object.defineProperty(event, "charCode", { value: char.codePointAt(0) ?? 0 });
  Object.defineProperty(event, "keyCode", { value: 0 });
  return event;
}

const flushFinalizer = () => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(() => {
  while (mounted.length) mounted.pop()?.dispose();
  document.body.replaceChildren();
});

describe("xterm composition finalizer race (baseline)", () => {
  it("sends the committed syllable exactly once with no racing keypress", async () => {
    const { terminal, helper } = mountTerminal();
    const data: string[] = [];
    terminal.onData((d) => data.push(d));

    composeAndCommit(helper);
    await flushFinalizer();

    expect(data).toEqual(["가"]);
  });

  it("reproduces the duplicate when a keypress lands before the finalizer runs", async () => {
    // This is the baseline defect of issue #527, against the real xterm code
    // path. It does not need Linux/IBus: the race is xterm's own deferred send,
    // and the event ordering is what triggers it.
    const { terminal, helper } = mountTerminal();
    const data: string[] = [];
    terminal.onData((d) => data.push(d));

    composeAndCommit(helper);
    helper.dispatchEvent(racingKeypress("가"));
    await flushFinalizer();

    expect(data).toEqual(["가", "가"]);
  });
});

describe("xterm pending-composition contract", () => {
  it("exposes every field the guard reads", () => {
    // Completion criterion: a version bump must not silently disable the guard.
    const { terminal, helper } = mountTerminal();
    composeAndCommit(helper);

    const pending = readPendingCompositionSend(terminal);
    expect(pending).not.toBeNull();
    expect(pending!.pending).toBe(true);
    expect(pending!.state).toEqual({
      textareaValue: "가",
      compositionStart: 0,
      dataAlreadySentLength: 0,
    });
  });

  it("names the fields it depends on so a break is readable", () => {
    expect(XTERM_PENDING_COMPOSITION_FIELDS).toEqual([
      "_compositionHelper",
      "_isSendingComposition",
      "_compositionPosition",
      "_dataAlreadySent",
      "_textarea",
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

describe("the guard removes the duplicate without losing input", () => {
  /** Apply the guard the way `TerminalView` does. */
  function attachGuard(terminal: Terminal) {
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keypress") return true;
      const pending = readPendingCompositionSend(terminal);
      const decision = decideCommitRace({
        pending: !!pending?.pending,
        state: pending?.state ?? null,
        keypress: event,
      });
      return !decision.suppress;
    });
  }

  it("sends the committed syllable once when a duplicate keypress races", async () => {
    const { terminal, helper } = mountTerminal();
    attachGuard(terminal);
    const data: string[] = [];
    terminal.onData((d) => data.push(d));

    composeAndCommit(helper);
    helper.dispatchEvent(racingKeypress("가"));
    await flushFinalizer();

    expect(data).toEqual(["가"]);
  });

  it("still delivers a different character typed during the pending window", async () => {
    const { terminal, helper } = mountTerminal();
    attachGuard(terminal);
    const data: string[] = [];
    terminal.onData((d) => data.push(d));

    composeAndCommit(helper);
    helper.dispatchEvent(racingKeypress("a"));
    await flushFinalizer();

    // Both the commit and the newly typed character reach the PTY.
    expect(data).toContain("가");
    expect(data).toContain("a");
  });

  it("leaves ordinary typing untouched", async () => {
    const { terminal, helper } = mountTerminal();
    attachGuard(terminal);
    const data: string[] = [];
    terminal.onData((d) => data.push(d));

    helper.focus();
    helper.dispatchEvent(racingKeypress("a"));
    helper.dispatchEvent(racingKeypress("b"));
    await flushFinalizer();

    expect(data).toEqual(["a", "b"]);
  });

  it("repeats cleanly across consecutive compositions", async () => {
    const { terminal, helper } = mountTerminal();
    attachGuard(terminal);
    const data: string[] = [];
    terminal.onData((d) => data.push(d));

    for (const syllable of ["가", "나", "다"]) {
      helper.value = "";
      composeAndCommit(helper, syllable);
      helper.dispatchEvent(racingKeypress(syllable));
      await flushFinalizer();
    }

    expect(data).toEqual(["가", "나", "다"]);
  });
});
