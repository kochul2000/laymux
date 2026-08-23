import { toTerminalId } from "@/lib/pane-ids";
import {
  getClaudeSessionIds,
  getCodexSessionIds,
  getGrokSessionIds,
  getTerminalCwds,
  saveSettings,
  type Settings,
} from "@/lib/tauri-api";
import { useDockStore } from "@/stores/dock-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  applySettingsSnapshot,
  type ApplySettingsSnapshotOptions,
} from "./apply-settings-snapshot";

export { applySettingsSnapshot } from "./apply-settings-snapshot";
export type { ApplySettingsSnapshotOptions } from "./apply-settings-snapshot";

export interface SaveAndApplySettingsSnapshotOptions extends ApplySettingsSnapshotOptions {
  expectedSettings?: Settings;
  /** Supplied by the Rust settings contract; never duplicate the path set in the frontend. */
  revisionIgnoredPaths?: readonly string[];
}

interface CollectSettingsSnapshotOptions {
  includeRuntimeStructuralState?: boolean;
}

type SavedTerminalView = { type: string; [key: string]: unknown };

/** Runtime state that decides the persisted `lastCwd` / `last*Session` fields. */
interface TerminalRuntimeAttribution {
  backendCwds: Record<string, string>;
  claudeSessionIds: Record<string, string | null>;
  codexSessionIds: Record<string, string | null>;
  grokSessionIds: Record<string, string | null>;
  /**
   * Terminals with a live PTY session in this run that no agent claims.
   *
   * The backend session maps only carry the panes the agent detectors still
   * track, so a pane that quit its agent back to the shell drops out of every
   * map. Without this set the pane keeps the id it was resumed with and the
   * next start relaunches an agent the user already quit (ADR-0195).
   */
  liveShellTerminalIds: ReadonlySet<string>;
}

function applyTerminalSessionFields(
  view: SavedTerminalView,
  terminalId: string,
  runtime: TerminalRuntimeAttribution,
): SavedTerminalView {
  const { backendCwds, claudeSessionIds, codexSessionIds, grokSessionIds } = runtime;
  const savedView = { ...view };
  const cwd = backendCwds[terminalId];
  if (cwd) savedView.lastCwd = cwd;

  const claudeSession = claudeSessionIds[terminalId];
  const codexSession = codexSessionIds[terminalId];
  const grokSession = grokSessionIds[terminalId];
  const claudeActive = Object.hasOwn(claudeSessionIds, terminalId);
  const codexActive = Object.hasOwn(codexSessionIds, terminalId);
  const grokActive = Object.hasOwn(grokSessionIds, terminalId);
  const activeCount = Number(claudeActive) + Number(codexActive) + Number(grokActive);
  const unproven =
    (claudeActive && !claudeSession) ||
    (codexActive && !codexSession) ||
    (grokActive && !grokSession);
  // Live pane, no provider claims it → it is a shell pane now, so any id from
  // an earlier run is stale. Panes with no live terminal (another workspace,
  // never started this run) keep theirs — they were never given a chance to
  // prove anything.
  const staleAfterAgentExit = activeCount === 0 && runtime.liveShellTerminalIds.has(terminalId);
  if (activeCount > 1 || unproven || staleAfterAgentExit) {
    delete savedView.lastClaudeSession;
    delete savedView.lastCodexSession;
    delete savedView.lastGrokSession;
  } else if (claudeSession) {
    savedView.lastClaudeSession = claudeSession;
    delete savedView.lastCodexSession;
    delete savedView.lastGrokSession;
  } else if (codexSession) {
    savedView.lastCodexSession = codexSession;
    delete savedView.lastClaudeSession;
    delete savedView.lastGrokSession;
  } else if (grokSession) {
    savedView.lastGrokSession = grokSession;
    delete savedView.lastClaudeSession;
    delete savedView.lastCodexSession;
  }
  return savedView;
}

/** Agent names the activity detectors report for `interactiveApp` panes. */
const AGENT_ACTIVITY_NAMES = new Set(["Claude", "Codex", "Grok"]);

/**
 * Live terminals that are not currently showing an agent.
 *
 * A pane whose activity still says "Claude"/"Codex"/"Grok" is excluded even
 * when the backend session maps do not list it: that contradiction is a
 * detection race (the agent just started), and dropping a usable resume id is
 * worse than carrying it one more save.
 */
function collectLiveShellTerminalIds(): ReadonlySet<string> {
  const live = new Set<string>();
  for (const instance of useTerminalStore.getState().instances) {
    if (instance.sessionReady === false) continue;
    const activity = instance.activity;
    if (activity?.type === "interactiveApp" && AGENT_ACTIVITY_NAMES.has(activity.name ?? "")) {
      continue;
    }
    live.add(instance.id);
  }
  return live;
}

/** Collect the current settings-owned state from every frontend store. */
export async function collectSettingsSnapshot(
  options: CollectSettingsSnapshotOptions = {},
): Promise<Settings> {
  const settingsState = useSettingsStore.getState();
  const workspaceState = useWorkspaceStore.getState();
  const dockState = useDockStore.getState();
  const maxAge = settingsState.claude?.sessionMaxAgeHours;
  const codexMaxAge = settingsState.codex?.sessionMaxAgeHours;
  const grokMaxAge = settingsState.grok?.sessionMaxAgeHours;
  const [backendCwds, claudeSessionIds, codexSessionIds, grokSessionIds] =
    options.includeRuntimeStructuralState === false
      ? [{}, {}, {}, {}]
      : await Promise.all([
          getTerminalCwds().catch(() => ({}) as Record<string, string>),
          getClaudeSessionIds(maxAge).catch(() => ({}) as Record<string, string | null>),
          getCodexSessionIds(codexMaxAge).catch(() => ({}) as Record<string, string | null>),
          getGrokSessionIds(grokMaxAge).catch(() => ({}) as Record<string, string | null>),
        ]);
  const runtime: TerminalRuntimeAttribution = {
    backendCwds,
    claudeSessionIds,
    codexSessionIds,
    grokSessionIds,
    liveShellTerminalIds:
      options.includeRuntimeStructuralState === false
        ? new Set<string>()
        : collectLiveShellTerminalIds(),
  };

  return {
    language: settingsState.language,
    defaultProfile: settingsState.defaultProfile,
    profileDefaults: { ...settingsState.profileDefaults },
    viewOrder: settingsState.viewOrder ?? [],
    appearance: {
      themeId: settingsState.appearance.themeId,
      font: { ...settingsState.appearance.font },
      uiFontFamily: settingsState.appearance.uiFontFamily,
    },
    // Keep every Profile field here. Omitting one drops it on the next settings.json save.
    profiles: settingsState.profiles.map((profile) => ({
      name: profile.name,
      commandLine: profile.commandLine,
      startupCommand: profile.startupCommand,
      colorScheme: profile.colorScheme,
      startingDirectory: profile.startingDirectory,
      hidden: profile.hidden,
      cursorShape: profile.cursorShape,
      cursorBlink: profile.cursorBlink,
      stabilizeInteractiveCursor: profile.stabilizeInteractiveCursor,
      padding: profile.padding,
      scrollbackLines: profile.scrollbackLines,
      opacity: profile.opacity,
      tabTitle: profile.tabTitle,
      bellStyle: profile.bellStyle,
      closeOnExit: profile.closeOnExit,
      antialiasingMode: profile.antialiasingMode,
      suppressApplicationTitle: profile.suppressApplicationTitle,
      snapOnInput: profile.snapOnInput,
      ...(profile.font ? { font: profile.font } : {}),
      ...(profile.restoreCwd !== undefined ? { restoreCwd: profile.restoreCwd } : {}),
      ...(profile.restoreOutput !== undefined ? { restoreOutput: profile.restoreOutput } : {}),
      ...(profile.syncCwd !== undefined ? { syncCwd: profile.syncCwd } : {}),
    })),
    colorSchemes: settingsState.colorSchemes.map((scheme) => ({
      name: scheme.name,
      foreground: scheme.foreground,
      background: scheme.background,
      cursorColor: scheme.cursorColor ?? "",
      selectionBackground: scheme.selectionBackground ?? "",
      black: scheme.black,
      red: scheme.red,
      green: scheme.green,
      yellow: scheme.yellow,
      blue: scheme.blue,
      purple: scheme.purple,
      cyan: scheme.cyan,
      white: scheme.white,
      brightBlack: scheme.brightBlack,
      brightRed: scheme.brightRed,
      brightGreen: scheme.brightGreen,
      brightYellow: scheme.brightYellow,
      brightBlue: scheme.brightBlue,
      brightPurple: scheme.brightPurple,
      brightCyan: scheme.brightCyan,
      brightWhite: scheme.brightWhite,
    })),
    keybindings: settingsState.keybindings.map((keybinding) => ({
      keys: keybinding.keys,
      command: keybinding.command,
    })),
    layouts: workspaceState.layouts.map((layout) => ({
      id: layout.id,
      name: layout.name,
      panes: layout.panes.map((pane) => ({
        x: pane.x,
        y: pane.y,
        w: pane.w,
        h: pane.h,
        viewType: pane.viewType,
        ...(pane.viewConfig ? { viewConfig: pane.viewConfig } : {}),
      })),
    })),
    workspaces: workspaceState.workspaces.map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      panes: workspace.panes.map((pane) => {
        const savedView =
          pane.view.type === "TerminalView"
            ? applyTerminalSessionFields(
                pane.view as SavedTerminalView,
                toTerminalId(pane.id),
                runtime,
              )
            : ({ ...pane.view } as SavedTerminalView);
        return {
          id: pane.id,
          x: pane.x,
          y: pane.y,
          w: pane.w,
          h: pane.h,
          view: savedView,
        };
      }),
    })),
    workspaceDisplayOrder: workspaceState.workspaceDisplayOrder,
    paste: { ...settingsState.paste },
    terminal: { ...settingsState.terminal },
    controlBar: { ...settingsState.controlBar },
    usage: {
      claude: { ...settingsState.usage.claude, colors: { ...settingsState.usage.claude.colors } },
      codex: { ...settingsState.usage.codex, colors: { ...settingsState.usage.codex.colors } },
      grok: { ...settingsState.usage.grok, colors: { ...settingsState.usage.grok.colors } },
    },
    widgets: settingsState.widgets,
    dock: { ...settingsState.dock },
    notifications: { ...settingsState.notifications },
    power: { ...settingsState.power },
    update: { ...settingsState.update },
    workspaceSelector: {
      ...settingsState.workspaceSelector,
      display: { ...settingsState.workspaceSelector.display },
    },
    claude: { ...settingsState.claude },
    codex: { ...settingsState.codex },
    grok: { ...settingsState.grok },
    exit: { ...settingsState.exit },
    paneClear: { ...settingsState.paneClear },
    memo: { ...settingsState.memo },
    issueReporter: { ...settingsState.issueReporter },
    fileExplorer: { ...settingsState.fileExplorer },
    viewer: { ...settingsState.viewer },
    github: { ...settingsState.github },
    remote: { ...settingsState.remote },
    syncCwdDefaults: { ...settingsState.syncCwdDefaults },
    docks: dockState.docks.map((dock) => ({
      position: dock.position,
      activeView: dock.activeView,
      views: dock.views,
      visible: dock.visible,
      size: dock.size,
      panes: dock.panes.map((pane) => {
        const savedView =
          pane.view.type === "TerminalView"
            ? applyTerminalSessionFields(
                pane.view as SavedTerminalView,
                toTerminalId(pane.id),
                runtime,
              )
            : ({ ...pane.view } as SavedTerminalView);
        return {
          id: pane.id,
          view: savedView,
          x: pane.x,
          y: pane.y,
          w: pane.w,
          h: pane.h,
        };
      }),
    })),
  };
}

/** Persist a validated snapshot, then expose it to the live stores. */
export async function saveAndApplySettingsSnapshot(
  settings: Settings,
  options: SaveAndApplySettingsSnapshotOptions = {},
): Promise<void> {
  if (options.expectedSettings) {
    const current = await collectSettingsSnapshot({ includeRuntimeStructuralState: false });
    assertExpectedSettings(current, options.expectedSettings, options.revisionIgnoredPaths ?? []);
  }
  await saveSettings(settings);
  if (options.expectedSettings) {
    const latest = await collectSettingsSnapshot({ includeRuntimeStructuralState: false });
    if (
      !settingsConfigEquals(latest, options.expectedSettings, options.revisionIgnoredPaths ?? [])
    ) {
      // The candidate is already on disk, but a user edit won the runtime race.
      // Restore that newer store state to disk and leave the live store untouched.
      await saveSettings(latest);
      throw new Error("Settings revision conflict: settings changed while saving");
    }
  }
  applySettingsSnapshot(settings, options);
}

function assertExpectedSettings(
  current: Settings,
  expected: Settings,
  revisionIgnoredPaths: readonly string[],
): void {
  if (!settingsConfigEquals(current, expected, revisionIgnoredPaths)) {
    throw new Error("Settings revision conflict: settings changed before saving");
  }
}

function settingsConfigEquals(
  left: Settings,
  right: Settings,
  revisionIgnoredPaths: readonly string[],
): boolean {
  return (
    JSON.stringify(comparableSettings(left, revisionIgnoredPaths)) ===
    JSON.stringify(comparableSettings(right, revisionIgnoredPaths))
  );
}

function comparableSettings(settings: Settings, revisionIgnoredPaths: readonly string[]): unknown {
  const value = structuredClone(settings) as unknown as Record<string, unknown>;
  revisionIgnoredPaths.forEach((path) => removeJsonPointer(value, path));
  return canonicalize(value);
}

function removeJsonPointer(value: Record<string, unknown>, path: string): void {
  if (!path.startsWith("/")) return;
  const segments = path
    .slice(1)
    .split("/")
    .map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  const key = segments.pop();
  if (key === undefined) return;

  let parent: unknown = value;
  for (const segment of segments) {
    if (parent === null || typeof parent !== "object") return;
    parent = (parent as Record<string, unknown>)[segment];
  }
  if (parent !== null && typeof parent === "object") {
    delete (parent as Record<string, unknown>)[key];
  }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}
