const SETTINGS_VIEW_SUFFIX = "/src/components/views/SettingsView.tsx";
/**
 * The GitHub view and the modules only it uses. Dependency recursion is off,
 * so each module has to be named for the whole feature to leave the entry.
 */
const GITHUB_VIEW_SUFFIXES = [
  "/src/components/views/GitHubView.tsx",
  "/src/hooks/useGithubRepoSnapshot.ts",
  "/src/hooks/useSyncGroupCwd.ts",
  "/src/lib/github-list-format.ts",
];
/**
 * Status widgets: the widget components, their settings editor, the status line
 * surface and the placement transforms behind them (ADR-0105). Grouped so the
 * feature does not land in the already near-budget entry chunk.
 */
const WIDGETS_SEGMENTS = ["/src/components/widgets/"];
const WIDGETS_SUFFIXES = [
  "/src/components/views/settings/WidgetsSection.tsx",
  "/src/components/layout/StatusLine.tsx",
  "/src/lib/widget-placement.ts",
];
/**
 * The usage data layer shared by the UsageView panes and the usage widgets:
 * row derivation, status text, pace maths and the two snapshot sources. Its own
 * group because both surfaces pull it in, so it belongs to neither.
 */
const USAGE_SUFFIXES = [
  "/src/lib/usage-rows.ts",
  "/src/lib/usage-status.ts",
  "/src/lib/usage-pace.ts",
  "/src/lib/usage-layout.ts",
  "/src/lib/codex-usage-subscription.ts",
  "/src/hooks/useUsageSnapshot.ts",
  "/src/hooks/useCodexUsageSnapshot.ts",
];
/**
 * The file viewer's typed preview renderers and the pure parsers behind them
 * (ADR-0109). Only reached once a file of that type is opened, so keeping the
 * whole family out of the entry chunk costs nothing at startup.
 */
const FILE_PREVIEW_SEGMENTS = ["/src/lib/preview/", "/src/components/ui/preview/"];
const FILE_PREVIEW_SUFFIXES = [
  "/src/lib/file-preview-kind.ts",
  // The viewer body belongs with the renderers it dispatches to. Same reason
  // the GitHub view has its own group: the entry chunk sits right against the
  // size budget, and a feature that grows should grow its own chunk.
  "/src/components/ui/FileViewer.tsx",
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
  // The entry chunk sits just under the size warning limit, so a whole new
  // view goes in its own group rather than pushing the entry over it.
  if (GITHUB_VIEW_SUFFIXES.some((suffix) => normalizedId.endsWith(suffix))) return "github-view";
  if (
    WIDGETS_SEGMENTS.some((segment) => normalizedId.includes(segment)) ||
    WIDGETS_SUFFIXES.some((suffix) => normalizedId.endsWith(suffix))
  ) {
    return "widgets";
  }
  if (USAGE_SUFFIXES.some((suffix) => normalizedId.endsWith(suffix))) return "usage";
  if (
    FILE_PREVIEW_SEGMENTS.some((segment) => normalizedId.includes(segment)) ||
    FILE_PREVIEW_SUFFIXES.some((suffix) => normalizedId.endsWith(suffix))
  ) {
    return "file-preview";
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
  if (
    normalizedId.includes("/node_modules/marked/") ||
    normalizedId.includes("/node_modules/github-markdown-css/")
  ) {
    return "markdown-preview";
  }
  // Shiki is deliberately NOT grouped. Its grammars live under
  // `@shikijs/langs`, one module per language, and every one is reached through
  // its own dynamic import. Naming a group for them collapses all 700-odd
  // grammars into a single 3 MB chunk — the opposite of what the lazy imports
  // are for. Leaving them ungrouped lets Rolldown split per dynamic import, so
  // opening a Rust file downloads the Rust grammar and nothing else.

  return undefined;
}
