// GENERATED FILE - DO NOT EDIT.
// Source: ui/src/lib/terminal-unicode-width.ts
//         via ui/src/remote/unicode-provider-entry.ts
// Rebuild: cd ui && npm run build:remote-provider
// Drift from the source is caught by ui/src/lib/remote-unicode-provider.test.ts
(function() {
	//#region src/lib/terminal-unicode-width.ts
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
	var LAYMUX_UNICODE_VERSION = "laymux-grapheme-11";
	var ZERO_WIDTH_JOINER = 8205;
	var VARIATION_SELECTOR_EMOJI = 65039;
	var REGIONAL_INDICATOR_FIRST = 127462;
	var REGIONAL_INDICATOR_LAST = 127487;
	var EMOJI_MODIFIER_FIRST = 127995;
	var EMOJI_MODIFIER_LAST = 127999;
	var SOFT_HYPHEN = 173;
	/** Cells an emoji presentation cluster occupies regardless of its base width. */
	var EMOJI_PRESENTATION_WIDTH = 2;
	function createCharProperties(clusterState, cellWidth, shouldJoin) {
		return (clusterState & 16777215) << 3 | (cellWidth & 3) << 1 | (shouldJoin ? 1 : 0);
	}
	function extractShouldJoin(properties) {
		return (properties & 1) !== 0;
	}
	function extractCellWidth(properties) {
		return properties >> 1 & 3;
	}
	function extractClusterState(properties) {
		return properties >> 3;
	}
	/**
	* Cluster continuation states carried in the low bits of the state field.
	* Read them through `CLUSTER_CONTINUATION_MASK` — the state field also carries
	* base-property flags in higher bits.
	*/
	var CLUSTER_STATE_NONE = 0;
	/** The previous code point was a ZWJ, so the next one continues the cluster. */
	var CLUSTER_STATE_AFTER_ZWJ = 1;
	/** An unpaired regional indicator is open; the next one completes the flag. */
	var CLUSTER_STATE_OPEN_REGIONAL_INDICATOR = 2;
	var CLUSTER_CONTINUATION_MASK = 3;
	/**
	* Base-property flags describing the cluster's current attachment point, so the
	* next code point can tell whether it may extend it. `charProperties` only
	* receives the previous *property value*, never the previous code point, so the
	* properties an extender has to check must travel inside the state field.
	*/
	/** The attachment point is an emoji, so a following VS16 selects emoji presentation. */
	var CLUSTER_FLAG_EMOJI_BASE = 4;
	/** The attachment point accepts a skin tone modifier. */
	var CLUSTER_FLAG_EMOJI_MODIFIER_BASE = 8;
	var CLUSTER_FLAG_MASK = 12;
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
	var WIDE_RANGES = [
		[4352, 4447],
		[8986, 8987],
		[9001, 9002],
		[9193, 9196],
		[9200, 9200],
		[9203, 9203],
		[9725, 9726],
		[9748, 9749],
		[9800, 9811],
		[9855, 9855],
		[9875, 9875],
		[9889, 9889],
		[9898, 9899],
		[9917, 9918],
		[9924, 9925],
		[9934, 9934],
		[9940, 9940],
		[9962, 9962],
		[9970, 9971],
		[9973, 9973],
		[9978, 9978],
		[9981, 9981],
		[9989, 9989],
		[9994, 9995],
		[10024, 10024],
		[10060, 10060],
		[10062, 10062],
		[10067, 10069],
		[10071, 10071],
		[10133, 10135],
		[10160, 10160],
		[10175, 10175],
		[11035, 11036],
		[11088, 11088],
		[11093, 11093],
		[11904, 11929],
		[11931, 12019],
		[12032, 12245],
		[12272, 12287],
		[12288, 12350],
		[12353, 12438],
		[12441, 12543],
		[12549, 12591],
		[12593, 12686],
		[12688, 12771],
		[12784, 12830],
		[12832, 12871],
		[12880, 13055],
		[13056, 19903],
		[19968, 42124],
		[42128, 42182],
		[43360, 43388],
		[44032, 55203],
		[63744, 64255],
		[65040, 65049],
		[65072, 65106],
		[65108, 65126],
		[65128, 65131],
		[65281, 65376],
		[65504, 65510],
		[94176, 94180],
		[94192, 94193],
		[94208, 100343],
		[100352, 101589],
		[101632, 101640],
		[110576, 110579],
		[110581, 110587],
		[110589, 110590],
		[110592, 110882],
		[110898, 110898],
		[110928, 110930],
		[110933, 110933],
		[110948, 110951],
		[110960, 111355],
		[126980, 126980],
		[127183, 127183],
		[127374, 127374],
		[127377, 127386],
		[127488, 127490],
		[127504, 127547],
		[127552, 127560],
		[127568, 127569],
		[127584, 127589],
		[127744, 127776],
		[127789, 127797],
		[127799, 127868],
		[127870, 127891],
		[127904, 127946],
		[127951, 127955],
		[127968, 127984],
		[127988, 127988],
		[127992, 128062],
		[128064, 128064],
		[128066, 128252],
		[128255, 128317],
		[128331, 128334],
		[128336, 128359],
		[128378, 128378],
		[128405, 128406],
		[128420, 128420],
		[128507, 128591],
		[128640, 128709],
		[128716, 128716],
		[128720, 128722],
		[128725, 128727],
		[128732, 128735],
		[128747, 128748],
		[128756, 128764],
		[128992, 129003],
		[129008, 129008],
		[129292, 129338],
		[129340, 129349],
		[129351, 129535],
		[129648, 129660],
		[129664, 129673],
		[129679, 129734],
		[129742, 129756],
		[129759, 129769],
		[129776, 129784],
		[131072, 196605],
		[196608, 262141]
	];
	/**
	* Conjoining Hangul jamo (vowels and trailing consonants). East Asian Width
	* calls them Neutral, but they compose onto the preceding leading jamo and
	* advance no cell — xterm's own V6 table treats the block the same way.
	*/
	var CONJOINING_JAMO_FIRST = 4448;
	var CONJOINING_JAMO_LAST = 4607;
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
	var ZERO_WIDTH_CATEGORY = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
	/**
	* Emoji base properties, needed to decide whether an extender may promote or
	* attach at all. `\p{Emoji}` (not `\p{Extended_Pictographic}`) is the VS16 gate
	* because keycap bases are ASCII digits/`#`/`*` — emoji, but not pictographic.
	*/
	var EMOJI_CATEGORY = /^\p{Emoji}$/u;
	var EMOJI_MODIFIER_BASE_CATEGORY = /^\p{Emoji_Modifier_Base}$/u;
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
	var CACHE_LIMIT = 1114112;
	var CACHE_WIDTH_MASK = 3;
	var CACHE_FLAG_EMOJI = 4;
	var CACHE_FLAG_EMOJI_MODIFIER_BASE = 8;
	var propertyCache = new Uint8Array(CACHE_LIMIT);
	function isWideCodePoint(codePoint) {
		let low = 0;
		let high = WIDE_RANGES.length - 1;
		if (codePoint < WIDE_RANGES[0][0] || codePoint > WIDE_RANGES[high][1]) return false;
		while (low <= high) {
			const mid = low + high >> 1;
			const range = WIDE_RANGES[mid];
			if (codePoint < range[0]) high = mid - 1;
			else if (codePoint > range[1]) low = mid + 1;
			else return true;
		}
		return false;
	}
	function isZeroWidthCodePoint(codePoint) {
		if (codePoint === SOFT_HYPHEN) return false;
		if (codePoint >= CONJOINING_JAMO_FIRST && codePoint <= CONJOINING_JAMO_LAST) return true;
		return ZERO_WIDTH_CATEGORY.test(String.fromCodePoint(codePoint));
	}
	function computeCodePointCellWidth(codePoint) {
		if (codePoint < 32) return 0;
		if (codePoint < 127) return 1;
		if (codePoint < 160) return 0;
		if (isZeroWidthCodePoint(codePoint)) return 0;
		if (isWideCodePoint(codePoint)) return 2;
		return 1;
	}
	function computeCacheEntry(codePoint) {
		let entry = computeCodePointCellWidth(codePoint) + 1;
		if (entry > 1) {
			const char = String.fromCodePoint(codePoint);
			if (EMOJI_CATEGORY.test(char)) entry |= CACHE_FLAG_EMOJI;
			if (EMOJI_MODIFIER_BASE_CATEGORY.test(char)) entry |= CACHE_FLAG_EMOJI_MODIFIER_BASE;
		}
		return entry;
	}
	function cacheEntry(codePoint) {
		const cached = propertyCache[codePoint];
		if (cached !== 0) return cached;
		const entry = computeCacheEntry(codePoint);
		propertyCache[codePoint] = entry;
		return entry;
	}
	/** Cells one code point occupies, ignoring cluster context. */
	function codePointCellWidth(codePoint) {
		if (codePoint < 0 || codePoint >= CACHE_LIMIT) return 1;
		return (cacheEntry(codePoint) & CACHE_WIDTH_MASK) - 1;
	}
	function isRegionalIndicator(codePoint) {
		return codePoint >= REGIONAL_INDICATOR_FIRST && codePoint <= REGIONAL_INDICATOR_LAST;
	}
	function isEmojiModifier(codePoint) {
		return codePoint >= EMOJI_MODIFIER_FIRST && codePoint <= EMOJI_MODIFIER_LAST;
	}
	/**
	* Base flags to hand the next code point, describing what this one accepts as an
	* extender. Out-of-range code points report nothing, matching their width 1.
	*/
	function baseFlagsFor(codePoint) {
		if (codePoint < 0 || codePoint >= CACHE_LIMIT) return 0;
		const entry = cacheEntry(codePoint);
		let flags = 0;
		if ((entry & CACHE_FLAG_EMOJI) !== 0) flags |= CLUSTER_FLAG_EMOJI_BASE;
		if ((entry & CACHE_FLAG_EMOJI_MODIFIER_BASE) !== 0) flags |= CLUSTER_FLAG_EMOJI_MODIFIER_BASE;
		return flags;
	}
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
	function charProperties(codePoint, preceding) {
		const width = codePointCellWidth(codePoint);
		const precedingWidth = extractCellWidth(preceding);
		const precedingState = extractClusterState(preceding);
		const precedingContinuation = precedingState & CLUSTER_CONTINUATION_MASK;
		const precedingFlags = precedingState & CLUSTER_FLAG_MASK;
		const canJoin = preceding !== 0 && precedingWidth > 0;
		if (codePoint === ZERO_WIDTH_JOINER) return canJoin ? createCharProperties(CLUSTER_STATE_AFTER_ZWJ, precedingWidth, true) : createCharProperties(CLUSTER_STATE_AFTER_ZWJ, width, false);
		if (precedingContinuation === CLUSTER_STATE_AFTER_ZWJ && canJoin) return createCharProperties(CLUSTER_STATE_NONE | baseFlagsFor(codePoint), Math.max(precedingWidth, width), true);
		if (isRegionalIndicator(codePoint)) {
			if (precedingContinuation === CLUSTER_STATE_OPEN_REGIONAL_INDICATOR && canJoin) return createCharProperties(CLUSTER_STATE_NONE, Math.max(precedingWidth, EMOJI_PRESENTATION_WIDTH), true);
			return createCharProperties(CLUSTER_STATE_OPEN_REGIONAL_INDICATOR, width, false);
		}
		if (isEmojiModifier(codePoint)) {
			if (canJoin && (precedingFlags & CLUSTER_FLAG_EMOJI_MODIFIER_BASE) !== 0) return createCharProperties(CLUSTER_STATE_NONE | precedingFlags, Math.max(precedingWidth, EMOJI_PRESENTATION_WIDTH), true);
			return createCharProperties(CLUSTER_STATE_NONE | baseFlagsFor(codePoint), width, false);
		}
		if (canJoin && width === 0) {
			const clusterWidth = codePoint === VARIATION_SELECTOR_EMOJI && (precedingFlags & CLUSTER_FLAG_EMOJI_BASE) !== 0 ? Math.max(precedingWidth, EMOJI_PRESENTATION_WIDTH) : precedingWidth;
			return createCharProperties(CLUSTER_STATE_NONE | precedingFlags, clusterWidth, true);
		}
		return createCharProperties(CLUSTER_STATE_NONE | baseFlagsFor(codePoint), width, false);
	}
	function forEachCodePoint(text, visit) {
		let precedingProperties = 0;
		for (let index = 0; index < text.length;) {
			const codePoint = text.codePointAt(index);
			if (codePoint === void 0) break;
			const length = codePoint > 65535 ? 2 : 1;
			const properties = charProperties(codePoint, precedingProperties);
			visit({
				codePoint,
				length,
				properties,
				precedingProperties
			});
			precedingProperties = properties;
			index += length;
		}
	}
	/**
	* Split `text` into the cell clusters xterm will build, so callers can lay out
	* rows without ever cutting a ZWJ sequence, variation selector or combining
	* mark away from its base character.
	*/
	function splitCellClusters(text) {
		const clusters = [];
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
			clusters.push({
				segment,
				width
			});
		});
		return clusters;
	}
	//#endregion
	//#region src/remote/unicode-provider-entry.ts
	/**
	* Remote-client entry for the shared cell-width provider.
	*
	* Issue #538. The Direct Remote Mode browser client loads a committed xterm
	* bundle and, until now, no provider — so it kept xterm's default Unicode 6
	* widths while the desktop registers `terminal-unicode-width.ts`. Measured
	* divergence: 89 BMP code points and effectively every supplementary-plane
	* emoji report 1 cell on remote and 2 on the desktop, so the same PTY output
	* wraps at different columns on the two surfaces.
	*
	* Copying the width table into `page.html` would recreate the two-sources-of-
	* truth split ADR-0058 exists to remove. Instead this entry is **built from the
	* same module** into `src-tauri/src/remote_server/assets/unicode-provider.js`
	* (`npm run build:remote-provider`) and served alongside the xterm bundle. The
	* generated asset is committed because the Rust server embeds its assets with
	* `include_str!`; `remote-unicode-provider.test.ts` re-derives the widths from
	* the TypeScript source and fails if the committed asset has drifted.
	*
	* The global is a plain object rather than a module export: `page.html` loads
	* classic scripts, the same way it picks up `window.Terminal`.
	*/
	window.LaymuxUnicodeProvider = {
		version: LAYMUX_UNICODE_VERSION,
		wcwidth: codePointCellWidth,
		charProperties,
		splitCellClusters
	};
	//#endregion
})();
