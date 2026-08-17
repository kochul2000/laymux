import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  type CellCluster,
  LAYMUX_UNICODE_VERSION,
  charProperties,
  codePointCellWidth,
  splitCellClusters,
} from "./terminal-unicode-width";

/**
 * The Direct Remote Mode client cannot import TypeScript, so the shared width
 * provider is built into a committed asset the Rust server embeds with
 * `include_str!` (issue #538, `npm run build:remote-provider`).
 *
 * A committed generated file drifts silently the moment someone edits the source
 * without rebuilding — and the symptom would be the very bug this fixes: remote
 * and desktop wrapping at different columns. So these tests **execute the
 * committed asset** and compare its answers against the TypeScript source,
 * across exactly the code points that were measured to diverge from xterm's
 * default table. Byte comparison is deliberately avoided: it would break on
 * every bundler upgrade without any behaviour change.
 */

const ASSET_PATH = resolve(
  __dirname,
  "../../../src-tauri/src/remote_server/assets/unicode-provider.js",
);

type Provider = {
  version: string;
  wcwidth: (codePoint: number) => number;
  charProperties: (codePoint: number, preceding: number) => number;
  splitCellClusters: (text: string) => CellCluster[];
};

/** Run the committed IIFE against a fake `window` and hand back what it installed. */
function loadCommittedProvider(): Provider {
  const source = readFileSync(ASSET_PATH, "utf8");
  const fakeWindow: { LaymuxUnicodeProvider?: Provider } = {};
  // The asset is an IIFE that assigns to `window`; give it one.
  const run = new Function("window", `${source}\nreturn window.LaymuxUnicodeProvider;`);
  const provider = run(fakeWindow) as Provider | undefined;
  if (!provider) throw new Error("committed asset did not install window.LaymuxUnicodeProvider");
  return provider;
}

/**
 * Code points measured to differ between the desktop provider and the xterm V6
 * table the remote bundle ships with. These are what the asset exists to fix, so
 * they are the ones whose drift matters most.
 */
const DIVERGENT_BMP = [
  0x231a, 0x231b, 0x23e9, 0x23ec, 0x23f0, 0x23f3, 0x25fd, 0x2614, 0x2648, 0x2653, 0x267f, 0x2693,
  0x26a1, 0x26aa, 0x26bd, 0x26c4, 0x26ce, 0x26d4, 0x26ea, 0x26f2, 0x26f5, 0x26fa, 0x26fd, 0x2705,
  0x270a, 0x2728, 0x274c, 0x274e, 0x2753, 0x2757, 0x2795, 0x27b0, 0x27bf, 0x2b1b, 0x2b50, 0x2b55,
  0xa960, 0xa97c,
];

const DIVERGENT_SUPPLEMENTARY = [
  0x1f600, 0x1f44d, 0x1f3fb, 0x1f6d5, 0x1fa70, 0x1f9ff, 0x1f004, 0x1f0cf,
];

/** Code points that agree with V6 — regressions here would be just as bad. */
const AGREEING = [0x20000, 0x30000, 0x1f1f0, 0x0301, 0x3099, 0x309a, 0x302a, 0xfe0f, 0x200d, 0x41];

describe("committed remote unicode provider asset", () => {
  const provider = loadCommittedProvider();

  it("installs the same version the source declares", () => {
    expect(provider.version).toBe(LAYMUX_UNICODE_VERSION);
  });

  it("exposes the two functions xterm's provider contract requires", () => {
    expect(typeof provider.wcwidth).toBe("function");
    expect(typeof provider.charProperties).toBe("function");
  });

  it("exposes the cluster splitter the remote IME preedit lays out with", () => {
    expect(typeof provider.splitCellClusters).toBe("function");
  });

  it("matches the source cluster split, so preedit boxes land on committed cells", () => {
    // The Remote preedit sizes one box per cluster (ADR-0171). Drift here would
    // put the composing text on different cells than the committed text — the
    // exact mismatch the asset exists to prevent, one layer up from `wcwidth`.
    const samples = [
      "한글", // 2 cells each
      "a한b", // mixed advance widths in one run
      "が", // NFD: combining mark joins its base
      "👍🏻", // skin tone modifier joins
      "🇰🇷", // regional indicator pair
      "1️⃣", // keycap
      "",
    ];
    for (const text of samples) {
      expect(provider.splitCellClusters(text)).toEqual(splitCellClusters(text));
    }
  });

  it("matches the source width for every code point measured to diverge from V6", () => {
    const mismatches: string[] = [];
    for (const cp of [...DIVERGENT_BMP, ...DIVERGENT_SUPPLEMENTARY]) {
      const asset = provider.wcwidth(cp);
      const source = codePointCellWidth(cp);
      if (asset !== source) {
        mismatches.push(`U+${cp.toString(16).toUpperCase()} asset=${asset} source=${source}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("matches the source width where remote and desktop already agreed", () => {
    const mismatches: string[] = [];
    for (const cp of AGREEING) {
      const asset = provider.wcwidth(cp);
      const source = codePointCellWidth(cp);
      if (asset !== source) {
        mismatches.push(`U+${cp.toString(16).toUpperCase()} asset=${asset} source=${source}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("matches the source for every code point in the BMP", () => {
    // Exhaustive, not sampled: a stride skips whole code points, and the ones
    // this asset exists to fix (U+231A, U+2B50, U+A960) all fell outside a
    // 7-step stride from U+20. Measured at ~16ms for both sides, so sampling
    // buys nothing.
    const mismatches: string[] = [];
    for (let cp = 0x20; cp < 0x10000; cp += 1) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (provider.wcwidth(cp) !== codePointCellWidth(cp)) {
        mismatches.push(`U+${cp.toString(16).toUpperCase()}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("matches the source across the supplementary planes", () => {
    // The widest divergence was here — effectively every emoji — so this is the
    // area that most needs more than a curated list. Exhaustive over the
    // supplementary planes; ~100ms for both sides.
    const mismatches: string[] = [];
    for (let cp = 0x10000; cp < 0x110000; cp += 1) {
      if (provider.wcwidth(cp) !== codePointCellWidth(cp)) {
        mismatches.push(`U+${cp.toString(16).toUpperCase()}`);
        if (mismatches.length > 20) break;
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("matches the source cluster decisions, not just widths", () => {
    // `charProperties` carries the `shouldJoin` bit xterm reads for cluster
    // membership. A width-only comparison would miss drift in the join rules.
    const sequences: number[][] = [
      [0x304b, 0x3099], // NFD が
      [0x2764, 0xfe0f], // heart + VS16
      [0x1f44d, 0x1f3fb], // thumbs up + skin tone
      [0x1f468, 0x200d, 0x1f469], // ZWJ pair
      [0x1f1f0, 0x1f1f7], // flag pair
      [0x1f1f0, 0x1f1f7, 0x1f1fa], // three in a row: the third opens a new pair
      [0x304b, 0x3099, 0x304d, 0x3099], // two NFD syllables in one run
      [0x31, 0xfe0f, 0x20e3], // keycap
      [0x61, 0xfe0f], // inert VS16
      [0x61, 0x1f3fb], // standalone skin tone
    ];
    const mismatches: string[] = [];
    for (const sequence of sequences) {
      let assetPreceding = 0;
      let sourcePreceding = 0;
      for (const cp of sequence) {
        assetPreceding = provider.charProperties(cp, assetPreceding);
        sourcePreceding = charProperties(cp, sourcePreceding);
        if (assetPreceding !== sourcePreceding) {
          mismatches.push(
            `U+${cp.toString(16).toUpperCase()} in [${sequence
              .map((c) => c.toString(16))
              .join(",")}] asset=${assetPreceding} source=${sourcePreceding}`,
          );
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

describe("served remote xterm bundle honours a registered provider", () => {
  /**
   * What a remote-bundle-only bump can actually break is not V6 parity — once
   * `activeVersion` is set the V6 tables are dead code on both surfaces, so
   * pinning them would pin a path that only runs when this fix is already
   * broken. What matters is that the **served** bundle still supports the
   * proposed provider API at all.
   *
   * Assert that behaviourally with a stub provider rather than by comparing
   * bytes or versions: register something that claims every code point is two
   * cells and check the cursor moved two.
   */
  const BUNDLE_PATH = resolve(__dirname, "../../../src-tauri/src/remote_server/assets/xterm.js");

  function loadServedTerminalCtor(): new (options: Record<string, unknown>) => {
    unicode: { register: (p: unknown) => void; activeVersion: string };
    buffer: { active: { cursorX: number } };
    write: (data: string, cb?: () => void) => void;
    dispose: () => void;
  } {
    const source = readFileSync(BUNDLE_PATH, "utf8");
    const fakeWindow: Record<string, unknown> = {};
    // The bundle is a UMD build: with no module system present it assigns to the
    // global object, the same way the browser picks up `window.Terminal`.
    const run = new Function(
      "window",
      "self",
      "globalThis",
      `${source}\nreturn window.Terminal || self.Terminal || globalThis.Terminal;`,
    );
    const ctor = run(fakeWindow, fakeWindow, fakeWindow);
    if (typeof ctor !== "function") {
      throw new Error("served xterm bundle did not export a Terminal constructor");
    }
    return ctor as never;
  }

  it("routes width decisions through the registered provider", async () => {
    const TerminalCtor = loadServedTerminalCtor();
    const terminal = new TerminalCtor({ allowProposedApi: true, cols: 20, rows: 4 });
    // Every code point claims two cells; nothing joins.
    terminal.unicode.register({
      version: "stub-two-cells",
      wcwidth: () => 2,
      charProperties: () => (2 & 3) << 1,
    });
    terminal.unicode.activeVersion = "stub-two-cells";
    await new Promise<void>((r) => terminal.write("a", () => r()));
    const cursorX = terminal.buffer.active.cursorX;
    terminal.dispose();
    // 1 would mean the bundle ignored the provider and used its own table.
    expect(cursorX).toBe(2);
  });
});
