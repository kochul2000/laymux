import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ko from "./locales/ko.json";
import en from "./locales/en.json";
import { resolveLanguage, type LanguageSetting, type ResolvedLanguage } from "./resolve-language";

export { resolveLanguage };
export type { LanguageSetting, ResolvedLanguage };

/** Namespaces shipped in each locale bundle. */
export const namespaces = ["common", "settings", "workspace"] as const;

export const resources = {
  ko,
  en,
} as const;

/**
 * Dev-only missing-key reporter. Wired into i18next via `saveMissing` +
 * `missingKeyHandler` only when `import.meta.env.DEV` so production builds pay
 * nothing. Catches the common failure where `en.json` lacks a key that `ko.json`
 * has: an English user would otherwise silently see Korean (via `fallbackLng`).
 * Exported (pure, no i18next dependency) so it can be unit-tested directly.
 */
export function reportMissingKey(
  languages: readonly string[],
  namespace: string,
  key: string,
  warn: (message: string) => void = console.warn,
): void {
  const lng = languages[0] ?? "?";
  warn(`[i18n] Missing translation: "${lng}:${namespace}:${key}"`);
}

/**
 * i18next is initialized synchronously at module import (resources are bundled,
 * no async backend). The user's explicit language is applied later from the
 * loaded settings via `applyLanguage`; until then we resolve `"system"` against
 * the browser locale so the very first paint already matches the OS language
 * (no Korean→English flash for new/English-OS users). Settings load then
 * re-applies any explicit "ko"/"en" override on top of this.
 */
const initialLanguage = resolveLanguage(
  "system",
  typeof navigator !== "undefined" ? navigator.language : undefined,
);

// Vite replaces `import.meta.env.DEV` with a literal at build time, so the
// missing-key wiring is tree-shaken out of production bundles.
const isDev = import.meta.env.DEV;

i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage,
  fallbackLng: "ko",
  ns: namespaces as unknown as string[],
  defaultNS: "common",
  interpolation: {
    // React already escapes values — double-escaping breaks interpolated text.
    escapeValue: false,
  },
  // Dev-only: surface any key that has no translation in the active language.
  saveMissing: isDev,
  missingKeyHandler: isDev ? (lngs, ns, key) => reportMissingKey(lngs, ns, key) : undefined,
});

/**
 * Resolve a user language setting against the browser locale and apply it to
 * i18next. Returns the resolved concrete language for callers that need it.
 */
export function applyLanguage(setting: LanguageSetting): ResolvedLanguage {
  const navigatorLang = typeof navigator !== "undefined" ? navigator.language : undefined;
  const resolved = resolveLanguage(setting, navigatorLang);
  if (i18n.language !== resolved) {
    void i18n.changeLanguage(resolved);
  }
  return resolved;
}

export default i18n;
