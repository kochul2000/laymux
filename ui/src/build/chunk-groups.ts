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
