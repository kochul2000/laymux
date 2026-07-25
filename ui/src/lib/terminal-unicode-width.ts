import type { IUnicodeVersionProvider, Terminal } from "@xterm/xterm";

/**
 * Single source of truth for terminal cell width.
 *
 * xterm.js decides how many cells a printed code point consumes by asking the
 * active `IUnicodeVersionProvider`. The IME composition preview has to place
 * its row fragments and caret on exactly the cells the committed text will
 * occupy, so it must not carry a second width table: this module owns the
 * width/grapheme contract and is registered into every terminal through
 * `activateTerminalUnicodeProvider()`.
 *
 * Grapheme handling lives in `charProperties()` rather than in a separate
 * segmenter. xterm's `InputHandler.print()` derives cluster membership purely
 * from the `shouldJoin` bit this function returns, so encoding the rules there
 * is what keeps `splitCellClusters()` and the buffer in agreement — including
 * the "combining character widens 1 column to 2" wrap path xterm implements for
 * joined cells.
 */

/** Version key this provider registers under in xterm's unicode service. */
export const LAYMUX_UNICODE_VERSION = "laymux-grapheme-11";

const ZERO_WIDTH_JOINER = 0x200d;
const VARIATION_SELECTOR_EMOJI = 0xfe0f;
const REGIONAL_INDICATOR_FIRST = 0x1f1e6;
const REGIONAL_INDICATOR_LAST = 0x1f1ff;
const EMOJI_MODIFIER_FIRST = 0x1f3fb;
const EMOJI_MODIFIER_LAST = 0x1f3ff;
const SOFT_HYPHEN = 0x00ad;

/** Cells an emoji presentation cluster occupies regardless of its base width. */
const EMOJI_PRESENTATION_WIDTH = 2;

// ---------------------------------------------------------------------------
// Property value packing — must stay bit-compatible with xterm's
// UnicodeService.createPropertyValue / extractWidth / extractShouldJoin, since
// xterm packs and unpacks the values this provider returns.
// ---------------------------------------------------------------------------

export function createCharProperties(
  clusterState: number,
  cellWidth: number,
  shouldJoin: boolean,
): number {
  return ((clusterState & 0xffffff) << 3) | ((cellWidth & 3) << 1) | (shouldJoin ? 1 : 0);
}

export function extractShouldJoin(properties: number): boolean {
  return (properties & 1) !== 0;
}

export function extractCellWidth(properties: number): 0 | 1 | 2 {
  return ((properties >> 1) & 0x3) as 0 | 1 | 2;
}

export function extractClusterState(properties: number): number {
  return properties >> 3;
}

/**
 * Cluster continuation states carried in the low bits of the state field.
 * Read them through `CLUSTER_CONTINUATION_MASK` — the state field also carries
 * base-property flags in higher bits.
 */
const CLUSTER_STATE_NONE = 0;
/** The previous code point was a ZWJ, so the next one continues the cluster. */
const CLUSTER_STATE_AFTER_ZWJ = 1;
/** An unpaired regional indicator is open; the next one completes the flag. */
const CLUSTER_STATE_OPEN_REGIONAL_INDICATOR = 2;
const CLUSTER_CONTINUATION_MASK = 0x3;

/**
 * Base-property flags describing the cluster's current attachment point, so the
 * next code point can tell whether it may extend it. `charProperties` only
 * receives the previous *property value*, never the previous code point, so the
 * properties an extender has to check must travel inside the state field.
 */
/** The attachment point is an emoji, so a following VS16 selects emoji presentation. */
const CLUSTER_FLAG_EMOJI_BASE = 0x4;
/** The attachment point accepts a skin tone modifier. */
const CLUSTER_FLAG_EMOJI_MODIFIER_BASE = 0x8;
const CLUSTER_FLAG_MASK = CLUSTER_FLAG_EMOJI_BASE | CLUSTER_FLAG_EMOJI_MODIFIER_BASE;

// ---------------------------------------------------------------------------
// wcwidth
// ---------------------------------------------------------------------------

/**
 * East Asian Wide / Fullwidth ranges. Sorted and non-overlapping —
 * `isWideCodePoint` binary searches it.
 *
 * The table is a **subset of `EastAsianWidth=W ∪ F`**, verified against the UCD:
 * every member is W or F in Unicode 17, and nothing that is W/F *and* `gc=Mc` is
 * missing from it. That subset property is what the `Mc` reasoning below relies
 * on, so it is the invariant to preserve when editing.
 *
 * It is **not** "Unicode 11 plus later emoji blocks" — an earlier version of this
 * comment said that and it is wrong. 719 members are not W/F in Unicode 11, and
 * they are not all emoji: ideographic description characters
 * (`U+2FFC`–`U+2FFF`), `U+31BB`–`U+31BF`, `U+16FE2`–`U+16FE4`,
 * `U+16FF0`–`U+16FF1`, Tangut Components (`U+187F2`–`U+187F7`), Khitan
 * (`U+18AF3`–`U+18CD5`), Kana Extended-B (`U+1AFF0`–`U+1AFFE`), Nushu/Kana
 * (`U+1B11F`–`U+1B167`). Conversely `U+1F93B` and `U+1F946` are W in Unicode 11
 * and absent here.
 *
 * The table also lags current UCD by design: 349 code points that are W/F in
 * Unicode 17 are absent because their EAW value changed after the table was
 * built (Yijing `U+4DC0`–`U+4DFF`, Tai Xuan Jing `U+1D300`–`U+1D356`, trigrams
 * `U+2630`–`U+2637`, counting rods `U+1D360`–`U+1D376`). Adding them is a
 * separate decision — widening a code point changes wrap columns for every
 * surface at once.
 */
export const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x2e99],
  [0x2e9b, 0x2ef3],
  [0x2f00, 0x2fd5],
  [0x2ff0, 0x2fff],
  [0x3000, 0x303e],
  [0x3041, 0x3096],
  [0x3099, 0x30ff],
  [0x3105, 0x312f],
  [0x3131, 0x318e],
  [0x3190, 0x31e3],
  [0x31f0, 0x321e],
  [0x3220, 0x3247],
  [0x3250, 0x32ff],
  [0x3300, 0x4dbf],
  [0x4e00, 0xa48c],
  [0xa490, 0xa4c6],
  [0xa960, 0xa97c],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe52],
  [0xfe54, 0xfe66],
  [0xfe68, 0xfe6b],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x16ff0, 0x16ff1],
  [0x17000, 0x187f7],
  [0x18800, 0x18cd5],
  [0x18d00, 0x18d08],
  [0x1aff0, 0x1aff3],
  [0x1aff5, 0x1affb],
  [0x1affd, 0x1affe],
  [0x1b000, 0x1b122],
  [0x1b132, 0x1b132],
  [0x1b150, 0x1b152],
  [0x1b155, 0x1b155],
  [0x1b164, 0x1b167],
  [0x1b170, 0x1b2fb],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f202],
  [0x1f210, 0x1f23b],
  [0x1f240, 0x1f248],
  [0x1f250, 0x1f251],
  [0x1f260, 0x1f265],
  [0x1f300, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6dc, 0x1f6df],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1fa7c],
  [0x1fa80, 0x1fa89],
  [0x1fa8f, 0x1fac6],
  [0x1face, 0x1fadc],
  [0x1fadf, 0x1fae9],
  [0x1faf0, 0x1faf8],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

/**
 * Conjoining Hangul jamo (vowels and trailing consonants). East Asian Width
 * calls them Neutral, but they compose onto the preceding leading jamo and
 * advance no cell — xterm's own V6 table treats the block the same way.
 */
const CONJOINING_JAMO_FIRST = 0x1160;
const CONJOINING_JAMO_LAST = 0x11ff;

/**
 * Nonspacing/enclosing marks and format characters. Using Unicode property
 * escapes keeps the zero-width set in sync with the engine's Unicode data
 * instead of a hand-maintained range list that has to grow every release.
 *
 * `\p{Mc}` is deliberately **excluded**, and the reason that decides it is
 * ADR-0058's invariant: the width has to be **the same number the program on the
 * other side of the PTY computes**. Kuhn/glibc-family `wcwidth` puts only
 * `Mn`/`Me` in its combining table and defers everything else to East Asian
 * Width, so a shell or TUI counts `Mc` by its EAW value. `Mc` is
 * Spacing_Combining_Mark — it advances a cell by definition — so our answer
 * matches theirs, and xterm's V6 zero is the outlier.
 *
 * Measured over the whole range: 471 code points are `Mc`, and 467 resolve to
 * width 1 here, matching V6 exactly (Devanagari `U+0903`/`U+093B`/`U+093E`, Thai
 * `U+0E33`, Lao `U+0EB3`, Balinese `U+1B44`, …).
 *
 * The remaining 4 sit inside `WIDE_RANGES` and resolve to 2: `U+302E`/`U+302F`
 * (Hangul tone marks, EAW=W, introduced in Unicode 1.1) and
 * `U+16FF0`/`U+16FF1` (Vietnamese alternate reading marks, EAW=W, Unicode 13).
 * V6 reports 0 for the first pair because it zeroes the whole `U+302A`–`U+302F`
 * run without separating `Mn` from `Mc`. Folding `Mc` into the zero-width set to
 * match V6 would silently change the width of 467 Indic/SEA marks *and* diverge
 * from the PTY side.
 *
 * A font that draws these with zero advance is a **different axis**: the glyph
 * would look misplaced, but the column arithmetic would still agree with the
 * shell. Narrowing the width to match such a font is what would break agreement.
 * So font inspection is visual QA here, not grounds to change the width.
 *
 * `terminal-unicode-width.test.ts` pins the four widths **and** their
 * `shouldJoin` bit — width alone would still pass if someone wired `Mc` into the
 * cluster-join condition only (issue #547).
 */
const ZERO_WIDTH_CATEGORY = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/**
 * Emoji base properties, needed to decide whether an extender may promote or
 * attach at all. `\p{Emoji}` (not `\p{Extended_Pictographic}`) is the VS16 gate
 * because keycap bases are ASCII digits/`#`/`*` — emoji, but not pictographic.
 */
const EMOJI_CATEGORY = /^\p{Emoji}$/u;
const EMOJI_MODIFIER_BASE_CATEGORY = /^\p{Emoji_Modifier_Base}$/u;

/**
 * Lazy per-code-point property cache covering the whole Unicode range, so the
 * property-escape tests never run twice for a code point. `charProperties` runs
 * for every printed code point, and the supplementary planes carry both hot
 * content (CJK extension B–D) and emoji bases, so a cache that stops below
 * U+20000 would leave regex work on the hot path for exactly those.
 *
 * Layout per entry: bits 0-1 = `width + 1` (0 means "not computed yet"),
 * bit 2 = `\p{Emoji}`, bit 3 = `\p{Emoji_Modifier_Base}`.
 */
const CACHE_LIMIT = 0x110000;
const CACHE_WIDTH_MASK = 0x3;
const CACHE_FLAG_EMOJI = 0x4;
const CACHE_FLAG_EMOJI_MODIFIER_BASE = 0x8;
const propertyCache = new Uint8Array(CACHE_LIMIT);

function isWideCodePoint(codePoint: number): boolean {
  let low = 0;
  let high = WIDE_RANGES.length - 1;
  if (codePoint < WIDE_RANGES[0][0] || codePoint > WIDE_RANGES[high][1]) return false;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = WIDE_RANGES[mid];
    if (codePoint < range[0]) high = mid - 1;
    else if (codePoint > range[1]) low = mid + 1;
    else return true;
  }
  return false;
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  if (codePoint === SOFT_HYPHEN) return false;
  if (codePoint >= CONJOINING_JAMO_FIRST && codePoint <= CONJOINING_JAMO_LAST) return true;
  return ZERO_WIDTH_CATEGORY.test(String.fromCodePoint(codePoint));
}

function computeCodePointCellWidth(codePoint: number): 0 | 1 | 2 {
  // C0/C1 controls and DEL never advance the buffer cursor on their own.
  if (codePoint < 0x20) return 0;
  if (codePoint < 0x7f) return 1;
  if (codePoint < 0xa0) return 0;
  // Zero-width first, and it must stay first: the two sets are **not** disjoint.
  // Seven code points are both `Mn` and inside `WIDE_RANGES` — U+302A–U+302D
  // (ideographic tone marks), U+3099/U+309A (the Japanese voiced/semi-voiced
  // sound marks, i.e. ordinary NFD Japanese text) and U+16FE4. Checking wide
  // first reports those as 2 cells, which also makes them fail
  // `charProperties`'s `width === 0` join test and become their own clusters.
  // `terminal-unicode-width.test.ts` asserts the intersection exhaustively so a
  // future reorder fails loudly instead of relying on this comment.
  //
  // Ordering costs nothing either way. `computeCacheEntry` runs the two emoji
  // property escapes for every entry wider than zero, so a wide code point
  // already pays a property-escape on first touch no matter which check comes
  // first — the original "keeps the property-escape test off the first-touch
  // path" goal was never reachable. On top of that `cacheEntry` memoizes the
  // whole Unicode range, so any given code point pays at most once per session.
  if (isZeroWidthCodePoint(codePoint)) return 0;
  if (isWideCodePoint(codePoint)) return 2;
  return 1;
}

function computeCacheEntry(codePoint: number): number {
  let entry = computeCodePointCellWidth(codePoint) + 1;
  // Only code points that can print can serve as a cluster attachment point,
  // and the emoji properties are only ever read for such a base.
  if (entry > 1) {
    const char = String.fromCodePoint(codePoint);
    if (EMOJI_CATEGORY.test(char)) entry |= CACHE_FLAG_EMOJI;
    if (EMOJI_MODIFIER_BASE_CATEGORY.test(char)) entry |= CACHE_FLAG_EMOJI_MODIFIER_BASE;
  }
  return entry;
}

function cacheEntry(codePoint: number): number {
  const cached = propertyCache[codePoint];
  if (cached !== 0) return cached;
  const entry = computeCacheEntry(codePoint);
  propertyCache[codePoint] = entry;
  return entry;
}

/** Cells one code point occupies, ignoring cluster context. */
export function codePointCellWidth(codePoint: number): 0 | 1 | 2 {
  if (codePoint < 0 || codePoint >= CACHE_LIMIT) return 1;
  return ((cacheEntry(codePoint) & CACHE_WIDTH_MASK) - 1) as 0 | 1 | 2;
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= REGIONAL_INDICATOR_FIRST && codePoint <= REGIONAL_INDICATOR_LAST;
}

function isEmojiModifier(codePoint: number): boolean {
  return codePoint >= EMOJI_MODIFIER_FIRST && codePoint <= EMOJI_MODIFIER_LAST;
}

/**
 * Base flags to hand the next code point, describing what this one accepts as an
 * extender. Out-of-range code points report nothing, matching their width 1.
 */
function baseFlagsFor(codePoint: number): number {
  if (codePoint < 0 || codePoint >= CACHE_LIMIT) return 0;
  const entry = cacheEntry(codePoint);
  let flags = 0;
  if ((entry & CACHE_FLAG_EMOJI) !== 0) flags |= CLUSTER_FLAG_EMOJI_BASE;
  if ((entry & CACHE_FLAG_EMOJI_MODIFIER_BASE) !== 0) flags |= CLUSTER_FLAG_EMOJI_MODIFIER_BASE;
  return flags;
}

// ---------------------------------------------------------------------------
// Grapheme cluster joining
// ---------------------------------------------------------------------------

/**
 * xterm's provider contract: report the cell width of `codePoint` and whether
 * it merges into the cell the previous code point produced.
 *
 * `preceding` is the value this function returned for the previous code point
 * of the same run, or 0 at a run/line start. When `shouldJoin` is set, the
 * reported width is the width of the whole cluster so far — xterm subtracts the
 * preceding width, so a cluster only ever claims extra cells when it actually
 * grows (`emoji + VS16` going from one cell to two).
 */
export function charProperties(codePoint: number, preceding: number): number {
  const width = codePointCellWidth(codePoint);
  const precedingWidth = extractCellWidth(preceding);
  const precedingState = extractClusterState(preceding);
  const precedingContinuation = precedingState & CLUSTER_CONTINUATION_MASK;
  const precedingFlags = precedingState & CLUSTER_FLAG_MASK;
  // A preceding cell can only absorb a continuation if it actually occupies
  // cells; a zero-width run start has nothing to attach to.
  const canJoin = preceding !== 0 && precedingWidth > 0;

  // ZWJ attaches to the current cluster and arms the next code point.
  if (codePoint === ZERO_WIDTH_JOINER) {
    return canJoin
      ? createCharProperties(CLUSTER_STATE_AFTER_ZWJ, precedingWidth, true)
      : createCharProperties(CLUSTER_STATE_AFTER_ZWJ, width, false);
  }

  // Whatever follows a joining ZWJ belongs to the same cluster, however wide it
  // would be on its own (family/profession emoji). It becomes the new attachment
  // point, so a skin tone modifier can still follow each member of the sequence.
  if (precedingContinuation === CLUSTER_STATE_AFTER_ZWJ && canJoin) {
    return createCharProperties(
      CLUSTER_STATE_NONE | baseFlagsFor(codePoint),
      Math.max(precedingWidth, width),
      true,
    );
  }

  // Regional indicators pair up into one flag cell pair; a third one opens a
  // new pair instead of extending the previous flag.
  if (isRegionalIndicator(codePoint)) {
    if (precedingContinuation === CLUSTER_STATE_OPEN_REGIONAL_INDICATOR && canJoin) {
      return createCharProperties(
        CLUSTER_STATE_NONE,
        Math.max(precedingWidth, EMOJI_PRESENTATION_WIDTH),
        true,
      );
    }
    return createCharProperties(CLUSTER_STATE_OPEN_REGIONAL_INDICATOR, width, false);
  }

  // Skin tone modifiers extend an Emoji_Modifier_Base and nothing else. After a
  // base that cannot take one (`a\u{1f3fb}`) the modifier is its own two-cell
  // cluster, which is what a font draws — a standalone swatch.
  if (isEmojiModifier(codePoint)) {
    if (canJoin && (precedingFlags & CLUSTER_FLAG_EMOJI_MODIFIER_BASE) !== 0) {
      return createCharProperties(
        CLUSTER_STATE_NONE | precedingFlags,
        Math.max(precedingWidth, EMOJI_PRESENTATION_WIDTH),
        true,
      );
    }
    return createCharProperties(CLUSTER_STATE_NONE | baseFlagsFor(codePoint), width, false);
  }

  // Zero-width extenders: combining marks, variation selectors, keycap
  // enclosures and tag sequences. They keep the cluster's attachment point, so
  // `1️⃣` still knows the keycap encloses an emoji base.
  if (canJoin && width === 0) {
    // VS16 only selects emoji presentation for a base that has an emoji form.
    // After a non-emoji base (`a️`) it is an inert zero-width selector, and
    // widening that cell to two would leave a blank column the font never fills.
    const promotesToEmojiPresentation =
      codePoint === VARIATION_SELECTOR_EMOJI && (precedingFlags & CLUSTER_FLAG_EMOJI_BASE) !== 0;
    const clusterWidth = promotesToEmojiPresentation
      ? Math.max(precedingWidth, EMOJI_PRESENTATION_WIDTH)
      : precedingWidth;
    return createCharProperties(CLUSTER_STATE_NONE | precedingFlags, clusterWidth, true);
  }

  return createCharProperties(CLUSTER_STATE_NONE | baseFlagsFor(codePoint), width, false);
}

/** The provider both xterm and the composition preview read widths from. */
export const terminalUnicodeProvider: IUnicodeVersionProvider = {
  version: LAYMUX_UNICODE_VERSION,
  wcwidth: codePointCellWidth,
  charProperties,
};

/**
 * Register the shared provider and make it active.
 *
 * Must run before the terminal's first `write()` (live PTY output or session
 * restore) so no row is ever laid out with xterm's default Unicode 6 widths and
 * then measured with these. Requires `allowProposedApi`; a throw here is a
 * wiring bug and must not be swallowed — silently falling back would restore
 * the two-sources-of-truth split this module exists to remove.
 */
export function activateTerminalUnicodeProvider(terminal: Pick<Terminal, "unicode">): void {
  terminal.unicode.register(terminalUnicodeProvider);
  terminal.unicode.activeVersion = LAYMUX_UNICODE_VERSION;
}

// ---------------------------------------------------------------------------
// String helpers built on the same provider
// ---------------------------------------------------------------------------

type CodePointStep = {
  codePoint: number;
  /** UTF-16 length of this code point (1, or 2 for a surrogate pair). */
  length: number;
  properties: number;
  precedingProperties: number;
};

function forEachCodePoint(text: string, visit: (step: CodePointStep) => void): void {
  let precedingProperties = 0;
  for (let index = 0; index < text.length; ) {
    const codePoint = text.codePointAt(index);
    if (codePoint === undefined) break;
    const length = codePoint > 0xffff ? 2 : 1;
    const properties = charProperties(codePoint, precedingProperties);
    visit({ codePoint, length, properties, precedingProperties });
    precedingProperties = properties;
    index += length;
  }
}

/**
 * Cells `text` occupies when printed — the same total xterm's buffer advances
 * by, because it walks the same `charProperties` chain.
 */
export function stringCellWidth(text: string): number {
  let total = 0;
  forEachCodePoint(text, ({ properties, precedingProperties }) => {
    let width: number = extractCellWidth(properties);
    if (extractShouldJoin(properties)) {
      width -= extractCellWidth(precedingProperties);
    }
    total += width;
  });
  return total;
}

/** One user-perceived cluster and the cells it occupies. */
export type CellCluster = {
  segment: string;
  width: number;
};

/**
 * Split `text` into the cell clusters xterm will build, so callers can lay out
 * rows without ever cutting a ZWJ sequence, variation selector or combining
 * mark away from its base character.
 */
export function splitCellClusters(text: string): CellCluster[] {
  const clusters: CellCluster[] = [];
  let index = 0;
  forEachCodePoint(text, ({ length, properties }) => {
    const segment = text.slice(index, index + length);
    index += length;
    const width = extractCellWidth(properties);
    const previous = clusters[clusters.length - 1];
    if (extractShouldJoin(properties) && previous) {
      previous.segment += segment;
      previous.width = width;
      return;
    }
    clusters.push({ segment, width });
  });
  return clusters;
}
