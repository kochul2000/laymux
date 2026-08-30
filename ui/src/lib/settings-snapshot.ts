import { toTerminalId } from "@/lib/pane-ids";
import {
  getTerminalCwds,
  getTerminalSessionAttributions,
  saveSettings,
  type Settings,
  type TerminalSessionAttribution,
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

export type TerminalAttributionState =
  | "identified"
  | "noAgent"
  | "activeButUnidentified"
  | "unknown";

export interface TerminalAttributionCoverage {
  terminalId: string;
  state: TerminalAttributionState;
  generation?: number;
  provider?: "claude" | "codex" | "grok";
  sessionId?: string;
}

export interface CollectedSessionCheckpoint {
  settings: Settings;
  coverage: TerminalAttributionCoverage[];
}

type SavedTerminalView = { type: string; [key: string]: unknown };

/** Runtime state that decides the persisted `lastCwd` / `last*Session` fields. */
interface TerminalRuntimeAttribution {
  backendCwds: Record<string, string>;
  backendAttributions: Record<string, TerminalSessionAttribution>;
  attributionLookupFailed: boolean;
  attributionPendingTerminalIds: ReadonlySet<string>;
}

function terminalAttributionState(
  terminalId: string,
  runtime: TerminalRuntimeAttribution,
): TerminalAttributionState {
  if (runtime.attributionLookupFailed) return "unknown";
  const attribution = runtime.backendAttributions[terminalId];
  if (!attribution) return "unknown";
  if (attribution.state === "noAgent" && runtime.attributionPendingTerminalIds.has(terminalId)) {
    return "unknown";
  }
  return attribution.state;
}

function terminalAttributionCoverage(
  terminalId: string,
  runtime: TerminalRuntimeAttribution,
): TerminalAttributionCoverage {
  const state = terminalAttributionState(terminalId, runtime);
  const identified = runtime.backendAttributions[terminalId];
  if (state !== "identified") {
    return {
      terminalId,
      state,
      generation: identified?.generation,
      provider: identified?.provider,
    };
  }
  return {
    terminalId,
    state,
    generation: identified?.generation,
    provider: identified?.provider,
    sessionId: identified?.sessionId,
  };
}

function applyTerminalSessionFields(
  view: SavedTerminalView,
  terminalId: string,
  runtime: TerminalRuntimeAttribution,
): SavedTerminalView {
  const { backendCwds } = runtime;
  const savedView = { ...view };
  const cwd = backendCwds[terminalId];
  if (cwd) savedView.lastCwd = cwd;

  const attribution = terminalAttributionState(terminalId, runtime);
  if (attribution === "unknown") {
    return savedView;
  }

  // Live pane, no provider claims it → it is a shell pane now, so any id from
  // an earlier run is stale. Panes with no live terminal (another workspace,
  // never started this run) keep theirs — they were never given a chance to
  // prove anything.
  if (attribution === "noAgent" || attribution === "activeButUnidentified") {
    delete savedView.lastClaudeSession;
    delete savedView.lastCodexSession;
    delete savedView.lastGrokSession;
  } else if (runtime.backendAttributions[terminalId]?.provider === "claude") {
    savedView.lastClaudeSession = runtime.backendAttributions[terminalId].sessionId;
    delete savedView.lastCodexSession;
    delete savedView.lastGrokSession;
  } else if (runtime.backendAttributions[terminalId]?.provider === "codex") {
    savedView.lastCodexSession = runtime.backendAttributions[terminalId].sessionId;
    delete savedView.lastClaudeSession;
    delete savedView.lastGrokSession;
  } else if (runtime.backendAttributions[terminalId]?.provider === "grok") {
    savedView.lastGrokSession = runtime.backendAttributions[terminalId].sessionId;
    delete savedView.lastClaudeSession;
    delete savedView.lastCodexSession;
  }
  return savedView;
}

function collectAttributionPendingTerminalIds(): ReadonlySet<string> {
  const now = Date.now();
  return new Set(
    useTerminalStore
      .getState()
      .instances.filter(
        (instance) =>
          instance.sessionReady !== false && (instance.attributionPendingUntil ?? 0) > now,
      )
      .map((instance) => instance.id),
  );
}

async function collectSessionCheckpointInternal(
  options: CollectSettingsSnapshotOptions = {},
): Promise<CollectedSessionCheckpoint> {
  const settingsState = useSettingsStore.getState();
  const workspaceState = useWorkspaceStore.getState();
  const dockState = useDockStore.getState();
  const maxAge = settingsState.claude?.sessionMaxAgeHours;
  const codexMaxAge = settingsState.codex?.sessionMaxAgeHours;
  const grokMaxAge = settingsState.grok?.sessionMaxAgeHours;
  const includeRuntime = options.includeRuntimeStructuralState !== false;
  const runtimeResults = includeRuntime
    ? await Promise.allSettled([
        getTerminalCwds(),
        getTerminalSessionAttributions(maxAge, codexMaxAge, grokMaxAge),
      ])
    : undefined;
  const backendCwds = runtimeResults?.[0].status === "fulfilled" ? runtimeResults[0].value : {};
  const backendAttributions =
    runtimeResults?.[1].status === "fulfilled" ? runtimeResults[1].value : {};
  const runtime: TerminalRuntimeAttribution = {
    backendCwds,
    backendAttributions,
    attributionLookupFailed: includeRuntime && runtimeResults?.[1].status === "rejected",
    attributionPendingTerminalIds: includeRuntime
      ? collectAttributionPendingTerminalIds()
      : new Set<string>(),
  };

  const settings: Settings = {
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
  const coverageTerminalIds = new Set([
    ...Object.keys(backendAttributions),
    ...useTerminalStore
      .getState()
      .instances.filter((instance) => instance.sessionReady !== false)
      .map((instance) => instance.id),
  ]);
  const coverage = includeRuntime
    ? [...coverageTerminalIds].map((terminalId) => terminalAttributionCoverage(terminalId, runtime))
    : [];
  return { settings, coverage };
}

/** Collect settings plus the attribution confidence for every live terminal. */
export async function collectSessionCheckpoint(
  options: CollectSettingsSnapshotOptions = {},
): Promise<CollectedSessionCheckpoint> {
  return collectSessionCheckpointInternal(options);
}

/** Collect the current settings-owned state from every frontend store. */
export async function collectSettingsSnapshot(
  options: CollectSettingsSnapshotOptions = {},
): Promise<Settings> {
  return (await collectSessionCheckpointInternal(options)).settings;
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
