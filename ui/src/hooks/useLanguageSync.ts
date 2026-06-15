import { useEffect } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import { applyLanguage } from "@/i18n";

/**
 * Keep i18next's active language in sync with the `language` setting.
 *
 * Runs on mount (applies the startup/loaded value) and whenever the user
 * changes the language in settings. `applyLanguage` resolves "system" against
 * the browser locale before calling `i18n.changeLanguage`.
 */
export function useLanguageSync(): void {
  const language = useSettingsStore((s) => s.language);
  useEffect(() => {
    applyLanguage(language);
  }, [language]);
}
