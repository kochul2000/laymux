import { invoke } from "@tauri-apps/api/core";

/** Curated monospaced fonts — used as fallback when system enumeration fails. */
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
 * Checks if a font renders as monospace using canvas text measurement.
 * Compares widths of narrow ('i') and wide ('W') characters —
 * in a monospace font these are equal.
 */
export function isMonospace(ctx: CanvasRenderingContext2D, fontFamily: string): boolean {
  ctx.font = `72px "${fontFamily}"`;
  const narrowWidth = ctx.measureText("iiiii").width;
  const wideWidth = ctx.measureText("WWWWW").width;
  return Math.abs(narrowWidth - wideWidth) < 2;
}

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

    ctx.font = `${testSize} ${fallbackFont}`;
    const fallbackWidth = ctx.measureText(testString).width;

    return candidates.filter((font) => {
      ctx.font = `${testSize} "${font}", ${fallbackFont}`;
      const width = ctx.measureText(testString).width;
      return Math.abs(width - fallbackWidth) > 0.5;
    });
  } catch {
    return candidates;
  }
}

/**
 * Gets all system font families from the Tauri backend.
 */
export async function listSystemFonts(): Promise<string[]> {
  try {
    return await invoke<string[]>("list_system_fonts");
  } catch {
    return [];
  }
}

/**
 * Returns installed monospace fonts by combining system enumeration with canvas detection.
 * Falls back to curated list if system enumeration is unavailable.
 */
export async function getSystemMonospaceFonts(): Promise<string[]> {
  const systemFonts = await listSystemFonts();

  if (systemFonts.length === 0) {
    return detectInstalledFonts(MONOSPACED_FONTS);
  }

  try {
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    if (!ctx) return detectInstalledFonts(MONOSPACED_FONTS);

    return systemFonts.filter((font) => isMonospace(ctx, font));
  } catch {
    return detectInstalledFonts(MONOSPACED_FONTS);
  }
}
