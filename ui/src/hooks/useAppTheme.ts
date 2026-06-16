import { useEffect } from "react";
import { useSettingsStore, builtinAppThemes, type AppTheme } from "@/stores/settings-store";

/**
 * Applies the selected app theme + UI chrome font to CSS custom properties.
 * App theme is separate from terminal color schemes.
 */
export function useAppTheme() {
  const appThemeId = useSettingsStore((s) => s.appearance.themeId ?? "catppuccin-mocha");
  const uiFontFamily = useSettingsStore((s) => s.appearance.uiFontFamily ?? "");

  useEffect(() => {
    const theme = builtinAppThemes.find((t) => t.id === appThemeId) ?? builtinAppThemes[0];
    applyTheme(theme);
  }, [appThemeId]);

  useEffect(() => {
    // Prepend the chosen family to the built-in default stack (--ui-font-default,
    // defined in index.css as the single source of truth) so missing glyphs degrade
    // gracefully (same approach as the terminal font). Empty = built-in default.
    const trimmed = uiFontFamily.trim();
    const stack = trimmed ? `"${trimmed}", var(--ui-font-default)` : "var(--ui-font-default)";
    document.documentElement.style.setProperty("--ui-font", stack);
  }, [uiFontFamily]);
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
