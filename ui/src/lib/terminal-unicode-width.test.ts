import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";

import {
  LAYMUX_UNICODE_VERSION,
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

  it("treats emoji and CJK extension planes as double width", () => {
    expect(codePointCellWidth(0x1f468)).toBe(2); // man
    expect(codePointCellWidth(0x1f3fb)).toBe(2); // skin tone modifier
    expect(codePointCellWidth(0x20000)).toBe(2); // CJK extension B
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

  it("keeps a keycap sequence in one cluster", () => {
    expect(clusterSegments(`1${VS16}${KEYCAP}`)).toEqual([`1${VS16}${KEYCAP}`]);
    expect(clusterWidths(`1${VS16}${KEYCAP}`)).toEqual([2]);
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
    ];
    for (const sample of samples) {
      expect(clusterSegments(sample).join("")).toBe(sample);
      expect(clusterWidths(sample).reduce((sum, width) => sum + width, 0)).toBe(
        stringCellWidth(sample),
      );
    }
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
