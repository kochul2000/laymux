/**
 * Pure keybinding core shared by the PC app and the Direct Remote page
 * (ADR-0269).
 *
 * Holds the default registry and the combo parser/matcher with no store or
 * DOM dependency, so the Remote bundle (`remote-app.js`) can import it next to
 * the PC wrapper (`keybinding-registry.ts`). User overrides are passed in
 * explicitly: the PC reads them from the settings store, the Remote page from
 * the navigation payload.
 */

/** One user override from `settings.json` `keybindings`. */
export interface KeybindingOverride {
  keys: string;
  command: string;
}

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
  // 워크스페이스의 모든 TerminalView pane 을 한 번에 클리어한다 (ADR-0137).
  // pane 컨트롤 바의 "Clear view"(pane 을 EmptyView 로 되돌림)와 다른 동작이다.
  {
    id: "workspace.clearTerminals",
    label: "워크스페이스 터미널 클리어",
    defaultKeys: "Ctrl+Alt+L",
    group: "Workspace",
    passThroughTerminal: true,
  },
  // -- Pane --
  {
    id: "pane.clearTerminal",
    label: "포커스 Pane 실제 클리어",
    defaultKeys: "Alt+L",
    group: "Pane",
    passThroughTerminal: true,
  },
  {
    id: "pane.focus",
    label: "Pane 포커스 이동",
    defaultKeys: "Alt+Arrow",
    group: "Pane",
    passThroughTerminal: true,
  },
  // Pane stack (ADR-0295): Right/Down = next layer, Left/Up = previous, ring.
  {
    id: "pane.layer",
    label: "스택 레이어 순환",
    defaultKeys: "Alt+Shift+Arrow",
    group: "Pane",
    passThroughTerminal: true,
  },
  {
    id: "pane.stack",
    label: "포커스 Pane 에 레이어 쌓기",
    defaultKeys: "Ctrl+Alt+S",
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
    id: "terminal.toggleInputMode",
    label: "터미널 직접 입력/입력칸 전환",
    defaultKeys: "Ctrl+Alt+M",
    group: "Terminal",
  },
  // OS 입력 소스(키보드 레이아웃) 전환용 chord. 기본값은 **미할당**이다 —
  // Shift+Space·Ctrl+Space 를 전역 하드코딩하면 그 조합을 터미널 텍스트로 쓰는
  // 사용자의 입력을 빼앗는다(issue #533). 사용자가 직접 바인딩한 경우에만
  // 그 물리 키에서 파생된 keydown/keypress/keyup·비조합 텍스트 삽입이 xterm 에
  // 들어가지 않게 막고, preventDefault 는 하지 않아 OS 전환은 그대로 동작한다.
  {
    id: "terminal.osInputSourceSwitch",
    label: "OS 입력 소스 전환 (PTY 입력 제외, 기본 미할당)",
    defaultKeys: "",
    group: "Terminal",
  },
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
  // -- Composer --
  // Composer 전송·줄바꿈은 입력 조건이 다른 PC 와 Remote 가 따로 바인딩한다
  // (ADR-0269). Remote 기본값은 소프트 키보드에서도 안전하다 — Ctrl 을 누를 수
  // 없으니 실수 전송이 없고, Enter 는 줄바꿈이다.
  { id: "composer.pc.send", label: "PC Composer 전송", defaultKeys: "Enter", group: "Composer" },
  {
    id: "composer.pc.newline",
    label: "PC Composer 줄바꿈",
    defaultKeys: "Shift+Enter",
    group: "Composer",
  },
  {
    id: "composer.remote.send",
    label: "Remote Composer 전송",
    defaultKeys: "Ctrl+Enter",
    group: "Composer",
  },
  {
    id: "composer.remote.newline",
    label: "Remote Composer 줄바꿈",
    defaultKeys: "Enter",
    group: "Composer",
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
 * True when a combo string actually binds something.
 *
 * An action may ship deliberately unassigned (`defaultKeys: ""`), and the
 * Settings capture UI writes an empty string while the user is still choosing.
 * Neither may ever match a key event: an empty combo parses to "no modifiers +
 * empty key", and treating that as a binding would make the action fire on
 * events it was never bound to.
 */
export function isAssignedKeybinding(keys: string | undefined): keys is string {
  return !!keys && keys.trim().length > 0;
}

/**
 * Resolve the effective combo for an action from an explicit override list
 * (user override > default). Returns undefined if the action is not registered.
 */
export function resolveKeybindingFrom(
  overrides: readonly KeybindingOverride[],
  actionId: string,
): string | undefined {
  const override = overrides.find((kb) => kb.command === actionId);
  if (override) return override.keys;
  return DEFAULT_KEYBINDINGS.find((d) => d.id === actionId)?.defaultKeys;
}

/** Physical key position → key token, only for letter and digit keys. */
function keyTokenFromCode(code: string | undefined): string | null {
  if (!code) return null;
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  return digit ? digit[1] : null;
}

const LATIN_ALNUM_KEY = /^[A-Za-z0-9]$/;
/** Hangul compatibility jamo: only a Korean IME emits these for a letter key. */
const HANGUL_JAMO_KEY = /^[\u3131-\u318E]$/;

interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey?: boolean;
  getModifierState?: (key: "AltGraph") => boolean;
}

/**
 * True when the event's physical `e.code` letter/digit may stand in for a
 * non-Latin `e.key` — i.e. the key press is not typing a character.
 *
 * - No character yet: a dead key or IME processing (`Dead`, `Process`, …).
 * - A Korean IME letter: jamo never come from a modifier layer.
 * - A Ctrl-only chord: Ctrl alone never types text (Russian Ctrl+С is Ctrl+C).
 *
 * Everything else is text: Windows reports AltGr as Ctrl+Alt (German AltGr+7
 * = "{"), and Mac Option types layout characters (German Option+L = "@").
 * Taking those as shortcuts would eat what the user is typing (ADR-0272).
 */
function physicalKeyMayStandIn(e: KeyEventLike): boolean {
  if (e.getModifierState?.("AltGraph")) return false;
  if (e.key.length > 1) return true;
  if (HANGUL_JAMO_KEY.test(e.key)) return true;
  // On Apple platforms Ctrl never types text, even with Option: Mac Chrome
  // reports Ctrl+Option+1 as "¡" although nothing is typed.
  if (e.ctrlKey && isApplePlatform()) return true;
  return e.ctrlKey && !e.altKey;
}

function isApplePlatform(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || "");
}

/**
 * Ctrl+single letter/digit (no Alt/Shift) is shell territory in a terminal:
 * it stays with the shell even when a user binds an IDE action there. The
 * letter is read the same way the matcher reads it, so a non-Latin layout
 * (Russian Ctrl+И = Ctrl+B) is owned by the shell too.
 */
export function isShellOwnedCombo(e: KeyEventLike): boolean {
  if (!e.ctrlKey || e.altKey || e.shiftKey) return false;
  if (LATIN_ALNUM_KEY.test(e.key)) return true;
  return physicalKeyMayStandIn(e) && keyTokenFromCode(e.code) !== null;
}

/**
 * True when a key event matches a combo string.
 *
 * `Arrow` is a wildcard token matching any of the four arrow keys (used by
 * directional bindings like `pane.focus` = "Alt+Arrow"). Key comparison is
 * case-insensitive so hand-edited tokens like "up" or "pageup" still match.
 *
 * With Ctrl or Alt held, a non-Latin `e.key` falls back to the physical
 * `e.code` letter/digit only when the press types no character (see
 * `physicalKeyMayStandIn`). A Latin letter/digit `e.key` stays authoritative
 * so layouts like Dvorak keep their meaning (ADR-0269 §8, narrowed by
 * ADR-0272).
 *
 * A combo cannot name Meta (Cmd/Win), so an event with Meta held never matches:
 * Cmd+Alt+Arrow stays the browser's tab switch instead of `Alt+Arrow`.
 */
export function keybindingMatchesEvent(keys: string | undefined, e: KeyEventLike): boolean {
  if (!isAssignedKeybinding(keys)) return false;

  if (e.metaKey) return false;
  const parsed = parseShortcut(keys);
  if (e.ctrlKey !== parsed.ctrl || e.altKey !== parsed.alt || e.shiftKey !== parsed.shift) {
    return false;
  }

  const wanted = parsed.key.toLowerCase();
  const eventKey = normalizeKey(e.key);
  if (wanted === "arrow") return ARROW_WILDCARD_KEYS.has(eventKey);
  if (eventKey.toLowerCase() === wanted) return true;

  if (!(e.ctrlKey || e.altKey) || LATIN_ALNUM_KEY.test(e.key)) return false;
  if (!physicalKeyMayStandIn(e)) return false;
  const codeKey = keyTokenFromCode(e.code);
  return codeKey !== null && codeKey.toLowerCase() === wanted;
}
