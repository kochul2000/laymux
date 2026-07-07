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
  /**
   * True if the (possibly user-overridden) combo must pass through xterm.js
   * to reach the document-level handler in `useKeyboardShortcuts` while a
   * terminal is focused (consumed by `lx-shortcuts.ts`).
   *
   * `"whenModified"`: the default combo is a bare key the terminal owns
   * (`pane.delete` = plain Delete must keep reaching the shell), but a
   * rebound combo that includes a modifier is an IDE shortcut and passes
   * through (PR #338 review).
   *
   * Declared per-definition — not derived from `group` — because the group
   * alone doesn't decide it: `pane.focus`/`pane.propagateCwdOnce`/`pane.copyIdentifier` are
   * document-level, but `pane.delete` (plain Delete) must stay with the
   * terminal. Terminal/Memo/Issue Reporter actions are handled inside the
   * focused view itself and never pass through.
   */
  passThroughTerminal?: boolean | "whenModified";
}

/**
 * Central registry of all keybindings.
 * Every shortcut MUST be registered here to appear in Settings UI.
 */
export const DEFAULT_KEYBINDINGS: KeybindingDef[] = [
  // -- Workspace --
  {
    id: "workspace.1",
    label: "워크스페이스 1",
    defaultKeys: "Ctrl+Alt+1",
    group: "Workspace",
    passThroughTerminal: true,
  },
  {
    id: "workspace.2",
    label: "워크스페이스 2",
    defaultKeys: "Ctrl+Alt+2",
    group: "Workspace",
    passThroughTerminal: true,
  },
  {
    id: "workspace.3",
    label: "워크스페이스 3",
    defaultKeys: "Ctrl+Alt+3",
    group: "Workspace",
    passThroughTerminal: true,
  },
  {
    id: "workspace.4",
    label: "워크스페이스 4",
    defaultKeys: "Ctrl+Alt+4",
    group: "Workspace",
    passThroughTerminal: true,
  },
  {
    id: "workspace.5",
    label: "워크스페이스 5",
    defaultKeys: "Ctrl+Alt+5",
    group: "Workspace",
    passThroughTerminal: true,
  },
  {
    id: "workspace.6",
    label: "워크스페이스 6",
    defaultKeys: "Ctrl+Alt+6",
    group: "Workspace",
    passThroughTerminal: true,
  },
  {
    id: "workspace.7",
    label: "워크스페이스 7",
    defaultKeys: "Ctrl+Alt+7",
    group: "Workspace",
    passThroughTerminal: true,
  },
  {
    id: "workspace.8",
    label: "워크스페이스 8",
    defaultKeys: "Ctrl+Alt+8",
    group: "Workspace",
    passThroughTerminal: true,
  },
  {
    id: "workspace.last",
    label: "마지막 워크스페이스",
    defaultKeys: "Ctrl+Alt+9",
    group: "Workspace",
    passThroughTerminal: true,
  },
  {
    id: "workspace.next",
    label: "다음 워크스페이스",
    defaultKeys: "Ctrl+Alt+Down",
    group: "Workspace",
    passThroughTerminal: true,
  },
  {
    id: "workspace.prev",
    label: "이전 워크스페이스",
    defaultKeys: "Ctrl+Alt+Up",
    group: "Workspace",
    passThroughTerminal: true,
  },
  {
    id: "workspace.new",
    label: "새 워크스페이스",
    defaultKeys: "Ctrl+Alt+N",
    group: "Workspace",
    passThroughTerminal: true,
  },
  {
    id: "workspace.duplicate",
    label: "워크스페이스 복제",
    defaultKeys: "Ctrl+Alt+D",
    group: "Workspace",
    passThroughTerminal: true,
  },
  {
    id: "workspace.close",
    label: "워크스페이스 닫기",
    defaultKeys: "Ctrl+Alt+W",
    group: "Workspace",
    passThroughTerminal: true,
  },
  {
    id: "workspace.rename",
    label: "워크스페이스 이름 변경",
    defaultKeys: "Ctrl+Alt+R",
    group: "Workspace",
    passThroughTerminal: true,
  },
  // -- Pane --
  {
    id: "pane.focus",
    label: "Pane 포커스 이동",
    defaultKeys: "Alt+Arrow",
    group: "Pane",
    passThroughTerminal: true,
  },
  // pane.delete: 기본 plain Delete는 터미널이 계속 받아야 하지만,
  // 수식키 콤보로 재바인딩하면 IDE 단축키로서 pass-through 한다.
  {
    id: "pane.delete",
    label: "Pane 제거 (편집 모드)",
    defaultKeys: "Delete",
    group: "Pane",
    passThroughTerminal: "whenModified",
  },
  {
    id: "pane.propagateCwdOnce",
    label: "포커스 Pane CWD 1회 전파",
    defaultKeys: "Ctrl+Alt+P",
    group: "Pane",
    passThroughTerminal: true,
  },
  {
    id: "pane.copyIdentifier",
    label: "포커스 Pane 식별자 복사",
    defaultKeys: "Ctrl+Alt+C",
    group: "Pane",
    passThroughTerminal: true,
  },
  // -- UI --
  {
    id: "sidebar.toggle",
    label: "사이드바 토글",
    defaultKeys: "Ctrl+Shift+B",
    group: "UI",
    passThroughTerminal: true,
  },
  {
    id: "notifications.toggle",
    label: "알림 패널 토글",
    defaultKeys: "Ctrl+Shift+I",
    group: "UI",
    passThroughTerminal: true,
  },
  {
    id: "notifications.unread",
    label: "읽지 않은 알림으로 이동",
    defaultKeys: "Ctrl+Shift+U",
    group: "UI",
    passThroughTerminal: true,
  },
  {
    id: "notifications.recent",
    label: "최근 알림 Pane으로 이동",
    defaultKeys: "Ctrl+Alt+Left",
    group: "UI",
    passThroughTerminal: true,
  },
  {
    id: "notifications.oldest",
    label: "오래된 알림 Pane으로 이동",
    defaultKeys: "Ctrl+Alt+Right",
    group: "UI",
    passThroughTerminal: true,
  },
  {
    id: "settings.open",
    label: "설정 열기",
    defaultKeys: "Ctrl+,",
    group: "UI",
    passThroughTerminal: true,
  },
  {
    id: "fileViewer.open",
    label: "파일 뷰어 열기",
    defaultKeys: "Ctrl+Shift+O",
    group: "UI",
    passThroughTerminal: true,
  },
  // -- Terminal --
  // 기본값은 OS의 시스템 클립보드 단축키(Ctrl+C / Ctrl+V)와 동일하여, 별도 설정 없이도
  // 브라우저 `copy` / `paste` 이벤트로 동작한다. 사용자가 Ctrl+Shift+C / Ctrl+Shift+V
  // 등으로 재바인딩하면 TerminalView의 키 이벤트 핸들러가 수동으로 copy/paste를 실행한다.
  { id: "terminal.copy", label: "터미널 복사", defaultKeys: "Ctrl+C", group: "Terminal" },
  { id: "terminal.paste", label: "터미널 붙여넣기", defaultKeys: "Ctrl+V", group: "Terminal" },
  {
    id: "terminal.zoomIn",
    label: "터미널 폰트 확대 (view 인스턴스 오버라이드)",
    defaultKeys: "Ctrl+=",
    group: "Terminal",
  },
  {
    id: "terminal.zoomOut",
    label: "터미널 폰트 축소 (view 인스턴스 오버라이드)",
    defaultKeys: "Ctrl+-",
    group: "Terminal",
  },
  {
    id: "terminal.zoomReset",
    label: "터미널 폰트 프로파일 기본값으로 복귀",
    defaultKeys: "Ctrl+0",
    group: "Terminal",
  },
  // -- Memo --
  {
    id: "memo.zoomIn",
    label: "메모 폰트 확대 (view 인스턴스 오버라이드)",
    defaultKeys: "Ctrl+=",
    group: "Memo",
  },
  {
    id: "memo.zoomOut",
    label: "메모 폰트 축소 (view 인스턴스 오버라이드)",
    defaultKeys: "Ctrl+-",
    group: "Memo",
  },
  {
    id: "memo.zoomReset",
    label: "메모 폰트 기본값으로 복귀",
    defaultKeys: "Ctrl+0",
    group: "Memo",
  },
  // -- Issue Reporter --
  {
    id: "issueReporter.submit",
    label: "이슈 제출",
    defaultKeys: "Ctrl+Enter",
    group: "Issue Reporter",
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

/**
 * Case-insensitive on modifiers and the key token, so hand-edited
 * settings.json entries like "ctrl+shift+p" still match. The capture UI
 * always writes canonical case; this only widens what we accept.
 */
function parseShortcut(shortcut: string): ParsedShortcut {
  const parts = shortcut.split("+");
  const modifiers = new Set(parts.slice(0, -1).map((m) => m.toLowerCase()));
  const key = parts[parts.length - 1] || "";
  return {
    ctrl: modifiers.has("ctrl"),
    alt: modifiers.has("alt"),
    shift: modifiers.has("shift"),
    key: normalizeKey(key),
  };
}

function normalizeKey(key: string): string {
  return KEY_NORMALIZE[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** Normalized arrow-key tokens matched by the `Arrow` wildcard (e.g. `pane.focus` = "Alt+Arrow"). */
const ARROW_WILDCARD_KEYS = new Set(["Up", "Down", "Left", "Right"]);

/** True if a combo string's key token is the `Arrow` wildcard (any arrow direction). */
export function usesArrowWildcard(keys: string): boolean {
  return parseShortcut(keys).key.toLowerCase() === "arrow";
}

/**
 * Replace a captured arrow-direction token (e.g. "Ctrl+Alt+Left") with the
 * `Arrow` wildcard ("Ctrl+Alt+Arrow"). Used by the Settings capture UI when
 * rebinding a wildcard action like `pane.focus`, so pressing any one arrow
 * rebinds all four directions instead of narrowing the action to a single one.
 * Returns the input unchanged when its key token is not an arrow direction.
 */
export function coerceArrowWildcard(keys: string): string {
  const parts = keys.split("+");
  const last = parts[parts.length - 1] || "";
  if (!ARROW_WILDCARD_KEYS.has(normalizeKey(last))) return keys;
  return [...parts.slice(0, -1), "Arrow"].join("+");
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
 * React hook variant of `resolveKeybinding()`.
 * Subscribes to the settings store, so components re-render (and tooltips refresh)
 * when the user rebinds the action in Settings. (PR #331 review)
 */
export function useResolvedKeybinding(actionId: string): string | undefined {
  const userOverrides = useSettingsStore((s) => s.keybindings);
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

  // `Arrow` is a wildcard token matching any of the four arrow keys
  // (used by directional bindings like `pane.focus` = "Alt+Arrow").
  // Key comparison is case-insensitive so hand-edited tokens like "up"
  // or "pageup" still match their canonical event names.
  const keyMatches =
    parsed.key.toLowerCase() === "arrow"
      ? ARROW_WILDCARD_KEYS.has(eventKey)
      : eventKey.toLowerCase() === parsed.key.toLowerCase();

  return (
    e.ctrlKey === parsed.ctrl &&
    e.altKey === parsed.alt &&
    e.shiftKey === parsed.shift &&
    keyMatches
  );
}
