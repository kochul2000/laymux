import { invoke } from "@tauri-apps/api/core";

/** Curated monospaced fonts — shown at the top of the font picker. */
export const MONOSPACED_FONTS = [
  "Cascadia Mono",
  "Cascadia Code",
  "Consolas",
  "Courier New",
  "Fira Code",
  "JetBrains Mono",
  "JetBrainsMonoBigHangul",
  "JetBrainsMonoHangul",
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
 * Gets system monospace font families from the Tauri backend.
 * The backend checks the font's post table isFixedPitch flag.
 */
export async function listSystemMonospaceFonts(): Promise<string[]> {
  try {
    return await invoke<string[]>("list_system_monospace_fonts");
  } catch {
    return [];
  }
}

/**
 * Returns monospace fonts with curated fonts at the top.
 * Falls back to curated list if system enumeration is unavailable.
 */
export async function getSystemMonospaceFonts(): Promise<string[]> {
  const systemFonts = await listSystemMonospaceFonts();

  if (systemFonts.length === 0) {
    return detectInstalledFonts(MONOSPACED_FONTS);
  }

  const systemSet = new Set(systemFonts);

  // Curated fonts that are installed — keep curated order at top
  const curated = MONOSPACED_FONTS.filter((f) => systemSet.has(f));
  // Remaining system monospace fonts not in curated list
  const curatedSet = new Set(MONOSPACED_FONTS);
  const rest = systemFonts.filter((f) => !curatedSet.has(f));

  return [...curated, ...rest];
}
