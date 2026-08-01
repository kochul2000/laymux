const SETTINGS_VIEW_SUFFIX = "/src/components/views/SettingsView.tsx";
/**
 * Status widgets: the widget components, their settings editor, the status line
 * surface and the placement transforms behind them (ADR-0105). Grouped so the
 * feature does not land in the already near-budget entry chunk.
 */
const WIDGETS_SEGMENTS = ["/src/components/widgets/", "/src/components/views/settings/"];
const WIDGETS_SUFFIXES = [
  "/src/components/layout/StatusLine.tsx",
  "/src/lib/widget-placement.ts",
  "/src/lib/usage-status.ts",
];
const TERMINAL_OUTPUT_V3_FAILURE_SUFFIX = "/src/lib/terminal-output-v3-failure-coordinator.ts";
const TERMINAL_INPUT_DELIVERY_METRICS_SUFFIX = "/src/lib/terminal-input-delivery-metrics.ts";
const NODE_MODULES_SEGMENT = "/node_modules/";

/**
 * Stable explicit chunk groups for the desktop UI production bundle.
 * Settings remains a static import; this controls chunk scope, not load timing.
 */
export function resolveChunkGroup(id: string): string | undefined {
  const normalizedId = id.replaceAll("\\", "/");

  if (normalizedId.endsWith(SETTINGS_VIEW_SUFFIX)) return "settings-view";
  if (
    WIDGETS_SEGMENTS.some((segment) => normalizedId.includes(segment)) ||
    WIDGETS_SUFFIXES.some((suffix) => normalizedId.endsWith(suffix))
  ) {
    return "widgets";
  }
  if (normalizedId.endsWith(TERMINAL_OUTPUT_V3_FAILURE_SUFFIX)) {
    return "terminal-output-v3-failure";
  }
  if (normalizedId.endsWith(TERMINAL_INPUT_DELIVERY_METRICS_SUFFIX)) {
    return "terminal-input-delivery-metrics";
  }
  if (!normalizedId.includes(NODE_MODULES_SEGMENT)) return undefined;

  if (normalizedId.includes("/node_modules/@xterm/")) return "xterm";
  if (normalizedId.includes("/node_modules/html2canvas/")) return "html2canvas";
  if (
    normalizedId.includes("/node_modules/i18next/") ||
    normalizedId.includes("/node_modules/react-i18next/")
  ) {
    return "i18n";
  }
  if (/\/node_modules\/react(?:-dom)?\//.test(normalizedId)) return "react";

  return undefined;
}
