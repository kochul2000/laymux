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
 * i18next is initialized synchronously at module import (resources are bundled,
 * no async backend). The concrete startup language is applied later from the
 * loaded settings via `applyLanguage` — until then we use the fallback so the
 * first paint is never blank.
 */
i18n.use(initReactI18next).init({
  resources,
  // Resolved language is applied from settings after load; start at the fallback.
  lng: "ko",
  fallbackLng: "ko",
  ns: namespaces as unknown as string[],
  defaultNS: "common",
  interpolation: {
    // React already escapes values — double-escaping breaks interpolated text.
    escapeValue: false,
  },
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
