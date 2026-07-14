import { getClaudeSessionIds, getTerminalCwds, saveSettings, type Settings } from "@/lib/tauri-api";
import { useDockStore } from "@/stores/dock-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  applySettingsSnapshot,
  type ApplySettingsSnapshotOptions,
} from "./apply-settings-snapshot";

export { applySettingsSnapshot } from "./apply-settings-snapshot";
export type { ApplySettingsSnapshotOptions } from "./apply-settings-snapshot";

export interface SaveAndApplySettingsSnapshotOptions extends ApplySettingsSnapshotOptions {
  expectedSettings?: Settings;
}

/** Collect the current settings-owned state from every frontend store. */
export async function collectSettingsSnapshot(): Promise<Settings> {
  const settingsState = useSettingsStore.getState();
  const workspaceState = useWorkspaceStore.getState();
  const dockState = useDockStore.getState();
  const maxAge = settingsState.claude?.sessionMaxAgeHours;
  const [backendCwds, claudeSessionIds] = await Promise.all([
    getTerminalCwds().catch(() => ({}) as Record<string, string>),
    getClaudeSessionIds(maxAge).catch(() => ({}) as Record<string, string>),
  ]);

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
        const viewExtra: Record<string, unknown> = {};
        if (pane.view.type === "TerminalView") {
          const terminalId = `terminal-${pane.id}`;
          const cwd = backendCwds[terminalId];
          if (cwd) viewExtra.lastCwd = cwd;
          const claudeSession = claudeSessionIds[terminalId];
          if (claudeSession) viewExtra.lastClaudeSession = claudeSession;
        }
        return {
          id: pane.id,
          x: pane.x,
          y: pane.y,
          w: pane.w,
          h: pane.h,
          view: { ...pane.view, ...viewExtra } as { type: string; [key: string]: unknown },
        };
      }),
    })),
    workspaceDisplayOrder: workspaceState.workspaceDisplayOrder,
    paste: { ...settingsState.paste },
    terminal: { ...settingsState.terminal },
    controlBar: { ...settingsState.controlBar },
    dock: { ...settingsState.dock },
    notifications: { ...settingsState.notifications },
    workspaceSelector: {
      ...settingsState.workspaceSelector,
      display: { ...settingsState.workspaceSelector.display },
    },
    claude: { ...settingsState.claude },
    codex: { ...settingsState.codex },
    memo: { ...settingsState.memo },
    issueReporter: { ...settingsState.issueReporter },
    fileExplorer: { ...settingsState.fileExplorer },
    remote: { ...settingsState.remote },
    syncCwdDefaults: { ...settingsState.syncCwdDefaults },
    docks: dockState.docks.map((dock) => ({
      position: dock.position,
      activeView: dock.activeView,
      views: dock.views,
      visible: dock.visible,
      size: dock.size,
      panes: dock.panes.map((pane) => {
        const viewExtra: Record<string, unknown> = {};
        if (pane.view.type === "TerminalView") {
          const terminalId = `terminal-${pane.id}`;
          const cwd = backendCwds[terminalId];
          if (cwd) viewExtra.lastCwd = cwd;
          const claudeSession = claudeSessionIds[terminalId];
          if (claudeSession) viewExtra.lastClaudeSession = claudeSession;
        }
        return {
          id: pane.id,
          view: { ...pane.view, ...viewExtra },
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
    const current = await collectSettingsSnapshot();
    assertExpectedSettings(current, options.expectedSettings);
  }
  await saveSettings(settings);
  if (options.expectedSettings) {
    const latest = await collectSettingsSnapshot();
    if (!settingsConfigEquals(latest, options.expectedSettings)) {
      // The candidate is already on disk, but a user edit won the runtime race.
      // Restore that newer store state to disk and leave the live store untouched.
      await saveSettings(latest);
      throw new Error("Settings revision conflict: settings changed while saving");
    }
  }
  applySettingsSnapshot(settings, options);
}

function assertExpectedSettings(current: Settings, expected: Settings): void {
  if (!settingsConfigEquals(current, expected)) {
    throw new Error("Settings revision conflict: settings changed before saving");
  }
}

function settingsConfigEquals(left: Settings, right: Settings): boolean {
  return JSON.stringify(comparableSettings(left)) === JSON.stringify(comparableSettings(right));
}

function comparableSettings(settings: Settings): unknown {
  const value = structuredClone(settings) as unknown as Record<string, unknown>;
  delete value.workspaces;
  delete value.layouts;
  delete value.docks;
  delete value.workspaceDisplayOrder;
  if (value.remote !== null && typeof value.remote === "object") {
    const remote = value.remote as Record<string, unknown>;
    delete remote.cloudInstanceId;
    delete remote.cloudTunnelUrl;
    delete remote.cloudServerBaseUrl;
  }
  return canonicalize(value);
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
