import { useEffect } from "react";
import { useSettingsStore, builtinAppThemes, type AppTheme } from "@/stores/settings-store";

/**
 * Applies the selected app theme to CSS custom properties.
 * App theme is separate from terminal color schemes.
 */
export function useAppTheme() {
  const appThemeId = useSettingsStore((s) => s.appThemeId ?? "catppuccin-mocha");

  useEffect(() => {
    const theme = builtinAppThemes.find((t) => t.id === appThemeId) ?? builtinAppThemes[0];
    applyTheme(theme);
  }, [appThemeId]);
}

function applyTheme(theme: AppTheme) {
  const root = document.documentElement;
  root.style.setProperty("--bg-base", theme.bgBase);
  root.style.setProperty("--bg-surface", theme.bgSurface);
  root.style.setProperty("--bg-overlay", theme.bgOverlay);
  root.style.setProperty("--border", theme.border);
  root.style.setProperty("--text-primary", theme.textPrimary);
  root.style.setProperty("--text-secondary", theme.textSecondary);
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--green", theme.green);
  root.style.setProperty("--red", theme.red);
  root.style.setProperty("--yellow", theme.yellow);
}
