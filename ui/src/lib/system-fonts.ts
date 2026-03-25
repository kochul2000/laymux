/** Curated monospaced fonts — shown in the font picker. */
export const MONOSPACED_FONTS = [
  "Cascadia Mono",
  "Cascadia Code",
  "Consolas",
  "Courier New",
  "Fira Code",
  "JetBrains Mono",
  "Source Code Pro",
  "Ubuntu Mono",
  "Hack",
  "Inconsolata",
  "IBM Plex Mono",
  "Roboto Mono",
  "SF Mono",
  "Menlo",
  "Monaco",
  "DejaVu Sans Mono",
  "Noto Sans Mono",
  "D2Coding",
  "Liberation Mono",
  "Lucida Console",
  "Droid Sans Mono",
  "Anonymous Pro",
  "Iosevka",
  "PragmataPro",
  "CaskaydiaCove Nerd Font",
  "FiraCode Nerd Font",
  "JetBrainsMono Nerd Font",
  "Hack Nerd Font",
];

/**
 * Detects which monospaced fonts from the curated list are actually installed.
 * Uses canvas text measurement — no permissions needed, safe in WebView2.
 */
export function detectInstalledFonts(candidates: string[]): string[] {
  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return candidates;

    const testString = "mmmmmmmmmmlli";
    const fallbackFont = "monospace";
    const testSize = "72px";

    // Measure with fallback only
    ctx.font = `${testSize} ${fallbackFont}`;
    const fallbackWidth = ctx.measureText(testString).width;

    return candidates.filter((font) => {
      ctx.font = `${testSize} "${font}", ${fallbackFont}`;
      const width = ctx.measureText(testString).width;
      // If width differs from fallback, the font is installed
      return Math.abs(width - fallbackWidth) > 0.5;
    });
  } catch {
    return candidates;
  }
}
