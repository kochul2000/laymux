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

/** Cluster continuation states carried in the property value's state field. */
const CLUSTER_STATE_NONE = 0;
/** The previous code point was a ZWJ, so the next one continues the cluster. */
const CLUSTER_STATE_AFTER_ZWJ = 1;
/** An unpaired regional indicator is open; the next one completes the flag. */
const CLUSTER_STATE_OPEN_REGIONAL_INDICATOR = 2;

// ---------------------------------------------------------------------------
// wcwidth
// ---------------------------------------------------------------------------

/**
 * East Asian Wide / Fullwidth ranges (Unicode 11 baseline plus later emoji
 * blocks). Sorted and non-overlapping — `isWideCodePoint` binary searches it.
 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
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
 */
const ZERO_WIDTH_CATEGORY = /^[\p{Mn}\p{Me}\p{Cf}]$/u;

/**
 * Lazy per-code-point width cache. `charProperties` runs for every printed code
 * point, so the property-escape test must not be on the hot path. Values are
 * `width + 1`; 0 means "not computed yet".
 */
const CACHE_LIMIT = 0x20000;
const widthCache = new Uint8Array(CACHE_LIMIT);

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
  if (isZeroWidthCodePoint(codePoint)) return 0;
  if (isWideCodePoint(codePoint)) return 2;
  return 1;
}

/** Cells one code point occupies, ignoring cluster context. */
export function codePointCellWidth(codePoint: number): 0 | 1 | 2 {
  if (codePoint < 0 || codePoint > 0x10ffff) return 1;
  if (codePoint >= CACHE_LIMIT) return computeCodePointCellWidth(codePoint);
  const cached = widthCache[codePoint];
  if (cached !== 0) return (cached - 1) as 0 | 1 | 2;
  const width = computeCodePointCellWidth(codePoint);
  widthCache[codePoint] = width + 1;
  return width;
}

function isRegionalIndicator(codePoint: number): boolean {
  return codePoint >= REGIONAL_INDICATOR_FIRST && codePoint <= REGIONAL_INDICATOR_LAST;
}

function isEmojiModifier(codePoint: number): boolean {
  return codePoint >= EMOJI_MODIFIER_FIRST && codePoint <= EMOJI_MODIFIER_LAST;
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
  // would be on its own (family/profession emoji).
  if (precedingState === CLUSTER_STATE_AFTER_ZWJ && canJoin) {
    return createCharProperties(CLUSTER_STATE_NONE, Math.max(precedingWidth, width), true);
  }

  // Regional indicators pair up into one flag cell pair; a third one opens a
  // new pair instead of extending the previous flag.
  if (isRegionalIndicator(codePoint)) {
    if (precedingState === CLUSTER_STATE_OPEN_REGIONAL_INDICATOR && canJoin) {
      return createCharProperties(
        CLUSTER_STATE_NONE,
        Math.max(precedingWidth, EMOJI_PRESENTATION_WIDTH),
        true,
      );
    }
    return createCharProperties(CLUSTER_STATE_OPEN_REGIONAL_INDICATOR, width, false);
  }

  // Cluster extenders: combining marks, variation selectors, keycap enclosures,
  // tag sequences (all zero width) and skin tone modifiers (wide on their own,
  // but never a cell of their own).
  if (canJoin && (width === 0 || isEmojiModifier(codePoint))) {
    const promotesToEmojiPresentation =
      codePoint === VARIATION_SELECTOR_EMOJI || isEmojiModifier(codePoint);
    const clusterWidth = promotesToEmojiPresentation
      ? Math.max(precedingWidth, EMOJI_PRESENTATION_WIDTH)
      : Math.max(precedingWidth, width);
    return createCharProperties(CLUSTER_STATE_NONE, clusterWidth, true);
  }

  return createCharProperties(CLUSTER_STATE_NONE, width, false);
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
