/** Supported UI languages (resolved, concrete). */
export type ResolvedLanguage = "ko" | "en";

/** User-facing language setting. "system" defers to the OS/browser locale. */
export type LanguageSetting = "system" | ResolvedLanguage;

/**
 * Resolve the concrete UI language from the user's setting and the browser locale.
 *
 * - Explicit "ko"/"en" wins.
 * - "system" inspects `navigatorLang` (e.g. `navigator.language`): a `ko*`
 *   locale (case-insensitive) maps to Korean, everything else falls back to
 *   English. A missing/empty locale also falls back to English.
 *
 * Pure function — no globals — so it is unit-testable without a DOM.
 */
export function resolveLanguage(
  setting: LanguageSetting,
  navigatorLang: string | undefined | null,
): ResolvedLanguage {
  if (setting === "ko" || setting === "en") return setting;
  // setting === "system"
  const lang = (navigatorLang ?? "").toLowerCase();
  return lang.startsWith("ko") ? "ko" : "en";
}
