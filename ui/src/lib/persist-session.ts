import {
  saveSettings,
  saveTerminalOutputCache,
  cleanTerminalOutputCache,
  type Settings,
} from "@/lib/tauri-api";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useDockStore } from "@/stores/dock-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { getTerminalSerializeMap } from "@/lib/terminal-serialize-registry";

/**
 * Gathers state from all stores and persists to settings.json via Tauri backend.
 * Called by workspace store save actions and other persistence triggers.
 */
export async function persistSession(): Promise<void> {
  const settingsState = useSettingsStore.getState();
  const wsState = useWorkspaceStore.getState();
  const dockState = useDockStore.getState();
  const terminalInstances = useTerminalStore.getState().instances;

  // Build the base settings object (matches the Tauri Settings type).
  const base: Settings = {
    defaultProfile: settingsState.defaultProfile,
    profileDefaults: {
      ...settingsState.profileDefaults,
    },
    viewOrder: settingsState.viewOrder ?? [],
    appThemeId: settingsState.appThemeId ?? "catppuccin-mocha",
    // WARNING: Profile 필드를 추가할 때 여기에도 반드시 포함할 것.
    // 누락하면 settings.json 저장 시 해당 필드가 사라짐.
    // persist-session.test.ts에도 보존 테스트를 추가할 것.
    profiles: settingsState.profiles.map((p) => ({
      name: p.name,
      commandLine: p.commandLine,
      startupCommand: p.startupCommand,
      colorScheme: p.colorScheme,
      startingDirectory: p.startingDirectory,
      hidden: p.hidden,
      cursorShape: p.cursorShape,
      padding: p.padding,
      scrollbackLines: p.scrollbackLines,
      opacity: p.opacity,
      tabTitle: p.tabTitle,
      bellStyle: p.bellStyle,
      closeOnExit: p.closeOnExit,
      antialiasingMode: p.antialiasingMode,
      suppressApplicationTitle: p.suppressApplicationTitle,
      snapOnInput: p.snapOnInput,
      ...(p.font ? { font: p.font } : {}),
      ...(p.restoreCwd !== undefined ? { restoreCwd: p.restoreCwd } : {}),
      ...(p.restoreOutput !== undefined ? { restoreOutput: p.restoreOutput } : {}),
    })),
    colorSchemes: settingsState.colorSchemes.map((cs) => ({
      name: cs.name,
      foreground: cs.foreground,
      background: cs.background,
      cursorColor: cs.cursorColor ?? "",
      selectionBackground: cs.selectionBackground ?? "",
      black: cs.black,
      red: cs.red,
      green: cs.green,
      yellow: cs.yellow,
      blue: cs.blue,
      purple: cs.purple,
      cyan: cs.cyan,
      white: cs.white,
      brightBlack: cs.brightBlack,
      brightRed: cs.brightRed,
      brightGreen: cs.brightGreen,
      brightYellow: cs.brightYellow,
      brightBlue: cs.brightBlue,
      brightPurple: cs.brightPurple,
      brightCyan: cs.brightCyan,
      brightWhite: cs.brightWhite,
    })),
    keybindings: settingsState.keybindings.map((kb) => ({
      keys: kb.keys,
      command: kb.command,
    })),
    layouts: wsState.layouts.map((l) => ({
      id: l.id,
      name: l.name,
      panes: l.panes.map((p) => ({
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
        viewType: p.viewType,
      })),
    })),
    workspaces: wsState.workspaces.map((ws) => ({
      id: ws.id,
      name: ws.name,
      panes: ws.panes.map((p) => {
        const viewExtra: Record<string, unknown> = {};
        if (p.view.type === "TerminalView") {
          const termId = `terminal-${p.id}`;
          const inst = terminalInstances.find((i) => i.id === termId);
          if (inst?.cwd) viewExtra.lastCwd = inst.cwd;
        }
        return {
          id: p.id,
          x: p.x,
          y: p.y,
          w: p.w,
          h: p.h,
          view: { ...p.view, ...viewExtra } as { type: string; [key: string]: unknown },
        };
      }),
    })),
    convenience: { ...settingsState.convenience },
    workspaceDisplay: { ...settingsState.workspaceDisplay },
    claude: { ...settingsState.claude },
    memo: { ...settingsState.memo },
    docks: dockState.docks.map((d) => ({
      position: d.position,
      activeView: d.activeView,
      views: d.views,
      visible: d.visible,
      size: d.size,
      panes: d.panes.map((p) => {
        const dockViewExtra: Record<string, unknown> = {};
        if (p.view.type === "TerminalView") {
          const termId = `terminal-${p.id}`;
          const inst = terminalInstances.find((i) => i.id === termId);
          if (inst?.cwd) dockViewExtra.lastCwd = inst.cwd;
        }
        return {
          id: p.id,
          view: Object.keys(dockViewExtra).length > 0 ? { ...p.view, ...dockViewExtra } : p.view,
          x: p.x,
          y: p.y,
          w: p.w,
          h: p.h,
        };
      }),
    })),
  };

  await saveSettings(base);
}

/**
 * Serialize all terminal outputs and persist session state before window close.
 */
export async function saveBeforeClose(): Promise<void> {
  const wsState = useWorkspaceStore.getState();
  const dockState = useDockStore.getState();

  // 1. Serialize and cache terminal outputs
  const serializeMap = getTerminalSerializeMap();
  // TODO: Array.from(Uint8Array) → JSON number[] is 3-4x larger than raw bytes.
  // Consider base64 encoding or Tauri binary IPC to reduce overhead.
  const cachePromises: Promise<void>[] = [];
  for (const [paneId, serializeFn] of serializeMap.entries()) {
    try {
      const data = serializeFn();
      if (data && data.length > 0) {
        cachePromises.push(saveTerminalOutputCache(paneId, Array.from(data)));
      }
    } catch {
      // skip failed serializations
    }
  }

  // 2. Persist session (includes lastCwd in view configs)
  cachePromises.push(persistSession());

  // Wait for save + persist before cleaning — otherwise clean may race and
  // delete files that are still being written.
  await Promise.all(cachePromises);

  // 3. Clean orphaned cache files (safe now that saves have completed)
  const activePaneIds: string[] = [];
  for (const ws of wsState.workspaces) {
    for (const p of ws.panes) activePaneIds.push(p.id);
  }
  for (const d of dockState.docks) {
    for (const p of d.panes) activePaneIds.push(p.id);
  }
  await cleanTerminalOutputCache(activePaneIds);
}
