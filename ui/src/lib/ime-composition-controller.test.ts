import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import {
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
      rows: [{ text: "hello", startColumn: 3, rowOffset: 0, cellWidth: 5 }],
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
    async function typeGaNaDa(liveAnchors: Array<{ cursorX: number; cursorAbsY: number } | null>) {
      const snapshots: Array<{ text: string; anchorX: number; width: number }> = [];
      const carryOverTraces: Array<Record<string, unknown>> = [];
      // The shadow cursor cannot have advanced within the same tick, so the
      // default is a stale anchor. `shadowAdvances` covers the other ordering.
      let anchor = { cursorX: 0, cursorAbsY: 5 };
      const controller = createImeCompositionController({
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
      expect(carryOverTraces.map((t) => t.anchorSource)).toEqual([
        "shadow-cursor",
        "shadow-cursor",
      ]);
    });

    it("uses the committed width while the shadow cursor is stale", async () => {
      const { carryOverTraces } = await typeGaNaDa([null, null]);
      expect(carryOverTraces.map((t) => t.anchorSource)).toEqual([
        "committed-width",
        "committed-width",
      ]);
      expect(carryOverTraces.map((t) => t.committedWidth)).toEqual([2, 2]);
    });

    it("adopts a shadow cursor that moved backwards", async () => {
      // A scroll or clear can move it left or up. Direction must not matter: the
      // question is whether the PTY echoed, not which way the cursor went.
      const { final, carryOverTraces } = await typeGaNaDa([
        { cursorX: 0, cursorAbsY: 4 },
        { cursorX: 1, cursorAbsY: 4 },
      ]);
      expect(carryOverTraces.map((t) => t.anchorSource)).toEqual([
        "shadow-cursor",
        "shadow-cursor",
      ]);
      expect(final).toMatchObject({ anchorBufferX: 1, anchorBufferAbsY: 4 });
    });

    it("adopts a shadow cursor that wrapped to the next row", async () => {
      // The wrap-boundary self-correction path: xterm pushes a whole wide glyph
      // to the next row rather than splitting it, so the echoed cursor lands on
      // row+1 column 2 — a place arithmetic on cursorX alone cannot reach.
      const { final, carryOverTraces } = await typeGaNaDa([
        { cursorX: 2, cursorAbsY: 6 },
        { cursorX: 4, cursorAbsY: 6 },
      ]);
      expect(carryOverTraces.map((t) => t.anchorSource)).toEqual([
        "shadow-cursor",
        "shadow-cursor",
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

    expect(controller.getState()).toMatchObject({
      active: false,
      text: "",
      caretUtf16Index: 0,
      caretCellOffset: 0,
      textCellWidth: 0,
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
