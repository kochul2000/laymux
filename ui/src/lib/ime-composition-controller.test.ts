import { describe, expect, it } from "vitest";

import {
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
