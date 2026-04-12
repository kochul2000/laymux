/**
 * Central keybinding registry.
 *
 * All keyboard shortcuts are defined here. Components use `matchesKeybinding()`
 * instead of hardcoding key combos like `e.ctrlKey && e.key === 'c'`.
 * SettingsView imports `DEFAULT_KEYBINDINGS` to render the keybinding UI.
 *
 * User overrides from `settings.json` are automatically respected.
 */

import { useSettingsStore } from "@/stores/settings-store";

export interface KeybindingDef {
  id: string;
  label: string;
  defaultKeys: string;
  group: string;
}

/**
 * Central registry of all keybindings.
 * Every shortcut MUST be registered here to appear in Settings UI.
 */
export const DEFAULT_KEYBINDINGS: KeybindingDef[] = [
  // -- Workspace --
  { id: "workspace.1", label: "워크스페이스 1", defaultKeys: "Ctrl+Alt+1", group: "Workspace" },
  { id: "workspace.2", label: "워크스페이스 2", defaultKeys: "Ctrl+Alt+2", group: "Workspace" },
  { id: "workspace.3", label: "워크스페이스 3", defaultKeys: "Ctrl+Alt+3", group: "Workspace" },
  { id: "workspace.4", label: "워크스페이스 4", defaultKeys: "Ctrl+Alt+4", group: "Workspace" },
  { id: "workspace.5", label: "워크스페이스 5", defaultKeys: "Ctrl+Alt+5", group: "Workspace" },
  { id: "workspace.6", label: "워크스페이스 6", defaultKeys: "Ctrl+Alt+6", group: "Workspace" },
  { id: "workspace.7", label: "워크스페이스 7", defaultKeys: "Ctrl+Alt+7", group: "Workspace" },
  { id: "workspace.8", label: "워크스페이스 8", defaultKeys: "Ctrl+Alt+8", group: "Workspace" },
  {
    id: "workspace.last",
    label: "마지막 워크스페이스",
    defaultKeys: "Ctrl+Alt+9",
    group: "Workspace",
  },
  {
    id: "workspace.next",
    label: "다음 워크스페이스",
    defaultKeys: "Ctrl+Alt+Down",
    group: "Workspace",
  },
  {
    id: "workspace.prev",
    label: "이전 워크스페이스",
    defaultKeys: "Ctrl+Alt+Up",
    group: "Workspace",
  },
  { id: "workspace.new", label: "새 워크스페이스", defaultKeys: "Ctrl+Alt+N", group: "Workspace" },
  {
    id: "workspace.duplicate",
    label: "워크스페이스 복제",
    defaultKeys: "Ctrl+Alt+D",
    group: "Workspace",
  },
  {
    id: "workspace.close",
    label: "워크스페이스 닫기",
    defaultKeys: "Ctrl+Alt+W",
    group: "Workspace",
  },
  {
    id: "workspace.rename",
    label: "워크스페이스 이름 변경",
    defaultKeys: "Ctrl+Alt+R",
    group: "Workspace",
  },
  // -- Pane --
  { id: "pane.focus", label: "Pane 포커스 이동", defaultKeys: "Alt+Arrow", group: "Pane" },
  { id: "pane.delete", label: "Pane 제거 (편집 모드)", defaultKeys: "Delete", group: "Pane" },
  // -- UI --
  { id: "sidebar.toggle", label: "사이드바 토글", defaultKeys: "Ctrl+Shift+B", group: "UI" },
  { id: "notifications.toggle", label: "알림 패널 토글", defaultKeys: "Ctrl+Shift+I", group: "UI" },
  {
    id: "notifications.unread",
    label: "읽지 않은 알림으로 이동",
    defaultKeys: "Ctrl+Shift+U",
    group: "UI",
  },
  {
    id: "notifications.recent",
    label: "최근 알림 Pane으로 이동",
    defaultKeys: "Ctrl+Alt+Left",
    group: "UI",
  },
  {
    id: "notifications.oldest",
    label: "오래된 알림 Pane으로 이동",
    defaultKeys: "Ctrl+Alt+Right",
    group: "UI",
  },
  { id: "settings.open", label: "설정 열기", defaultKeys: "Ctrl+,", group: "UI" },
  // -- File Explorer --
  {
    id: "fileExplorer.copy",
    label: "선택 파일 경로 복사",
    defaultKeys: "Ctrl+C",
    group: "File Explorer",
  },
  // -- Issue Reporter --
  {
    id: "issueReporter.submit",
    label: "이슈 제출",
    defaultKeys: "Ctrl+Enter",
    group: "Issue Reporter",
  },
  // -- Terminal --
  {
    id: "terminal.paste",
    label: "스마트 붙여넣기",
    defaultKeys: "Ctrl+V",
    group: "Terminal",
  },
];

/** Normalized key names: KeyboardEvent.key → shortcut string token. */
const KEY_NORMALIZE: Record<string, string> = {
  " ": "Space",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

interface ParsedShortcut {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut.split("+");
  const modifiers = new Set(parts.slice(0, -1));
  const key = parts[parts.length - 1] || "";
  return {
    ctrl: modifiers.has("Ctrl"),
    alt: modifiers.has("Alt"),
    shift: modifiers.has("Shift"),
    key,
  };
}

function normalizeKey(key: string): string {
  return KEY_NORMALIZE[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/**
 * Resolve the effective key combo string for an action (user override > default).
 * Returns undefined if action is not registered.
 */
export function resolveKeybinding(actionId: string): string | undefined {
  const userOverrides = useSettingsStore.getState().keybindings;
  const override = userOverrides.find((kb) => kb.command === actionId);
  if (override) return override.keys;

  const def = DEFAULT_KEYBINDINGS.find((d) => d.id === actionId);
  return def?.defaultKeys;
}

/**
 * Check if a keyboard event matches a registered keybinding action.
 * Respects user overrides from settings.
 */
export function matchesKeybinding(
  e: KeyboardEvent | React.KeyboardEvent,
  actionId: string,
): boolean {
  const keys = resolveKeybinding(actionId);
  if (!keys) return false;

  const parsed = parseShortcut(keys);
  const eventKey = normalizeKey(e.key);

  return (
    e.ctrlKey === parsed.ctrl &&
    e.altKey === parsed.alt &&
    e.shiftKey === parsed.shift &&
    eventKey === parsed.key
  );
}
