import { saveSettings, type Settings } from "@/lib/tauri-api";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useDockStore } from "@/stores/dock-store";

/**
 * Gathers state from all stores and persists to settings.json via Tauri backend.
 * Called by workspace store save actions and other persistence triggers.
 */
export async function persistSession(): Promise<void> {
  const settingsState = useSettingsStore.getState();
  const wsState = useWorkspaceStore.getState();
  const dockState = useDockStore.getState();

  // Build the base settings object (matches the Tauri Settings type).
  const base: Settings = {
    font: settingsState.font,
    defaultProfile: settingsState.defaultProfile,
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
      layoutId: ws.layoutId,
      panes: ws.panes.map((p) => ({
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
        view: p.view as { type: string; [key: string]: unknown },
      })),
    })),
    convenience: { ...settingsState.convenience },
    claude: { ...settingsState.claude },
    docks: dockState.docks.map((d) => ({
      position: d.position,
      activeView: d.activeView,
      views: d.views,
      visible: d.visible,
      size: d.size,
      panes: d.panes.map((p) => ({
        id: p.id,
        view: p.view,
        x: p.x,
        y: p.y,
        w: p.w,
        h: p.h,
      })),
    })),
  };

  // Extra fields the backend round-trips but aren't in the strict Settings type.
  const extended = base as Settings & Record<string, unknown>;
  extended.profileDefaults = { ...settingsState.profileDefaults };
  extended.viewOrder = settingsState.viewOrder ?? [];
  extended.appThemeId = settingsState.appThemeId ?? "catppuccin-mocha";

  await saveSettings(extended);
}
