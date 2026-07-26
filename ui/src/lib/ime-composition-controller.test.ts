import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import {
  advanceCells,
  createImeCompositionController,
  getCompositionPreviewCursor,
  getCompositionPreviewLayout,
  resolveVisualCaretOwner,
} from "./ime-composition-controller";
import { activateTerminalUnicodeProvider, stringCellWidth } from "./terminal-unicode-width";

const ZWJ = "\u200d";
const VS16 = "\ufe0f";
const KEYCAP = "\u20e3";
const ACCENT = "\u0301";
const SKIN_TONE = "\u{1f3fb}";
const HEART = "❤";
const THUMBS_UP = "\u{1f44d}";
const FAMILY = `\u{1f468}${ZWJ}\u{1f469}${ZWJ}\u{1f467}`;
const FLAG_KR = "\u{1f1f0}\u{1f1f7}";

const baseInput = {
  opened: true,
  focused: true,
  stabilizeInteractiveCursor: true,
  overlayActivity: true,
  syncOutputActive: false,
  isAltBufferActive: false,
  viewportScrolledUp: false,
  compositionActive: false,
  cursorHidden: false,
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

  it("hides the caret while the user is viewing scrollback", () => {
    expect(
      resolveVisualCaretOwner({
        ...baseInput,
        viewportScrolledUp: true,
        compositionActive: true,
        hasSyncFramePosition: true,
      }),
    ).toBe("hidden");
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

  // This case used to assert "hidden" — the defect in issue #551 was pinned as
  // intended behaviour. The composition preview is the text the user is typing and
  // its native renderer is switched off unconditionally in index.css, so hiding it
  // outside Codex left shells and every non-Codex TUI with nothing rendering the
  // in-flight jamo: no glyph, no underline.
  it("keeps composition preview when overlay caret activity is off (non-Codex)", () => {
    expect(
      resolveVisualCaretOwner({
        ...baseInput,
        overlayActivity: false,
        compositionActive: true,
      }),
    ).toBe("composition-preview");
  });

  it("keeps composition preview when caret stabilization is off", () => {
    expect(
      resolveVisualCaretOwner({
        ...baseInput,
        stabilizeInteractiveCursor: false,
        compositionActive: true,
      }),
    ).toBe("composition-preview");
  });

  it("still hides the caret outside Codex when no composition is in flight", () => {
    // The caret policy itself is unchanged: only composition outranks it.
    expect(
      resolveVisualCaretOwner({
        ...baseInput,
        overlayActivity: false,
        compositionActive: false,
        hasPromptBoundary: true,
        isInputPhase: true,
      }),
    ).toBe("hidden");
    expect(
      resolveVisualCaretOwner({
        ...baseInput,
        stabilizeInteractiveCursor: false,
        compositionActive: false,
        hasSyncFramePosition: true,
      }),
    ).toBe("hidden");
  });

  it("hides the caret while the app keeps DECTCEM hidden (sustained ?25l)", () => {
    expect(
      resolveVisualCaretOwner({
        ...baseInput,
        cursorHidden: true,
        hasSyncFramePosition: true,
      }),
    ).toBe("hidden");
  });

  it("lets composition preview win over DECTCEM hidden (IME caret must track preview)", () => {
    expect(
      resolveVisualCaretOwner({
        ...baseInput,
        cursorHidden: true,
        compositionActive: true,
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

describe("advanceCells", () => {
  /**
   * Pinned against real xterm, measured on the committed bundle in jsdom: fill a row
   * with `a` up to the origin column, write a 2-cell Hangul syllable, read
   * `buffer.active`. The last two rows are why plain `origin + width` normalized by
   * `% cols` is not enough — when the remaining space is narrower than the glyph,
   * xterm pads the final column and puts the whole glyph on the next row.
   */
  const HANGUL = "가";
  it.each([
    [75, 73, 75, 0],
    [150, 148, 150, 0],
    [150, 147, 149, 0],
    [75, 74, 2, 1],
    [80, 79, 2, 1],
  ])(
    "cols %i, origin %i advances to column %i row +%i",
    (cols, origin, column, rowOffset) => {
      expect(advanceCells(origin, HANGUL, cols)).toEqual({ column, rowOffset });
    },
  );

  it("normalizes an origin already at or past the right edge", () => {
    // xterm's pending-wrap cursor reports `cols`, and a derived carry-over anchor can
    // be further still. Both must fold into a column plus a row offset.
    expect(advanceCells(150, "", 150)).toEqual({ column: 0, rowOffset: 1 });
    expect(advanceCells(152, "", 150)).toEqual({ column: 2, rowOffset: 1 });
    expect(advanceCells(304, "", 150)).toEqual({ column: 4, rowOffset: 2 });
  });

  it("keeps a grapheme cluster whole across the boundary", () => {
    // The width that matters is the cluster's, not the code point's — a ZWJ family or
    // an emoji presentation sequence must not be split.
    expect(advanceCells(79, FAMILY, 80)).toEqual({ column: 2, rowOffset: 1 });
    expect(advanceCells(79, `${THUMBS_UP}`, 80)).toEqual({ column: 2, rowOffset: 1 });
    // Exactly filling the row is not a wrap: the cursor is left pending-wrap on it.
    expect(advanceCells(78, FAMILY, 80)).toEqual({ column: 80, rowOffset: 0 });
  });

  it("falls back to plain width when the column count is unknown", () => {
    expect(advanceCells(10, HANGUL, 0)).toEqual({ column: 12, rowOffset: 0 });
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
      anchorColumn: 3,
      anchorRowOffset: 0,
      rows: [{ text: "hello", startColumn: 3, rowOffset: 0, cellWidth: 5 }],
    });
  });

  it("normalizes an anchor sitting exactly on the right edge", () => {
    // xterm's pending-wrap cursor: fill a row to its last column and
    // `buffer.active.cursorX` stays at `cols` until the next write wraps it, so the
    // live anchor arrives as column 150 on a 150-column terminal (issue #551).
    expect(
      getCompositionPreviewLayout(
        {
          text: "ㄱ",
          anchorBufferX: 150,
          anchorBufferAbsY: 185,
          caretCellOffset: 2,
          textCellWidth: 2,
        },
        150,
      ),
    ).toEqual({
      cursorX: 2,
      cursorAbsY: 186,
      anchorColumn: 0,
      anchorRowOffset: 1,
      rows: [{ text: "ㄱ", startColumn: 0, rowOffset: 1, cellWidth: 2 }],
    });
  });

  it("normalizes an anchor past the right edge instead of collapsing it to column 0", () => {
    // The carry-over anchor is derived as chain origin + committed width, so it runs
    // past the edge while the echo of the wrapping syllable has not arrived. The wrap
    // branch used to reset to column 0 for *any* out-of-range anchor, so 150 and 152
    // both landed at column 0 and the second syllable of a chain crossing the
    // boundary rendered on top of the first — it looked like it never appeared.
    expect(
      getCompositionPreviewLayout(
        {
          text: "ㄱ",
          anchorBufferX: 152,
          anchorBufferAbsY: 185,
          caretCellOffset: 2,
          textCellWidth: 2,
        },
        150,
      ),
    ).toEqual({
      cursorX: 4,
      cursorAbsY: 186,
      anchorColumn: 2,
      anchorRowOffset: 1,
      rows: [{ text: "ㄱ", startColumn: 2, rowOffset: 1, cellWidth: 2 }],
    });
  });

  it("normalizes an anchor more than one row past the right edge", () => {
    expect(
      getCompositionPreviewLayout(
        {
          text: "ㄱ",
          anchorBufferX: 304,
          anchorBufferAbsY: 185,
          caretCellOffset: 2,
          textCellWidth: 2,
        },
        150,
      ),
    ).toEqual({
      cursorX: 6,
      cursorAbsY: 187,
      anchorColumn: 4,
      anchorRowOffset: 2,
      rows: [{ text: "ㄱ", startColumn: 4, rowOffset: 2, cellWidth: 2 }],
    });
  });

  it("sizes the preview to the active composition, not the prefix before it", () => {
    expect(
      getCompositionPreviewLayout(
        {
          text: "\u3139",
          anchorBufferX: 3,
          anchorBufferAbsY: 10,
          caretCellOffset: 2,
          textCellWidth: 2,
        },
        20,
      ),
    ).toEqual({
      cursorX: 5,
      cursorAbsY: 10,
      anchorColumn: 3,
      anchorRowOffset: 0,
      rows: [{ text: "\u3139", startColumn: 3, rowOffset: 0, cellWidth: 2 }],
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
      anchorColumn: 8,
      anchorRowOffset: 0,
      rows: [
        { text: "ab", startColumn: 8, rowOffset: 0, cellWidth: 2 },
        { text: "cd", startColumn: 0, rowOffset: 1, cellWidth: 2 },
      ],
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
      cursorX: 2,
      cursorAbsY: 5,
      anchorColumn: 7,
      anchorRowOffset: 0,
      rows: [
        { text: "가", startColumn: 7, rowOffset: 0, cellWidth: 2 },
        { text: "나", startColumn: 0, rowOffset: 1, cellWidth: 2 },
      ],
    });
  });

  it("moves a wide glyph wholly to the next row when only one cell remains", () => {
    expect(
      getCompositionPreviewLayout(
        {
          text: "가",
          anchorBufferX: 9,
          anchorBufferAbsY: 4,
          caretCellOffset: 2,
          textCellWidth: 2,
        },
        10,
      ),
    ).toEqual({
      cursorX: 2,
      cursorAbsY: 5,
      anchorColumn: 9,
      anchorRowOffset: 0,
      rows: [{ text: "가", startColumn: 0, rowOffset: 1, cellWidth: 2 }],
    });
  });

  it("normalizes the caret to the next row when a wide glyph exactly fills the line", () => {
    expect(
      getCompositionPreviewLayout(
        {
          text: "가",
          anchorBufferX: 8,
          anchorBufferAbsY: 4,
          caretCellOffset: 2,
          textCellWidth: 2,
        },
        10,
      ),
    ).toEqual({
      cursorX: 0,
      cursorAbsY: 5,
      anchorColumn: 8,
      anchorRowOffset: 0,
      rows: [{ text: "가", startColumn: 8, rowOffset: 0, cellWidth: 2 }],
    });
  });

  it("uses terminal-width row fragments for the reported 73-column Hangul boundary", () => {
    expect(
      getCompositionPreviewLayout(
        {
          text: "아아",
          anchorBufferX: 71,
          anchorBufferAbsY: 28,
          caretCellOffset: 4,
          textCellWidth: 4,
        },
        73,
      ),
    ).toEqual({
      cursorX: 2,
      cursorAbsY: 29,
      anchorColumn: 71,
      anchorRowOffset: 0,
      rows: [
        { text: "아", startColumn: 71, rowOffset: 0, cellWidth: 2 },
        { text: "아", startColumn: 0, rowOffset: 1, cellWidth: 2 },
      ],
    });
  });

  it("keeps a combining accent attached to its base character at the line end", () => {
    expect(
      getCompositionPreviewLayout(
        {
          text: `ae${ACCENT}`,
          anchorBufferX: 8,
          anchorBufferAbsY: 4,
          caretCellOffset: 2,
          textCellWidth: 2,
        },
        10,
      ),
    ).toEqual({
      cursorX: 0,
      cursorAbsY: 5,
      anchorColumn: 8,
      anchorRowOffset: 0,
      rows: [{ text: `ae${ACCENT}`, startColumn: 8, rowOffset: 0, cellWidth: 2 }],
    });
  });

  it("moves an emoji presentation sequence wholly to the next row", () => {
    expect(
      getCompositionPreviewLayout(
        {
          text: `${HEART}${VS16}`,
          anchorBufferX: 9,
          anchorBufferAbsY: 4,
          caretCellOffset: 2,
          textCellWidth: 2,
        },
        10,
      ),
    ).toEqual({
      cursorX: 2,
      cursorAbsY: 5,
      anchorColumn: 9,
      anchorRowOffset: 0,
      rows: [{ text: `${HEART}${VS16}`, startColumn: 0, rowOffset: 1, cellWidth: 2 }],
    });
  });

  it("moves a skin tone emoji wholly to the next row", () => {
    expect(
      getCompositionPreviewLayout(
        {
          text: `${THUMBS_UP}${SKIN_TONE}`,
          anchorBufferX: 9,
          anchorBufferAbsY: 4,
          caretCellOffset: 2,
          textCellWidth: 2,
        },
        10,
      ),
    ).toEqual({
      cursorX: 2,
      cursorAbsY: 5,
      anchorColumn: 9,
      anchorRowOffset: 0,
      rows: [{ text: `${THUMBS_UP}${SKIN_TONE}`, startColumn: 0, rowOffset: 1, cellWidth: 2 }],
    });
  });

  it("never splits a family ZWJ sequence across the row boundary", () => {
    expect(
      getCompositionPreviewLayout(
        {
          text: `a${FAMILY}`,
          anchorBufferX: 8,
          anchorBufferAbsY: 4,
          caretCellOffset: 3,
          textCellWidth: 3,
        },
        10,
      ),
    ).toEqual({
      cursorX: 2,
      cursorAbsY: 5,
      anchorColumn: 8,
      anchorRowOffset: 0,
      rows: [
        { text: "a", startColumn: 8, rowOffset: 0, cellWidth: 1 },
        { text: FAMILY, startColumn: 0, rowOffset: 1, cellWidth: 2 },
      ],
    });
  });
});

// ---------------------------------------------------------------------------
// The preview must place its rows and caret on the cells the committed text
// actually occupies, so the layout is compared against a real xterm buffer
// printing the same text at the same anchor column.
// ---------------------------------------------------------------------------

function writeTerminal(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

/**
 * Print `text` at `startColumn` of the first row and report the resulting
 * cursor cell. xterm parks a pending-wrap cursor at `cols`; normalize it into
 * the next row so both sides speak the same coordinate space as the preview.
 */
async function measureXtermCursor(
  text: string,
  cols: number,
  startColumn: number,
): Promise<{ cursorX: number; cursorAbsY: number }> {
  const terminal = new Terminal({ allowProposedApi: true, cols, rows: 8 });
  activateTerminalUnicodeProvider(terminal);
  await writeTerminal(terminal, `\u001b[1;${startColumn + 1}H${text}`);
  const buffer = terminal.buffer.active;
  let cursorX = buffer.cursorX;
  let cursorAbsY = buffer.baseY + buffer.cursorY;
  if (cursorX >= cols) {
    cursorX -= cols;
    cursorAbsY += 1;
  }
  terminal.dispose();
  return { cursorX, cursorAbsY };
}

function previewLayout(text: string, cols: number, startColumn: number) {
  const width = stringCellWidth(text);
  return getCompositionPreviewLayout(
    {
      text,
      anchorBufferX: startColumn,
      anchorBufferAbsY: 0,
      caretCellOffset: width,
      textCellWidth: width,
    },
    cols,
  );
}

describe("composition preview vs xterm buffer parity", () => {
  const cases: Array<{ name: string; text: string; cols: number; startColumn: number }> = [
    { name: "ASCII inside the line", text: "hello", cols: 20, startColumn: 3 },
    { name: "ASCII crossing the line end", text: "abcd", cols: 10, startColumn: 8 },
    { name: "Hangul inside the line", text: "한글", cols: 20, startColumn: 3 },
    { name: "Hangul crossing the line end", text: "아아", cols: 10, startColumn: 7 },
    { name: "Hangul with one cell left", text: "가", cols: 10, startColumn: 9 },
    { name: "Hangul exactly filling the line", text: "가", cols: 10, startColumn: 8 },
    { name: "combining accent", text: `e${ACCENT}`, cols: 10, startColumn: 3 },
    { name: "combining accent at the line end", text: `e${ACCENT}`, cols: 10, startColumn: 9 },
    { name: "emoji presentation sequence", text: `${HEART}${VS16}`, cols: 10, startColumn: 3 },
    {
      name: "emoji presentation sequence at the line end",
      text: `${HEART}${VS16}`,
      cols: 10,
      startColumn: 9,
    },
    { name: "skin tone emoji", text: `${THUMBS_UP}${SKIN_TONE}`, cols: 10, startColumn: 3 },
    {
      name: "skin tone emoji at the line end",
      text: `${THUMBS_UP}${SKIN_TONE}`,
      cols: 10,
      startColumn: 9,
    },
    { name: "family ZWJ sequence", text: FAMILY, cols: 10, startColumn: 3 },
    { name: "family ZWJ sequence at the line end", text: FAMILY, cols: 10, startColumn: 9 },
    { name: "keycap sequence", text: `1${VS16}${KEYCAP}`, cols: 10, startColumn: 4 },
    { name: "flag pair", text: FLAG_KR, cols: 10, startColumn: 4 },
    { name: "mixed run wrapping mid-text", text: "a한글b", cols: 8, startColumn: 5 },
    { name: "73-column Hangul boundary", text: "아아", cols: 73, startColumn: 71 },
  ];

  for (const testCase of cases) {
    it(`puts the caret on the committed cell — ${testCase.name}`, async () => {
      const layout = previewLayout(testCase.text, testCase.cols, testCase.startColumn);
      const measured = await measureXtermCursor(testCase.text, testCase.cols, testCase.startColumn);
      expect({ cursorX: layout.cursorX, cursorAbsY: layout.cursorAbsY }).toEqual(measured);
    });

    it(`emits whole clusters per row — ${testCase.name}`, () => {
      const layout = previewLayout(testCase.text, testCase.cols, testCase.startColumn);
      expect(layout.rows.map((row) => row.text).join("")).toBe(testCase.text);
      for (const row of layout.rows) {
        // A row that ended mid-cluster would measure differently on its own.
        expect(stringCellWidth(row.text)).toBe(row.cellWidth);
        expect(row.startColumn + row.cellWidth).toBeLessThanOrEqual(testCase.cols);
      }
    });
  }
});

describe("createImeCompositionController", () => {
  it("tracks only the active composition slice instead of the whole textarea value", async () => {
    const states: string[] = [];
    const controller = createImeCompositionController({
      getCols: () => 150,
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

  describe("carry-over drops the committed prefix (issue #546)", () => {
    /**
     * A Korean IME emits `compositionend` for the finished syllable and
     * `compositionstart` for the next one **in the same tick** — the jamo that
     * starts 나 is also the one that finalizes 가. The deferred finalize is a
     * `setTimeout(0)`, so carry-over fires on ordinary typing.
     *
     * The committed syllable has already gone to the PTY, so it must leave the
     * preview: otherwise it stays underlined and the preview grows across the
     * whole sentence, overdrawing real buffer content.
     */
    /**
     * `liveAnchors` supplies what the shadow cursor reports after each commit.
     * `null` means it has not echoed yet (the same-tick case). Values are
     * deliberately **not** equal to the arithmetic advance, so a test that wants
     * the live branch actually proves the live branch was taken.
     */
    async function typeGaNaDa(
      liveAnchors: Array<{ cursorX: number; cursorAbsY: number } | null>,
      startAnchor: { cursorX: number; cursorAbsY: number } = { cursorX: 0, cursorAbsY: 5 },
      cols = 150,
    ) {
      const snapshots: Array<{ text: string; anchorX: number; width: number }> = [];
      const carryOverTraces: Array<Record<string, unknown>> = [];
      // The shadow cursor cannot have advanced within the same tick, so the
      // default is a stale anchor. `shadowAdvances` covers the other ordering.
      let anchor = startAnchor;
      const controller = createImeCompositionController({
        getCols: () => cols,
      getAnchor: () => anchor,
        onTrace: (event, payload) => {
          if (event === "ime-composition-start-carryover") carryOverTraces.push(payload);
        },
        onStateChange: (state) => {
          if (!state.active) return;
          snapshots.push({
            text: state.text,
            anchorX: state.anchorBufferX,
            width: state.textCellWidth,
          });
        },
      });
      const textarea = document.createElement("textarea");
      controller.bind(textarea);

      const setValue = (v: string) => {
        textarea.value = v;
        textarea.selectionStart = v.length;
        textarea.selectionEnd = v.length;
      };
      const compose = async (value: string, data: string) => {
        setValue(value);
        textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data }));
        textarea.dispatchEvent(new Event("input"));
        await tick();
      };

      textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      await compose("\uac00", "\uac00"); // 가

      // ㄴ finalizes 가 and starts 나, same tick.
      textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "\uac00" }));
      if (liveAnchors[0]) anchor = liveAnchors[0];
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      await compose("\uac00\ub098", "\ub098"); // 가나

      // ㄷ finalizes 나 and starts 다.
      textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "\ub098" }));
      if (liveAnchors[1]) anchor = liveAnchors[1];
      textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      await compose("\uac00\ub098\ub2e4", "\ub2e4"); // 가나다

      const final = controller.getState();
      controller.dispose();
      return { snapshots, final, carryOverTraces };
    }

    it("keeps only the active syllable in the preview with a stale shadow cursor", async () => {
      const { final } = await typeGaNaDa([null, null]);
      expect(final).toMatchObject({
        active: true,
        text: "\ub2e4", // 다 only — 가나 is committed
        anchorBufferX: 4, // advanced by the committed 가나 = 4 cells
        anchorBufferAbsY: 5,
        textCellWidth: 2,
      });
    });

    it("adopts the shadow cursor once it has echoed", async () => {
      // 3 and 7 are not the arithmetic advance (2 and 4), so matching them proves
      // the live branch was chosen rather than coinciding with the arithmetic one.
      const { final, carryOverTraces } = await typeGaNaDa([
        { cursorX: 3, cursorAbsY: 5 },
        { cursorX: 7, cursorAbsY: 5 },
      ]);
      expect(final).toMatchObject({ text: "\ub2e4", anchorBufferX: 7, textCellWidth: 2 });
      // Adopting also re-bases the chain origin, so the next carry-over derives from
      // 7 rather than from the original 0 \u2014 see the wrap-boundary test for why.
      expect(carryOverTraces.map((t) => t.anchorSource)).toEqual([
        "shadow-cursor-rebase-ahead",
        "shadow-cursor-rebase-ahead",
      ]);
    });

    it("derives from the chain start while the shadow cursor is stale", async () => {
      const { carryOverTraces } = await typeGaNaDa([null, null]);
      expect(carryOverTraces.map((t) => t.anchorSource)).toEqual([
        "chain-committed-width",
        "chain-committed-width",
      ]);
      // Accumulated from the chain's start, not nudged from the previous anchor:
      // 가 = 2 cells, then 가나 = 4.
      expect(carryOverTraces.map((t) => t.chainCommittedWidth)).toEqual([2, 4]);
    });

    it("rejects a shadow cursor that lags the committed text within a row", async () => {
      // Issue #551, measured on a real Codex pane: typing ㄱㄱㄱ echoed only the
      // first jamo before the second carry-over, so the shadow cursor sat at
      // column 2 while two jamo (4 cells) were committed. Adopting it dragged the
      // third syllable back on top of the second and the preview looked frozen.
      //
      // "The shadow cursor moved" is not "the shadow cursor caught up". A late echo
      // is the same text landing at a larger column, so it never changes rows —
      // which is why lag is judged only within a row.
      const { final, carryOverTraces } = await typeGaNaDa([
        { cursorX: 2, cursorAbsY: 5 }, // level with 가 (2) — not ahead, derived
        { cursorX: 2, cursorAbsY: 5 }, // behind 가나 (4) — rejected
      ]);
      expect(carryOverTraces.map((t) => t.anchorSource)).toEqual([
        "chain-committed-width",
        "chain-committed-width",
      ]);
      expect(carryOverTraces.map((t) => [t.derivedX, t.liveX])).toEqual([
        [2, 2],
        [4, 2],
      ]);
      expect(final).toMatchObject({ anchorBufferX: 4, anchorBufferAbsY: 5 });
    });

    it("crosses the wrap boundary from arithmetic alone, without the live reading", async () => {
      // cols 75, chain origin at column 74 — one cell left, so the first wide syllable
      // cannot fit. Real xterm pads that last column and puts the glyph wholly on the
      // next row, landing the cursor at (2, +1); the echo lags one syllable behind.
      //
      //   1st  derived 77 (row+1 col 2)  live (2, row+1)  -> derived (tie, not ahead)
      //   2nd  derived 79 (row+1 col 4)  live (2, row+1)  -> derived (live is behind)
      //
      // `advanceCells` is what makes this work: adding the width would give 76, i.e.
      // row+1 column 1, one cell short of where xterm actually put the glyph. That
      // single cell used to be papered over by the next carry-over adopting the live
      // reading — which left the error standing whenever the boundary syllable was the
      // chain's last, the ordinary case of typing one syllable at the right margin and
      // confirming with space.
      const { final, carryOverTraces } = await typeGaNaDa(
        [
          { cursorX: 2, cursorAbsY: 6 },
          { cursorX: 2, cursorAbsY: 6 },
        ],
        { cursorX: 74, cursorAbsY: 5 },
        75,
      );
      expect(carryOverTraces.map((t) => t.anchorSource)).toEqual([
        "chain-committed-width",
        "chain-committed-width",
      ]);
      // Both derive from the original origin: nothing re-bases, because the row change
      // is fully explained by the committed width.
      expect(carryOverTraces.map((t) => [t.chainAnchorX, t.derivedX])).toEqual([
        [74, 77],
        [74, 79],
      ]);
      expect(final).toMatchObject({ anchorBufferX: 79, anchorBufferAbsY: 5 });
      // 79 on a 75-column terminal is row+1 column 4 — after 가나 laid out at columns
      // 0-1 and 2-3 of the wrapped row.
      expect(
        getCompositionPreviewLayout(
          {
            text: "\ub2e4",
            anchorBufferX: 79,
            anchorBufferAbsY: 5,
            caretCellOffset: 2,
            textCellWidth: 2,
          },
          75,
        ),
      ).toMatchObject({
        anchorColumn: 4,
        anchorRowOffset: 1,
        rows: [{ text: "\ub2e4", startColumn: 4, rowOffset: 1, cellWidth: 2 }],
      });
    });

    it("does not adopt a lagging live reading just because the row wrapped", async () => {
      // Measured on a 150-column shell (issue #551): origin 148, one echo of lag.
      //
      //   1st  derived 150  live (148, row)      -> derived
      //   2nd  derived 152  live (150, row)      -> derived
      //   3rd  derived 154  live (2, row + 1)    -> derived  (154 == row+1 col 4)
      //
      // The third is the one that used to break. A bare row-change test called it a
      // moved origin and adopted (2, row + 1), which is one syllable behind — and
      // because adoption re-bases, the deficit then persisted: five jamo typed, four
      // drawn. The row change is fully explained by the committed width, so
      // arithmetic wins and the layout normalizes 154 into row + 1 column 4.
      const cols = 150;
      const chainRow = 5;
      const traces = [];
      let anchor = { cursorX: 148, cursorAbsY: chainRow };
      const controller = createImeCompositionController({
        getCols: () => cols,
        getAnchor: () => anchor,
        onTrace: (event, payload) => {
          if (event === "ime-composition-start-carryover") traces.push(payload);
        },
      });
      const textarea = document.createElement("textarea");
      controller.bind(textarea);

      const setValue = (v) => {
        textarea.value = v;
        textarea.selectionStart = v.length;
        textarea.selectionEnd = v.length;
      };
      const compose = async (value, data) => {
        setValue(value);
        textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data }));
        textarea.dispatchEvent(new Event("input"));
        await tick();
      };
      // Each syllable finalizes the previous one and starts the next in the same
      // tick, which is what makes it a carry-over chain.
      const carryOver = async (committed, value, data, liveAfterEcho) => {
        textarea.dispatchEvent(new CompositionEvent("compositionend", { data: committed }));
        anchor = liveAfterEcho;
        textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
        await compose(value, data);
      };

      textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      await compose("\uac00", "\uac00");
      // The echo has not landed at all yet, so the live cursor is still the origin.
      await carryOver("\uac00", "\uac00\ub098", "\ub098", { cursorX: 148, cursorAbsY: chainRow });
      // One syllable echoed: pending-wrap column on the same row.
      await carryOver("\ub098", "\uac00\ub098\ub2e4", "\ub2e4", { cursorX: 150, cursorAbsY: chainRow });
      // Two echoed: the shell wrapped, so the live cursor is on the next row while a
      // third syllable is already committed.
      await carryOver("\ub2e4", "\uac00\ub098\ub2e4\ub77c", "\ub77c", { cursorX: 2, cursorAbsY: chainRow + 1 });

      const final = controller.getState();
      controller.dispose();

      expect(traces.map((x) => x.anchorSource)).toEqual([
        "chain-committed-width",
        "chain-committed-width",
        "chain-committed-width",
      ]);
      expect(traces.map((x) => x.derivedX)).toEqual([150, 152, 154]);
      expect(final).toMatchObject({ anchorBufferX: 154, anchorBufferAbsY: chainRow });
      // 154 on a 150-column terminal is row + 1, column 4 — where the fourth
      // syllable actually belongs.
      expect(
        getCompositionPreviewLayout(
          {
            text: "\ub77c",
            anchorBufferX: 154,
            anchorBufferAbsY: chainRow,
            caretCellOffset: 2,
            textCellWidth: 2,
          },
          cols,
        ).rows,
      ).toEqual([{ text: "\ub77c", startColumn: 4, rowOffset: 1, cellWidth: 2 }]);
    });
    it("re-bases on a row change in either direction", async () => {
      // A row change means the arithmetic origin is dead, whatever the direction, and
      // every way the input row can move *up* mid-chain keeps the composition valid:
      // a shell reprinting its input line one row up (CUP / `ESC[A` — PSReadLine
      // multi-line, a two-line zsh prompt), IL/DL/RI inside a scroll region, or the
      // scrollback cap dropping old rows so a fixed row's absolute index falls.
      //
      // An earlier form of this guard rejected those on the reasoning that a viewport
      // scroll cannot change an absolute row. True, but it only rules out viewport
      // scrolling — the three above are not that, and rejecting them left the preview
      // on the abandoned row.
      const { final, carryOverTraces } = await typeGaNaDa([
        { cursorX: 0, cursorAbsY: 4 },
        { cursorX: 1, cursorAbsY: 4 },
      ]);
      expect(carryOverTraces.map((t) => t.anchorSource)).toEqual([
        "shadow-cursor-rebase-row",
        "chain-committed-width",
      ]);
      // Re-based to (0, row 4), then 나's 2 cells: the live 1 is behind, so derived.
      expect(final).toMatchObject({ anchorBufferX: 2, anchorBufferAbsY: 4 });
    });

    it("adopts a shadow cursor that wrapped to the next row", async () => {
      // The wrap-boundary self-correction path: xterm pushes a whole wide glyph
      // to the next row rather than splitting it, so the echoed cursor lands on
      // row+1 column 2 — a place arithmetic on cursorX alone cannot reach.
      const { final, carryOverTraces } = await typeGaNaDa([
        { cursorX: 2, cursorAbsY: 6 },
        { cursorX: 4, cursorAbsY: 6 },
      ]);
      // Row change re-bases; the second carry-over then derives 2 + 나's 2 cells = 4
      // from the new origin and the live 4 is no longer ahead of it.
      expect(carryOverTraces.map((t) => t.anchorSource)).toEqual([
        "shadow-cursor-rebase-row",
        "chain-committed-width",
      ]);
      expect(final).toMatchObject({ anchorBufferX: 4, anchorBufferAbsY: 6 });
    });

    it("reports active with empty text between the commit and the next sync", async () => {
      // A state combination this change introduces. `resolveVisualCaretOwner`
      // gives composition-preview on `active` alone, and the renderer hides an
      // empty preview while still placing the caret at the advanced anchor — so
      // the empty snapshot must carry the *new* anchor, not the old one.
      const { snapshots } = await typeGaNaDa([null, null]);
      const empties = snapshots.filter((s) => s.text === "");
      expect(empties.length).toBeGreaterThan(0);
      // One per composition start: the fresh start at 0, then each carry-over at
      // the advanced anchor.
      expect(empties.map((s) => s.anchorX)).toEqual([0, 2, 4]);
      expect(empties.every((s) => s.width === 0)).toBe(true);
    });

    it("advances the anchor one syllable at a time", async () => {
      const { snapshots } = await typeGaNaDa([null, null]);
      // One entry per syllable, each holding only that syllable.
      const perSyllable = snapshots.filter((s) => s.text.length === 1);
      expect(perSyllable.map((s) => `${s.text}@${s.anchorX}`)).toEqual([
        "\uac00@0",
        "\ub098@2",
        "\ub2e4@4",
      ]);
    });

    it("never lets the preview width grow past one syllable", async () => {
      const { snapshots } = await typeGaNaDa([null, null]);
      // The regression showed 2 → 4 → 6 as the chain accumulated.
      expect(Math.max(...snapshots.map((s) => s.width))).toBe(2);
    });

    it("does not report committed text in any snapshot", async () => {
      const { snapshots } = await typeGaNaDa([null, null]);
      expect(snapshots.map((s) => s.text)).not.toContain("\uac00\ub098");
      expect(snapshots.map((s) => s.text)).not.toContain("\uac00\ub098\ub2e4");
    });
  });
  it("resets after compositionend once the deferred finalize fires", async () => {
    const controller = createImeCompositionController({
      getCols: () => 150,
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
      getCols: () => 150,
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

    // Carry-over: the committed 이 left the preview and the anchor advanced by
    // its two cells, so only the active 대 is shown (issue #546).
    expect(controller.getState()).toMatchObject({
      active: true,
      text: "\uB300",
      anchorBufferX: 22,
      anchorBufferAbsY: 736,
      caretUtf16Index: 1,
      caretCellOffset: 2,
      textCellWidth: 2,
    });
  });

  it("detects carry-over even when compositionupdate data differs from finalized text", async () => {
    const controller = createImeCompositionController({
      getCols: () => 150,
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

    // Only the active 대 stays in the preview; the anchor moved past the
    // committed 이 (issue #546).
    expect(controller.getState()).toMatchObject({
      active: true,
      text: "\uB300",
      anchorBufferX: 22,
      anchorBufferAbsY: 736,
      caretUtf16Index: 1,
      caretCellOffset: 2,
      textCellWidth: 2,
    });
  });

  it("starts a fresh composition after the deferred reset fires", async () => {
    const controller = createImeCompositionController({
      getCols: () => 150,
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

  it("clears helper-textarea residue after the deferred finalize", async () => {
    const controller = createImeCompositionController({
      getCols: () => 150,
      getAnchor: () => ({ cursorX: 0, cursorAbsY: 0 }),
    });
    const textarea = document.createElement("textarea");
    controller.bind(textarea);

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    textarea.value = "지";
    textarea.selectionStart = 1;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "지" }));
    await tick();
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "지" }));
    await tick();

    // Residue removed: the accumulated value is what desyncs xterm's
    // substring bookkeeping and re-sends committed syllables.
    expect(textarea.value).toBe("");
    expect(controller.getState().active).toBe(false);
  });

  it("still clears residue when the commit's own input event arrives after compositionend", async () => {
    const controller = createImeCompositionController({
      getCols: () => 150,
      getAnchor: () => ({ cursorX: 0, cursorAbsY: 0 }),
    });
    const textarea = document.createElement("textarea");
    controller.bind(textarea);

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    textarea.value = "지";
    textarea.selectionStart = 1;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "지" }));
    await tick();
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "지" }));

    // WebView2/Chromium can deliver the commit's own input event after
    // compositionend. It is composition-side (isComposing=true), not new
    // user input — it must not defeat the residue clear.
    const commitInput = new Event("input");
    Object.defineProperty(commitInput, "isComposing", { value: true });
    textarea.dispatchEvent(commitInput);

    const commitInsert = new Event("beforeinput");
    Object.defineProperty(commitInsert, "inputType", { value: "insertCompositionText" });
    textarea.dispatchEvent(commitInsert);
    await tick();

    expect(textarea.value).toBe("");
    expect(controller.getState().active).toBe(false);
  });

  it("keeps the textarea untouched when input races in after compositionend", async () => {
    const controller = createImeCompositionController({
      getCols: () => 150,
      getAnchor: () => ({ cursorX: 0, cursorAbsY: 0 }),
    });
    const textarea = document.createElement("textarea");
    controller.bind(textarea);

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    textarea.value = "지";
    textarea.selectionStart = 1;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "지" }));
    await tick();
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "지" }));

    // Keydown before the deferred finalize — xterm's keydown-229 diff path
    // may hold a snapshot of the current value; clearing would corrupt it.
    textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "2" }));
    textarea.value = "지2";
    textarea.dispatchEvent(new Event("input"));
    await tick();

    expect(textarea.value).toBe("지2");
    expect(controller.getState().active).toBe(false);
  });

  it("resets when the textarea blurs mid-composition (missed compositionend defense)", async () => {
    const controller = createImeCompositionController({
      getCols: () => 150,
      getAnchor: () => ({ cursorX: 5, cursorAbsY: 7 }),
    });
    const textarea = document.createElement("textarea");
    controller.bind(textarea);

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    textarea.value = "ㅇ";
    textarea.selectionStart = 1;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ㅇ" }));
    await tick();
    expect(controller.getState().active).toBe(true);

    // WebView2 + Windows IME can drop compositionend entirely; blur is the
    // recovery signal (the browser force-commits the composition on blur).
    textarea.dispatchEvent(new Event("blur"));

    // The stuck defense: the preview must not survive the blur.
    expect(controller.getState()).toMatchObject({
      active: false,
      text: "",
      caretUtf16Index: 0,
      caretCellOffset: 0,
      textCellWidth: 0,
    });
  });

  it("commits the in-flight syllable when a blur ends the composition", async () => {
    // Issue #555. Resetting alone lost the syllable: measured against a real
    // `Terminal`, a blur mid-composition makes xterm clear the helper textarea and
    // send nothing, and a `compositionend` after the blur cannot recover it because
    // the finalizer's slice source is already empty. For Korean a focus change is a
    // commit, not a cancel.
    const committed: string[] = [];
    const controller = createImeCompositionController({
      getCols: () => 150,
      getAnchor: () => ({ cursorX: 5, cursorAbsY: 7 }),
      onCommit: (text) => committed.push(text),
    });
    const textarea = document.createElement("textarea");
    controller.bind(textarea);

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    textarea.value = "\uc0dd";
    textarea.selectionStart = 1;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\uc0dd" }));
    await tick();
    expect(controller.getState().text).toBe("\uc0dd");

    textarea.dispatchEvent(new Event("blur"));

    expect(committed).toEqual(["\uc0dd"]);
    expect(controller.getState().active).toBe(false);
  });

  it("does not commit on blur once xterm has already sent the text", async () => {
    // `compositionend` before the blur is NOT by itself a reason to stay quiet —
    // measured, the real WebView2 sequence is end -> blur -> flush, and there the
    // syllable is lost. What matters is whether xterm's send is still scheduled.
    // Here it is not: the finalizer already ran, so committing would duplicate.
    const committed: string[] = [];
    const controller = createImeCompositionController({
      getCols: () => 150,
      getAnchor: () => ({ cursorX: 5, cursorAbsY: 7 }),
      getXtermPendingSend: () => false,
      onCommit: (text) => committed.push(text),
    });
    const textarea = document.createElement("textarea");
    controller.bind(textarea);

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    textarea.value = "\uc0dd";
    textarea.selectionStart = 1;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\uc0dd" }));
    await tick();
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "\uc0dd" }));

    textarea.dispatchEvent(new Event("blur"));

    expect(committed).toEqual([]);
    controller.dispose();
  });

  it("commits the finalized syllable when the blur lands inside xterm's send window", async () => {
    // The sequence that actually loses text (issue #555), measured on a real
    // `Terminal`: `compositionend` schedules xterm's deferred send, the blur clears
    // the helper textarea, and the finalizer then slices an empty string. The
    // controller sits in `pending-finalize`, so keying off the phase alone stayed
    // silent and the syllable vanished.
    const committed: string[] = [];
    const controller = createImeCompositionController({
      getCols: () => 150,
      getAnchor: () => ({ cursorX: 5, cursorAbsY: 7 }),
      getXtermPendingSend: () => true,
      onCommit: (text) => committed.push(text),
    });
    const textarea = document.createElement("textarea");
    controller.bind(textarea);

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    textarea.value = "\uc0dd";
    textarea.selectionStart = 1;
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\uc0dd" }));
    await tick();
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "\uc0dd" }));
    // xterm clears the textarea in its own blur handler before ours runs.
    textarea.value = "";

    textarea.dispatchEvent(new Event("blur"));

    expect(committed).toEqual(["\uc0dd"]);
    controller.dispose();
  });

  it("commits both texts when a blur catches a doomed send and a live composition", async () => {
    // A carry-over ends one syllable and starts the next in the same tick, so a blur
    // can strand two at once: the finalized one whose send is still scheduled, and
    // the one still composing. `state.text` only holds the newer one, which is why
    // the finalized text is captured separately at `compositionend`.
    const committed: string[] = [];
    const controller = createImeCompositionController({
      getCols: () => 150,
      getAnchor: () => ({ cursorX: 0, cursorAbsY: 5 }),
      getXtermPendingSend: () => true,
      onCommit: (text) => committed.push(text),
    });
    const textarea = document.createElement("textarea");
    controller.bind(textarea);

    const setValue = (v: string) => {
      textarea.value = v;
      textarea.selectionStart = v.length;
      textarea.selectionEnd = v.length;
    };

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    setValue("\uac00");
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\uac00" }));
    textarea.dispatchEvent(new Event("input"));
    await tick();

    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "\uac00" }));
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    setValue("\uac00\ub098");
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\ub098" }));
    textarea.dispatchEvent(new Event("input"));
    await tick();
    expect(controller.getState().text).toBe("\ub098");

    textarea.dispatchEvent(new Event("blur"));

    expect(committed).toEqual(["\uac00\ub098"]);
    controller.dispose();
  });

  it("does not commit an empty composition on blur", async () => {
    // The window between `compositionstart` and the first sync, and the same window
    // after a carry-over: active but nothing to show yet. Nothing to commit either.
    const committed: string[] = [];
    const controller = createImeCompositionController({
      getCols: () => 150,
      getAnchor: () => ({ cursorX: 5, cursorAbsY: 7 }),
      onCommit: (text) => committed.push(text),
    });
    const textarea = document.createElement("textarea");
    controller.bind(textarea);

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    expect(controller.getState()).toMatchObject({ active: true, text: "" });

    textarea.dispatchEvent(new Event("blur"));

    expect(committed).toEqual([]);
    controller.dispose();
  });

  it("commits only the active syllable when the earlier sends already landed", async () => {
    // Same carry-over shape, but xterm has no send scheduled: the earlier syllables
    // reached the PTY through its finalizer, so re-sending them would duplicate the
    // whole chain. Only the one still composing may go.
    const committed: string[] = [];
    const controller = createImeCompositionController({
      getCols: () => 150,
      getAnchor: () => ({ cursorX: 0, cursorAbsY: 5 }),
      getXtermPendingSend: () => false,
      onCommit: (text) => committed.push(text),
    });
    const textarea = document.createElement("textarea");
    controller.bind(textarea);

    const setValue = (v: string) => {
      textarea.value = v;
      textarea.selectionStart = v.length;
      textarea.selectionEnd = v.length;
    };

    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    setValue("\uac00");
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\uac00" }));
    textarea.dispatchEvent(new Event("input"));
    await tick();

    // 나 finalizes 가 and starts itself in the same tick — a carry-over.
    textarea.dispatchEvent(new CompositionEvent("compositionend", { data: "\uac00" }));
    textarea.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    setValue("\uac00\ub098");
    textarea.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\ub098" }));
    textarea.dispatchEvent(new Event("input"));
    await tick();
    expect(controller.getState().text).toBe("\ub098");

    textarea.dispatchEvent(new Event("blur"));

    expect(committed).toEqual(["\ub098"]);
    controller.dispose();
  });

  it("treats consecutive same-tick compositions as carry-over", async () => {
    const controller = createImeCompositionController({
      getCols: () => 150,
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
    // Chain of three: only the last syllable is active, and the anchor sits
    // past the two committed ones (issue #546).
    expect(controller.getState()).toMatchObject({
      active: true,
      text: "\uB9D0",
      anchorBufferX: 24,
      anchorBufferAbsY: 736,
      caretUtf16Index: 1,
      caretCellOffset: 2,
      textCellWidth: 2,
    });
  });
});
