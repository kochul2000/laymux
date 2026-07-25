import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import {
  LAYMUX_UNICODE_VERSION,
  WIDE_RANGES,
  activateTerminalUnicodeProvider,
  codePointCellWidth,
  splitCellClusters,
  stringCellWidth,
  terminalUnicodeProvider,
} from "./terminal-unicode-width";

const ZWJ = "\u200d";
const VS16 = "\ufe0f";
const VS15 = "\ufe0e";
const KEYCAP = "\u20e3";
const SKIN_TONE = "\u{1f3fb}";
const ACCENT = "\u0301";
const CEDILLA = "\u0327";
const HEART = "❤";
const THUMBS_UP = "\u{1f44d}";
const FAMILY = `\u{1f468}${ZWJ}\u{1f469}${ZWJ}\u{1f467}`;
const FLAG_KR = "\u{1f1f0}\u{1f1f7}";
const FLAG_US = "\u{1f1fa}\u{1f1f8}";
// Japanese combining marks and their bases, written as escapes on purpose. As
// literal decomposed text a single NFC pass by an editor, a formatter or git's
// `core.precomposeunicode` folds base+mark into one precomposed code point, and
// these tests would keep passing while no longer testing the decomposed form.
const VOICED = "\u3099"; // combining katakana-hiragana voiced (Mn)
const SEMI_VOICED = "\u309a"; // combining katakana-hiragana semi-voiced (Mn)
const SPACING_VOICED = "\u309b"; // spacing voiced mark (gc=Sk) - width 2 is right
const TONE_MARK = "\u302a"; // ideographic level tone mark (Mn)
const KA = "\u304b";
const HA = "\u306f";
const SA = "\u3055";
const KI = "\u304d";
const KATAKANA_KA = "\u30ab";
const CJK_MIDDLE = "\u4e2d";

function clusterSegments(text: string): string[] {
  return splitCellClusters(text).map((cluster) => cluster.segment);
}

function clusterWidths(text: string): number[] {
  return splitCellClusters(text).map((cluster) => cluster.width);
}

describe("codePointCellWidth", () => {
  it("treats ASCII as a single cell and control characters as zero cells", () => {
    expect(codePointCellWidth(0x41)).toBe(1);
    expect(codePointCellWidth(0x20)).toBe(1);
    expect(codePointCellWidth(0x0a)).toBe(0);
    expect(codePointCellWidth(0x7f)).toBe(0);
  });

  it("treats Hangul syllables and conjoining jamo per East Asian width", () => {
    expect(codePointCellWidth(0xac00)).toBe(2); // 가
    expect(codePointCellWidth(0x1100)).toBe(2); // leading jamo
    expect(codePointCellWidth(0x1161)).toBe(0); // conjoining vowel jamo
    expect(codePointCellWidth(0x3139)).toBe(2); // compatibility jamo ㄹ
  });

  it("treats combining marks, joiners and variation selectors as zero cells", () => {
    expect(codePointCellWidth(0x0301)).toBe(0); // combining acute accent
    expect(codePointCellWidth(0x200d)).toBe(0); // ZWJ
    expect(codePointCellWidth(0xfe0f)).toBe(0); // VS16
    expect(codePointCellWidth(0x20e3)).toBe(0); // combining enclosing keycap
    expect(codePointCellWidth(0xe0065)).toBe(0); // tag latin small letter e
    expect(codePointCellWidth(0xe0100)).toBe(0); // variation selector supplement
  });

  it("treats combining marks that sit inside a wide range as zero cells", () => {
    // These are `Mn` **and** inside `WIDE_RANGES`, so the order of the two checks
    // decides the answer. U+3099/U+309A are the Japanese voiced/semi-voiced sound
    // marks, i.e. ordinary NFD Japanese text.
    expect(codePointCellWidth(0x302a)).toBe(0); // ideographic level tone mark
    expect(codePointCellWidth(0x302b)).toBe(0);
    expect(codePointCellWidth(0x302c)).toBe(0);
    expect(codePointCellWidth(0x302d)).toBe(0);
    expect(codePointCellWidth(0x3099)).toBe(0); // combining katakana-hiragana voiced
    expect(codePointCellWidth(0x309a)).toBe(0); // combining katakana-hiragana semi-voiced
    expect(codePointCellWidth(0x16fe4)).toBe(0); // Khitan small script filler
  });

  it("keeps spacing combining marks (gc=Mc) out of the zero-width set", () => {
    // `Mc` advances the cursor by definition, so the wcwidth convention only
    // zeroes `Mn`/`Me`. Folding `Mc` in to match xterm's V6 table (which reports
    // 0 for the two Hangul tone marks) would silently change the width of 467
    // Indic/SEA marks — so assert both halves of that trade-off (issue #547).
    const mc = /^\p{Mc}$/u;
    const wide: number[] = [];
    const narrow: number[] = [];
    const zero: number[] = [];
    for (let cp = 0; cp < 0x110000; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (!mc.test(String.fromCodePoint(cp))) continue;
      const width = codePointCellWidth(cp);
      if (width === 2) wide.push(cp);
      else if (width === 1) narrow.push(cp);
      else zero.push(cp);
    }

    // No Mc may be zero width — that is the whole point of the category.
    expect(zero).toEqual([]);
    // Exactly the four that sit inside WIDE_RANGES per East Asian Width W.
    expect(wide.map((cp) => `U+${cp.toString(16).toUpperCase()}`)).toEqual([
      "U+302E",
      "U+302F",
      "U+16FF0",
      "U+16FF1",
    ]);
    // Everything else is one cell, matching V6. The count guards against a
    // future change that quietly reclassifies a whole block.
    expect(narrow.length).toBeGreaterThan(400);
  });

  it("gives the Hangul and Vietnamese Mc marks two cells", () => {
    // Spelled out separately from the sweep so the intent survives even if the
    // engine's Unicode data shifts the Mc set.
    expect(codePointCellWidth(0x302e)).toBe(2); // Hangul single dot tone mark
    expect(codePointCellWidth(0x302f)).toBe(2); // Hangul double dot tone mark
    expect(codePointCellWidth(0x16ff0)).toBe(2); // Vietnamese reading mark ca
    expect(codePointCellWidth(0x16ff1)).toBe(2); // Vietnamese reading mark nhay
  });

  it("keeps representative Indic and SEA spacing marks at one cell", () => {
    expect(codePointCellWidth(0x0903)).toBe(1); // Devanagari sign visarga
    expect(codePointCellWidth(0x093b)).toBe(1); // Devanagari vowel sign ooe
    expect(codePointCellWidth(0x093e)).toBe(1); // Devanagari vowel sign aa
    expect(codePointCellWidth(0x0e33)).toBe(1); // Thai sara am
    expect(codePointCellWidth(0x0eb3)).toBe(1); // Lao sign am
    expect(codePointCellWidth(0x1b44)).toBe(1); // Balinese adeg adeg
  });
  it("has no code point that is both wide and zero-width by category", () => {
    // The regression this guards against was introduced by an unverified claim
    // that the two sets are disjoint. They are not — so assert the real
    // intersection instead of trusting a comment. Exhaustive over WIDE_RANGES
    // (~170k code points), which is fast enough for a unit test.
    const zeroWidthCategory = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
    const offenders: string[] = [];
    for (const [first, last] of WIDE_RANGES) {
      for (let cp = first; cp <= last; cp += 1) {
        if (!zeroWidthCategory.test(String.fromCodePoint(cp))) continue;
        // A code point in both sets must resolve to 0, whatever the check order.
        if (codePointCellWidth(cp) !== 0) {
          offenders.push(`U+${cp.toString(16).toUpperCase()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("treats emoji and CJK extension planes as double width", () => {
    expect(codePointCellWidth(0x1f468)).toBe(2); // man
    expect(codePointCellWidth(0x1f3fb)).toBe(2); // skin tone modifier
    expect(codePointCellWidth(0x20000)).toBe(2); // CJK extension B
  });

  it("resolves supplementary planes above the former cache ceiling", () => {
    // These used to bypass the cache entirely and re-run a property escape on
    // every call. Correctness must hold on the first and on a repeated lookup.
    for (const codePoint of [0x2fffd, 0x30000, 0x3fffd]) {
      expect(codePointCellWidth(codePoint)).toBe(2);
      expect(codePointCellWidth(codePoint)).toBe(2);
    }
    for (const codePoint of [0xe0065, 0xe01ef]) {
      expect(codePointCellWidth(codePoint)).toBe(0);
      expect(codePointCellWidth(codePoint)).toBe(0);
    }
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
    expect(stringCellWidth(`e${ACCENT}`)).toBe(1);
    expect(stringCellWidth(`e${ACCENT}${CEDILLA}`)).toBe(1);
  });

  it("promotes an emoji presentation sequence to two cells", () => {
    expect(stringCellWidth(HEART)).toBe(1);
    expect(stringCellWidth(`${HEART}${VS16}`)).toBe(2);
    expect(stringCellWidth(`${HEART}${VS15}`)).toBe(1);
  });

  it("counts a keycap sequence as one two-cell cluster", () => {
    expect(stringCellWidth(`1${VS16}${KEYCAP}`)).toBe(2);
  });

  it("counts a skin tone modifier as part of its base emoji", () => {
    expect(stringCellWidth(`${THUMBS_UP}${SKIN_TONE}`)).toBe(2);
  });

  it("leaves a non-emoji base at its own width when VS16 follows it", () => {
    // VS16 has no emoji presentation to select after a plain letter, so the cell
    // must not widen to two — the font would leave the second column blank.
    expect(stringCellWidth(`a${VS16}`)).toBe(1);
    expect(stringCellWidth(`한${VS16}`)).toBe(2);
    expect(stringCellWidth(`a${VS16}b`)).toBe(2);
  });

  it("keeps a skin tone modifier separate from a base that cannot take one", () => {
    // Emoji_Modifier only extends an Emoji_Modifier_Base; anywhere else it is a
    // standalone swatch and owns its own two cells.
    expect(stringCellWidth(`a${SKIN_TONE}`)).toBe(3);
    expect(stringCellWidth(`${HEART}${SKIN_TONE}`)).toBe(3);
  });

  it("lets each member of a ZWJ sequence take its own skin tone", () => {
    expect(stringCellWidth(`\u{1f468}${SKIN_TONE}${ZWJ}\u{1f469}${SKIN_TONE}`)).toBe(2);
  });

  it("counts NFD Japanese voiced syllables as one two-cell cluster", () => {
    // が / ぱ in NFD: base kana + U+3099 / U+309A. The mark is Mn and sits inside
    // a wide range, so a wide-first check makes each syllable 4 cells.
    expect(stringCellWidth(`${KA}${VOICED}`)).toBe(2);
    expect(stringCellWidth(`${HA}${SEMI_VOICED}`)).toBe(2);
    expect(stringCellWidth(`${SA}${VOICED}${KI}${VOICED}`)).toBe(4);
    expect(stringCellWidth(`${CJK_MIDDLE}${TONE_MARK}`)).toBe(2);
  });

  it("counts a family ZWJ sequence as one two-cell cluster", () => {
    expect(stringCellWidth(FAMILY)).toBe(2);
  });

  it("counts a regional indicator flag pair as one two-cell cluster", () => {
    expect(stringCellWidth(FLAG_KR)).toBe(2);
    expect(stringCellWidth(`${FLAG_KR}${FLAG_US}`)).toBe(4);
  });
});

describe("splitCellClusters", () => {
  it("splits ASCII into one cluster per character", () => {
    expect(clusterSegments("ab")).toEqual(["a", "b"]);
    expect(clusterWidths("ab")).toEqual([1, 1]);
  });

  it("keeps a combining accent attached to its base character", () => {
    expect(clusterSegments(`ae${ACCENT}b`)).toEqual(["a", `e${ACCENT}`, "b"]);
    expect(clusterWidths(`ae${ACCENT}b`)).toEqual([1, 1, 1]);
  });

  it("keeps an emoji presentation sequence in one cluster", () => {
    expect(clusterSegments(`a${HEART}${VS16}b`)).toEqual(["a", `${HEART}${VS16}`, "b"]);
    expect(clusterWidths(`a${HEART}${VS16}b`)).toEqual([1, 2, 1]);
  });

  it("keeps a skin tone modifier in one cluster", () => {
    expect(clusterSegments(`${THUMBS_UP}${SKIN_TONE}x`)).toEqual([`${THUMBS_UP}${SKIN_TONE}`, "x"]);
    expect(clusterWidths(`${THUMBS_UP}${SKIN_TONE}x`)).toEqual([2, 1]);
  });

  it("keeps a family ZWJ sequence in one cluster", () => {
    expect(clusterSegments(`${FAMILY}!`)).toEqual([FAMILY, "!"]);
    expect(clusterWidths(`${FAMILY}!`)).toEqual([2, 1]);
  });

  it("keeps a regional indicator pair in one cluster and starts a new pair after it", () => {
    expect(clusterSegments(`${FLAG_KR}${FLAG_US}`)).toEqual([FLAG_KR, FLAG_US]);
    expect(clusterWidths(`${FLAG_KR}${FLAG_US}`)).toEqual([2, 2]);
  });

  it("keeps an NFD Japanese voiced mark attached to its base kana", () => {
    expect(clusterSegments(`${KA}${VOICED}x`)).toEqual([`${KA}${VOICED}`, "x"]);
    expect(clusterWidths(`${KA}${VOICED}x`)).toEqual([2, 1]);
  });

  it("keeps a keycap sequence in one cluster", () => {
    expect(clusterSegments(`1${VS16}${KEYCAP}`)).toEqual([`1${VS16}${KEYCAP}`]);
    expect(clusterWidths(`1${VS16}${KEYCAP}`)).toEqual([2]);
  });

  it("keeps an inert VS16 attached without widening a non-emoji base", () => {
    expect(clusterSegments(`a${VS16}b`)).toEqual([`a${VS16}`, "b"]);
    expect(clusterWidths(`a${VS16}b`)).toEqual([1, 1]);
  });

  it("splits a skin tone modifier off a base that cannot take one", () => {
    expect(clusterSegments(`a${SKIN_TONE}b`)).toEqual(["a", SKIN_TONE, "b"]);
    expect(clusterWidths(`a${SKIN_TONE}b`)).toEqual([1, 2, 1]);
  });

  it("keeps Hangul syllables as separate two-cell clusters", () => {
    expect(clusterSegments("한글")).toEqual(["한", "글"]);
    expect(clusterWidths("한글")).toEqual([2, 2]);
  });

  it("reassembles the original text and reports the same total as stringCellWidth", () => {
    const samples = [
      "abc",
      "한글 mixed",
      `${HEART}${VS16}`,
      `${THUMBS_UP}${SKIN_TONE}`,
      FAMILY,
      FLAG_KR,
      `e${ACCENT}`,
      `1${VS16}${KEYCAP}`,
      `a${VS16}b`,
      `a${SKIN_TONE}b`,
      `\u{1f468}${SKIN_TONE}${ZWJ}\u{1f469}${SKIN_TONE}`,
    ];
    for (const sample of samples) {
      expect(clusterSegments(sample).join("")).toBe(sample);
      expect(clusterWidths(sample).reduce((sum, width) => sum + width, 0)).toBe(
        stringCellWidth(sample),
      );
    }
  });
});

describe("real xterm buffer cursor", () => {
  /**
   * The layer the other tests do not reach. Everything above exercises our own
   * `charProperties` chain and is self-consistent by construction; issue #544
   * showed up as the **buffer cursor** advancing 4 cells for one NFD syllable,
   * so assert that directly through the provider xterm actually reads.
   */
  async function writeAndMeasure(text: string): Promise<number> {
    const terminal = new Terminal({ allowProposedApi: true, cols: 20, rows: 5 });
    activateTerminalUnicodeProvider(terminal);
    // `write` is async — reading the cursor before the callback yields 0.
    await new Promise<void>((resolve) => terminal.write(text, () => resolve()));
    const cursorX = terminal.buffer.active.cursorX;
    terminal.dispose();
    return cursorX;
  }

  it("advances two cells for an NFD hiragana syllable", async () => {
    expect(await writeAndMeasure(`${KA}${VOICED}`)).toBe(2);
  });

  it("advances two cells for an NFD katakana syllable", async () => {
    expect(await writeAndMeasure(`${KATAKANA_KA}${VOICED}`)).toBe(2);
  });

  it("advances two cells for the spacing voiced mark", async () => {
    // Boundary pair with U+3099: U+309B is gc=Sk, not a combining mark, so two
    // cells is the right answer and must not be swept up by the zero-width check.
    expect(await writeAndMeasure(SPACING_VOICED)).toBe(2);
  });

  it("advances four cells for two NFD syllables", async () => {
    expect(await writeAndMeasure(`${SA}${VOICED}${KI}${VOICED}`)).toBe(4);
  });
});
describe("activateTerminalUnicodeProvider", () => {
  it("registers the shared provider and makes it the active version", () => {
    const registered: string[] = [];
    let activeVersion = "6";
    const fakeTerminal = {
      unicode: {
        register: (provider: { version: string }) => registered.push(provider.version),
        get versions() {
          return registered;
        },
        get activeVersion() {
          return activeVersion;
        },
        set activeVersion(version: string) {
          if (!registered.includes(version)) throw new Error(`unknown version ${version}`);
          activeVersion = version;
        },
      },
    };

    activateTerminalUnicodeProvider(fakeTerminal as never);

    expect(registered).toEqual([LAYMUX_UNICODE_VERSION]);
    expect(activeVersion).toBe(LAYMUX_UNICODE_VERSION);
    expect(terminalUnicodeProvider.version).toBe(LAYMUX_UNICODE_VERSION);
  });

  it("activates on a real terminal", () => {
    const terminal = new Terminal({ allowProposedApi: true, cols: 20, rows: 5 });
    activateTerminalUnicodeProvider(terminal);
    expect(terminal.unicode.activeVersion).toBe(LAYMUX_UNICODE_VERSION);
    terminal.dispose();
  });
});
