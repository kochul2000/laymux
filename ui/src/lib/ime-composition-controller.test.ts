import { describe, expect, it } from "vitest";

import {
  createImeCompositionController,
  getCompositionPreviewCursor,
  getCompositionPreviewLayout,
  resolveVisualCaretOwner,
  stringCellWidth,
} from "./ime-composition-controller";

const baseInput = {
  opened: true,
  focused: true,
  stabilizeInteractiveCursor: true,
  overlayActivity: true,
  syncOutputActive: false,
  isAltBufferActive: false,
  compositionActive: false,
  hasSyncFramePosition: false,
  hasPromptBoundary: false,
  isInputPhase: false,
} as const;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("resolveVisualCaretOwner", () => {
  it("hides the caret when gating conditions fail", () => {
    expect(
      resolveVisualCaretOwner({
        ...baseInput,
        focused: false,
      }),
    ).toBe("hidden");
    expect(
      resolveVisualCaretOwner({
        ...baseInput,
        syncOutputActive: true,
      }),
    ).toBe("hidden");
  });

  it("prioritizes alt buffer before all other visual owners", () => {
    expect(
      resolveVisualCaretOwner({
        ...baseInput,
        compositionActive: true,
        hasSyncFramePosition: true,
        isAltBufferActive: true,
      }),
    ).toBe("alt-buffer");
  });

  it("prioritizes composition preview over sync-frame and shadow input", () => {
    expect(
      resolveVisualCaretOwner({
        ...baseInput,
        compositionActive: true,
        hasSyncFramePosition: true,
        hasPromptBoundary: true,
        isInputPhase: true,
      }),
    ).toBe("composition-preview");
  });

  it("hides composition preview when overlay caret activity is off (non-Codex)", () => {
    expect(
      resolveVisualCaretOwner({
        ...baseInput,
        overlayActivity: false,
        compositionActive: true,
      }),
    ).toBe("hidden");
  });

  it("uses sync-frame when composition is inactive", () => {
    expect(
      resolveVisualCaretOwner({
        ...baseInput,
        hasSyncFramePosition: true,
        hasPromptBoundary: true,
        isInputPhase: true,
      }),
    ).toBe("sync-frame");
  });

  it("uses shadow-input for prompt-boundary input mode without sync-frame", () => {
    expect(
      resolveVisualCaretOwner({
        ...baseInput,
        hasPromptBoundary: true,
        isInputPhase: true,
      }),
    ).toBe("shadow-input");
  });

  it("falls back to buffer caret when no higher-priority owner is active", () => {
    expect(resolveVisualCaretOwner(baseInput)).toBe("buffer");
  });
});

describe("stringCellWidth", () => {
  it("counts ASCII as width 1", () => {
    expect(stringCellWidth("abc")).toBe(3);
  });

  it("counts Hangul syllables as width 2", () => {
    expect(stringCellWidth("한")).toBe(2);
    expect(stringCellWidth("한글")).toBe(4);
  });

  it("ignores combining marks for caret width", () => {
    expect(stringCellWidth("e\u0301")).toBe(1);
  });
});

describe("getCompositionPreviewCursor", () => {
  it("advances on the same row when the preview stays within the line", () => {
    expect(
      getCompositionPreviewCursor(
        {
          anchorBufferX: 3,
          anchorBufferAbsY: 10,
          caretCellOffset: 2,
        },
        20,
      ),
    ).toEqual({ cursorX: 5, cursorAbsY: 10 });
  });

  it("wraps to the next row when preview width crosses the terminal width", () => {
    expect(
      getCompositionPreviewCursor(
        {
          anchorBufferX: 9,
          anchorBufferAbsY: 10,
          caretCellOffset: 3,
        },
        10,
      ),
    ).toEqual({ cursorX: 2, cursorAbsY: 11 });
  });
});

describe("getCompositionPreviewLayout", () => {
  it("keeps a single-row preview when the composition fits on the current line", () => {
    expect(
      getCompositionPreviewLayout(
        {
          text: "hello",
          anchorBufferX: 3,
          anchorBufferAbsY: 10,
          caretCellOffset: 5,
          textCellWidth: 5,
        },
        20,
      ),
    ).toEqual({
      cursorX: 8,
      cursorAbsY: 10,
      renderedText: "hello",
      rowCount: 1,
      maxRowCellWidth: 8,
    });
  });

  it("wraps preview text against the terminal column width", () => {
    expect(
      getCompositionPreviewLayout(
        {
          text: "abcd",
          anchorBufferX: 8,
          anchorBufferAbsY: 10,
          caretCellOffset: 4,
          textCellWidth: 4,
        },
        10,
      ),
    ).toEqual({
      cursorX: 2,
      cursorAbsY: 11,
      renderedText: "ab\ncd",
      rowCount: 2,
      maxRowCellWidth: 10,
    });
  });

  it("accounts for wide Hangul cells when wrapping preview text", () => {
    expect(
      getCompositionPreviewLayout(
        {
          text: "가나",
          anchorBufferX: 7,
          anchorBufferAbsY: 4,
          caretCellOffset: 4,
          textCellWidth: 4,
        },
        10,
      ),
    ).toEqual({
      cursorX: 1,
      cursorAbsY: 5,
      renderedText: "가\n나",
      rowCount: 2,
      maxRowCellWidth: 9,
    });
  });
});

describe("createImeCompositionController", () => {
  it("tracks only the active composition slice instead of the whole textarea value", async () => {
    const states: string[] = [];
    const controller = createImeCompositionController({
      getAnchor: () => ({ cursorX: 4, cursorAbsY: 9 }),
      onStateChange: (state) => {
        states.push(state.text);
      },
    });
    const textarea = document.createElement("textarea");
    textarea.value = "plain";
    textarea.selectionStart = textarea.value.length;
    controller.bind(textarea);

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    textarea.value = "plain\u3131";
    textarea.selectionStart = textarea.value.length;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\u3131" }));
    await tick();

    textarea.value = "plain\uac00";
    textarea.selectionStart = textarea.value.length;
    textarea.dispatchEvent(new Event("input"));
    await tick();

    expect(controller.getState()).toMatchObject({
      active: true,
      anchorBufferX: 4,
      anchorBufferAbsY: 9,
      text: "\uac00",
      caretUtf16Index: 1,
      caretCellOffset: 2,
      textCellWidth: 2,
    });
    expect(states).not.toContain("plain\uac00");

    controller.dispose();
  });

  it("resets after compositionend once the deferred finalize fires", async () => {
    const controller = createImeCompositionController({
      getAnchor: () => ({ cursorX: 1, cursorAbsY: 2 }),
    });
    const textarea = document.createElement("textarea");
    textarea.value = "abc";
    textarea.selectionStart = textarea.value.length;
    controller.bind(textarea);

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    textarea.value = "abc\u3131";
    textarea.selectionStart = textarea.value.length;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\u3131" }));
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "\uac00" }));

    // Deferred reset: state stays active until the microtask fires
    expect(controller.getState().active).toBe(true);

    await tick();

    expect(controller.getState()).toMatchObject({
      active: false,
      text: "",
      caretUtf16Index: 0,
      caretCellOffset: 0,
      textCellWidth: 0,
    });
  });

  it("detects carry-over when compositionstart fires before the deferred reset", async () => {
    const controller = createImeCompositionController({
      getAnchor: () => ({ cursorX: 20, cursorAbsY: 736 }),
    });
    const textarea = document.createElement("textarea");
    controller.bind(textarea);

    // First composition: "이"
    textarea.value = "";
    textarea.selectionStart = 0;
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    textarea.value = "\uC774";
    textarea.selectionStart = 1;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\uC774" }));
    await tick();
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "\uC774" }));

    // Carry-over: compositionstart fires in the same tick (before deferred reset)
    textarea.value = "\uC774";
    textarea.selectionStart = 1;
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    textarea.value = "\uC774\uB300";
    textarea.selectionStart = 2;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\uB300" }));
    await tick();

    // Carry-over mode: full accumulated text shown at original anchor
    expect(controller.getState()).toMatchObject({
      active: true,
      text: "\uC774\uB300",
      anchorBufferX: 20,
      anchorBufferAbsY: 736,
      caretUtf16Index: 2,
      caretCellOffset: 4,
      textCellWidth: 4,
    });
  });

  it("detects carry-over even when compositionupdate data differs from finalized text", async () => {
    const controller = createImeCompositionController({
      getAnchor: () => ({ cursorX: 20, cursorAbsY: 736 }),
    });
    const textarea = document.createElement("textarea");
    controller.bind(textarea);

    // First composition: compositionupdate shows "ㄱ" but end finalizes "이"
    textarea.value = "";
    textarea.selectionStart = 0;
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    textarea.value = "\uC774";
    textarea.selectionStart = 1;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\u3131" }));
    await tick();
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "\uC774" }));

    // Carry-over in same tick
    textarea.value = "\uC774";
    textarea.selectionStart = 1;
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    textarea.value = "\uC774\uB300";
    textarea.selectionStart = 2;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\uB300" }));
    await tick();

    expect(controller.getState()).toMatchObject({
      active: true,
      text: "\uC774\uB300",
      anchorBufferX: 20,
      anchorBufferAbsY: 736,
      caretUtf16Index: 2,
      caretCellOffset: 4,
      textCellWidth: 4,
    });
  });

  it("starts a fresh composition after the deferred reset fires", async () => {
    const controller = createImeCompositionController({
      getAnchor: () => ({ cursorX: 20, cursorAbsY: 736 }),
    });
    const textarea = document.createElement("textarea");
    controller.bind(textarea);

    // First composition: "다른"
    textarea.value = "";
    textarea.selectionStart = 0;
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    textarea.value = "\uB2E4\uB978";
    textarea.selectionStart = 2;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\uB2E4\uB978" }));
    await tick();
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "\uB2E4\uB978" }));

    // Let the deferred reset fire — simulates time passing (user pressed space, etc.)
    await tick();

    // Second composition starts fresh: "말"
    textarea.value = "\uB2E4\uB978\uB9D0";
    textarea.selectionStart = 3;
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\uB9D0" }));
    await tick();

    // Fresh start: only the new syllable, NOT accumulated
    expect(controller.getState()).toMatchObject({
      active: true,
      text: "\uB9D0",
      caretUtf16Index: 1,
      caretCellOffset: 2,
      textCellWidth: 2,
    });
  });

  it("treats consecutive same-tick compositions as carry-over", async () => {
    const controller = createImeCompositionController({
      getAnchor: () => ({ cursorX: 20, cursorAbsY: 736 }),
    });
    const textarea = document.createElement("textarea");
    controller.bind(textarea);

    // First composition: "다른"
    textarea.value = "";
    textarea.selectionStart = 0;
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    textarea.value = "\uB2E4\uB978";
    textarea.selectionStart = 2;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\uB2E4\uB978" }));
    await tick();
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "\uB2E4\uB978" }));

    // Same tick: "말" starts immediately — this IS carry-over
    textarea.value = "\uB2E4\uB978";
    textarea.selectionStart = 2;
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    textarea.value = "\uB2E4\uB978\uB9D0";
    textarea.selectionStart = 3;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\uB9D0" }));
    await tick();

    // Carry-over: accumulated text shown at original anchor
    expect(controller.getState()).toMatchObject({
      active: true,
      text: "\uB2E4\uB978\uB9D0",
      anchorBufferX: 20,
      anchorBufferAbsY: 736,
      caretUtf16Index: 3,
      caretCellOffset: 6,
      textCellWidth: 6,
    });
  });
});
