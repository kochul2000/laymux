/**
 * Display knobs of `GitHubView`, resolved in one place.
 *
 * `settings.github` is written by the Settings UI but a hand-edited
 * settings.json can hold anything, so every value is read through a clamp
 * here rather than trusted at the point of use. The row keeps one font-size
 * knob: the secondary columns derive from it, so a bigger list stays
 * proportional instead of growing a title next to fixed 9px metadata.
 */

import type { GithubNumberColor } from "@/lib/tauri-api";

/** Matches `--fs-sm`, the size the row used before the setting existed. */
export const GITHUB_FONT_SIZE_DEFAULT = 11;
export const GITHUB_FONT_SIZE_MIN = 8;
export const GITHUB_FONT_SIZE_MAX = 24;

/** How much smaller the author/age/label columns are than the title. */
const SECONDARY_FONT_DELTA = 2;
const SECONDARY_FONT_SIZE_MIN = 7;

export const GITHUB_LABEL_MAX_COUNT_MAX = 5;
export const GITHUB_LABEL_MAX_WIDTH_MIN = 24;
export const GITHUB_LABEL_MAX_WIDTH_MAX = 240;
export const GITHUB_LABEL_MAX_WIDTH_DEFAULT = 80;

/** Every offered token, in the order the Settings select shows them. */
export const GITHUB_NUMBER_COLORS: readonly GithubNumberColor[] = [
  "yellow",
  "accent",
  "green",
  "red",
  "primary",
  "secondary",
  "muted",
];

const NUMBER_COLOR_VARS: Record<GithubNumberColor, string> = {
  yellow: "var(--yellow)",
  accent: "var(--accent)",
  green: "var(--green)",
  red: "var(--red)",
  primary: "var(--text-primary)",
  secondary: "var(--text-secondary)",
  muted: "var(--text-muted)",
};

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function readGithubFontSize(value: unknown): number {
  return clampInt(value, GITHUB_FONT_SIZE_MIN, GITHUB_FONT_SIZE_MAX, GITHUB_FONT_SIZE_DEFAULT);
}

/** Size of the author, age, and label columns for a given row size. */
export function secondaryFontSize(fontSize: number): number {
  return Math.max(SECONDARY_FONT_SIZE_MIN, readGithubFontSize(fontSize) - SECONDARY_FONT_DELTA);
}

export function readGithubLabelMaxCount(value: unknown): number {
  return clampInt(value, 0, GITHUB_LABEL_MAX_COUNT_MAX, 2);
}

export function readGithubLabelMaxWidth(value: unknown): number {
  return clampInt(
    value,
    GITHUB_LABEL_MAX_WIDTH_MIN,
    GITHUB_LABEL_MAX_WIDTH_MAX,
    GITHUB_LABEL_MAX_WIDTH_DEFAULT,
  );
}

/** CSS color for the `#123` emphasis. An unknown token falls back to the default. */
export function numberColorVar(value: unknown): string {
  const token = GITHUB_NUMBER_COLORS.find((candidate) => candidate === value) ?? "yellow";
  return NUMBER_COLOR_VARS[token];
}

/** `fontFamily` for a row; "" (or anything blank) means the app UI font. */
export function rowFontFamily(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value : "var(--ui-font)";
}
