import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SyncCwdConfig, SyncCwdDefaults } from "./sync-cwd-config";

export type { SyncCwdConfig, SyncCwdDefaults } from "./sync-cwd-config";

export interface TerminalSessionResult {
  id: string;
  title: string;
  config: {
    profile: string;
    cols: number;
    rows: number;
    sync_group: string;
    env: [string, string][];
  };
}

export async function createTerminalSession(
  id: string,
  profile: string,
  cols: number,
  rows: number,
  syncGroup: string,
  cwdSend: boolean = true,
  cwdReceive: boolean = true,
  cwd?: string,
  startupCommandOverride?: string,
): Promise<TerminalSessionResult> {
  return invoke("create_terminal_session", {
    id,
    profile,
    cols,
    rows,
    syncGroup,
    cwdSend,
    cwdReceive,
    cwd: cwd ?? null,
    startupCommandOverride: startupCommandOverride ?? null,
  });
}

export async function writeToTerminal(id: string, data: string): Promise<void> {
  return invoke("write_to_terminal", { id, data });
}

export async function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  return invoke("resize_terminal", { id, cols, rows });
}

export async function closeTerminalSession(id: string): Promise<void> {
  return invoke("close_terminal_session", { id });
}

export async function getSyncGroupTerminals(groupName: string): Promise<string[]> {
  return invoke("get_sync_group_terminals", { groupName });
}

export interface LxResponse {
  success: boolean;
  data: string | null;
  error: string | null;
}

export async function handleLxMessage(messageJson: string): Promise<LxResponse> {
  return invoke("handle_lx_message", { messageJson });
}

export async function loadSettings(): Promise<Settings> {
  return invoke("load_settings");
}

export interface ValidationWarning {
  path: string;
  message: string;
  repaired: boolean;
}

export type SettingsLoadResult =
  | { status: "ok"; settings: Settings; warnings: ValidationWarning[] }
  | { status: "repaired"; settings: Settings; warnings: ValidationWarning[] }
  | { status: "parse_error"; settings: Settings; error: string; settingsPath: string };

export async function loadSettingsValidated(): Promise<SettingsLoadResult> {
  return invoke("load_settings_validated");
}

export async function resetSettings(): Promise<Settings> {
  return invoke("reset_settings");
}

export async function getSettingsPath(): Promise<string> {
  return invoke("get_settings_path");
}

export async function saveSettings(settings: Settings): Promise<void> {
  return invoke("save_settings", { settings });
}

export async function loadMemo(key: string): Promise<string> {
  return invoke("load_memo", { key });
}

export async function saveMemo(key: string, content: string): Promise<void> {
  return invoke("save_memo", { key, content });
}

export async function saveTerminalOutputCache(paneId: string, data: string): Promise<void> {
  return invoke("save_terminal_output_cache", { paneId, data });
}

export async function loadTerminalOutputCache(paneId: string): Promise<string> {
  return invoke("load_terminal_output_cache", { paneId });
}

export async function cleanTerminalOutputCache(activePaneIds: string[]): Promise<number> {
  return invoke("clean_terminal_output_cache", { activePaneIds });
}

export interface WindowGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export async function saveWindowGeometry(geo: WindowGeometry): Promise<void> {
  return invoke("save_window_geometry", { ...geo });
}

export async function loadWindowGeometry(): Promise<WindowGeometry | null> {
  return invoke("load_window_geometry");
}

export interface ConvenienceSettings {
  smartPaste: boolean;
  pasteImageDir: string;
  /** Strip common leading whitespace when pasting. */
  smartRemoveIndent: boolean;
  /** Rejoin URLs split across lines when pasting. */
  smartRemoveLineBreak: boolean;
}

export type ClaudeSyncCwdMode = "skip" | "command";
export type ClaudeStatusMessageMode = "bullet" | "title" | "title-bullet" | "bullet-title";
export type CodexStatusMessageMode = ClaudeStatusMessageMode;

export interface ClaudeSettings {
  syncCwd: ClaudeSyncCwdMode;
  /** Whether to restore Claude Code sessions on app restart (default: true). */
  restoreSession: boolean;
  /** Maximum age (hours) for Claude session files. 0 = no limit. Default: 24. */
  sessionMaxAgeHours: number;
  /** Status message display mode (default: "bullet-title"). */
  statusMessageMode: ClaudeStatusMessageMode;
  /** Delimiter between bullet and title when both shown (default: " · "). */
  statusMessageDelimiter: string;
}

export interface CodexSettings {
  /** Status message display mode (default: "title"). */
  statusMessageMode: CodexStatusMessageMode;
  /** Delimiter between bullet and title when both shown (default: " · "). */
  statusMessageDelimiter: string;
}

export interface IssueReporterSettings {
  shell: string;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
}

export interface MemoParagraphCopySettings {
  enabled: boolean;
  minBlankLines: number;
}

export interface MemoSettings {
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  /** Paragraph copy feature: show copy button on hover for paragraphs separated by N+ blank lines. */
  paragraphCopy: MemoParagraphCopySettings;
  /** Automatically copy selected text to clipboard (like terminal copyOnSelect). */
  copyOnSelect: boolean;
  /** Triple-click to select entire paragraph (requires paragraphCopy enabled). */
  tripleClickParagraphSelect: boolean;
  /** Tab indent size (number of spaces). */
  indentSize: number;
  fontFamily: string;
  fontSize: number;
  fontWeight: string;
}

export interface ExtensionViewer {
  extensions: string[];
  command: string;
}

export interface FileExplorerSettings {
  shellProfile: string;
  paddingTop: number;
  paddingRight: number;
  paddingBottom: number;
  paddingLeft: number;
  fontFamily: string;
  fontSize: number;
  copyOnSelect: boolean;
  extensionViewers: ExtensionViewer[];
}

export type FileViewerContent =
  | { kind: "text"; content: string; truncated: boolean }
  | { kind: "image"; dataUrl: string }
  | { kind: "binary"; size: number };

export interface WorkspaceDisplaySettings {
  minimap: boolean;
  environment: boolean;
  activity: boolean;
  path: boolean;
  result: boolean;
}

export interface ProfileDefaults {
  colorScheme?: string;
  cursorShape?: string;
  cursorBlink?: boolean;
  stabilizeInteractiveCursor?: boolean;
  padding?: PaddingSettings;
  scrollbackLines?: number;
  opacity?: number;
  bellStyle?: string;
  closeOnExit?: string;
  antialiasingMode?: string;
  suppressApplicationTitle?: boolean;
  snapOnInput?: boolean;
  font?: FontSettings;
  restoreCwd?: boolean;
  restoreOutput?: boolean;
  syncCwd?: SyncCwdConfig;
}

export interface Settings {
  colorSchemes: ColorScheme[];
  profiles: Profile[];
  keybindings: Keybinding[];
  font?: FontSettings;
  appFont?: FontSettings;
  defaultProfile: string;
  profileDefaults?: ProfileDefaults;
  syncCwdDefaults?: SyncCwdDefaults;
  viewOrder?: string[];
  appThemeId?: string;
  layouts: SettingsLayout[];
  workspaces: SettingsWorkspace[];
  docks: DockSetting[];
  workspaceDisplayOrder?: string[];
  workspaceSortOrder?: import("@/stores/settings-store").WorkspaceSortOrder;
  convenience: ConvenienceSettings;
  workspaceDisplay?: WorkspaceDisplaySettings;
  claude: ClaudeSettings;
  codex?: CodexSettings;
  memo: MemoSettings;
  issueReporter: IssueReporterSettings;
  fileExplorer: FileExplorerSettings;
}

export interface ColorScheme {
  name: string;
  foreground: string;
  background: string;
  cursorColor: string;
  selectionBackground: string;
  black?: string;
  red?: string;
  green?: string;
  yellow?: string;
  blue?: string;
  purple?: string;
  cyan?: string;
  white?: string;
  brightBlack?: string;
  brightRed?: string;
  brightGreen?: string;
  brightYellow?: string;
  brightBlue?: string;
  brightPurple?: string;
  brightCyan?: string;
  brightWhite?: string;
  [key: string]: string | undefined;
}

export interface PaddingSettings {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Profile {
  name: string;
  commandLine: string;
  startupCommand?: string;
  colorScheme: string;
  startingDirectory: string;
  hidden: boolean;
  cursorShape?: string;
  cursorBlink?: boolean;
  stabilizeInteractiveCursor?: boolean;
  padding?: PaddingSettings;
  scrollbackLines?: number;
  opacity?: number;
  tabTitle?: string;
  bellStyle?: string;
  closeOnExit?: string;
  antialiasingMode?: string;
  suppressApplicationTitle?: boolean;
  snapOnInput?: boolean;
  font?: FontSettings;
  restoreCwd?: boolean;
  restoreOutput?: boolean;
  syncCwd?: SyncCwdConfig;
}

export interface Keybinding {
  keys: string;
  command: string;
}

export interface FontSettings {
  face: string;
  size: number;
  weight?: string;
}

export interface SettingsLayout {
  id: string;
  name: string;
  panes: {
    x: number;
    y: number;
    w: number;
    h: number;
    viewType: string;
    viewConfig?: { type: string; [key: string]: unknown };
  }[];
}

export interface SettingsWorkspace {
  id: string;
  name: string;
  layoutId?: string; // deprecated — kept for backward compat with old settings.json
  panes: {
    id?: string;
    x: number;
    y: number;
    w: number;
    h: number;
    view: { type: string; [key: string]: unknown };
  }[];
}

export interface DockPaneSetting {
  id: string;
  view: { type: string; [key: string]: unknown };
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DockSetting {
  position: string;
  activeView: string | null;
  views: string[];
  visible: boolean;
  size?: number;
  panes?: DockPaneSetting[];
}

export interface SmartPasteResult {
  pasteType: string; // "path" | "none"
  content: string;
}

/** Perform smart paste: check clipboard for files/images, return path or "none". */
export async function smartPaste(imageDir: string, profile: string): Promise<SmartPasteResult> {
  return invoke("smart_paste", { imageDir, profile });
}

/** Write text to the system clipboard via Tauri backend. */
export async function clipboardWriteText(text: string): Promise<void> {
  return invoke("clipboard_write_text", { text });
}

/** A single directory entry returned by the Rust backend. */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
  isExecutable: boolean;
  size: number;
}

/** List directory contents via Rust std::fs::read_dir. */
export async function listDirectory(path: string, wslDistro?: string): Promise<DirEntry[]> {
  return invoke("list_directory", { path, wslDistro: wslDistro ?? null });
}

/** Read a file and classify it for the file viewer. */
export async function readFileForViewer(
  path: string,
  maxBytes?: number,
): Promise<FileViewerContent> {
  return invoke("read_file_for_viewer", { path, maxBytes: maxBytes ?? null });
}

/** Update whether a terminal sends CWD changes to other terminals. */
export async function setTerminalCwdSend(terminalId: string, send: boolean): Promise<void> {
  return invoke("set_terminal_cwd_send", { terminalId, send });
}

/** Update whether a terminal accepts CWD sync from other terminals. */
export async function setTerminalCwdReceive(terminalId: string, receive: boolean): Promise<void> {
  return invoke("set_terminal_cwd_receive", { terminalId, receive });
}

/** Move a terminal to a different sync group in the backend. */
export async function updateTerminalSyncGroup(terminalId: string, newGroup: string): Promise<void> {
  return invoke("update_terminal_sync_group", { terminalId, newGroup });
}

/** Open a URL in the user's default browser via Tauri shell plugin. */
export async function openExternal(url: string): Promise<void> {
  try {
    const { open } = await import("@tauri-apps/plugin-shell");
    await open(url);
  } catch (e) {
    console.warn("shell.open failed, falling back to window.open:", e);
    window.open(url, "_blank");
  }
}

/** Listen for terminal output events from the backend. */
export function onTerminalOutput(
  terminalId: string,
  callback: (data: Uint8Array) => void,
): Promise<UnlistenFn> {
  return listen<number[]>(`terminal-output-${terminalId}`, (event) => {
    callback(new Uint8Array(event.payload));
  });
}

/** Listen for sync-cwd events from the backend. */
export function onSyncCwd(
  callback: (data: {
    path: string;
    terminalId: string;
    groupId: string;
    targets: string[];
  }) => void,
): Promise<UnlistenFn> {
  return listen("sync-cwd", (event) => {
    callback(
      event.payload as {
        path: string;
        terminalId: string;
        groupId: string;
        targets: string[];
      },
    );
  });
}

/** Listen for sync-branch events from the backend. */
export function onSyncBranch(
  callback: (data: { branch: string; terminalId: string; groupId: string }) => void,
): Promise<UnlistenFn> {
  return listen("sync-branch", (event) => {
    callback(
      event.payload as {
        branch: string;
        terminalId: string;
        groupId: string;
      },
    );
  });
}

/** Listen for Lx notification events. */
export function onLxNotify(
  callback: (data: { message: string; terminalId: string; level?: string }) => void,
): Promise<UnlistenFn> {
  return listen("lx-notify", (event) => {
    callback(event.payload as { message: string; terminalId: string; level?: string });
  });
}

/** Listen for tab title change events. */
export function onSetTabTitle(
  callback: (data: { title: string; terminalId: string }) => void,
): Promise<UnlistenFn> {
  return listen("set-tab-title", (event) => {
    callback(event.payload as { title: string; terminalId: string });
  });
}

/** Listen for command status events (OSC 133 E/D). */
export function onCommandStatus(
  callback: (data: { terminalId: string; command?: string; exitCode?: number }) => void,
): Promise<UnlistenFn> {
  return listen("command-status", (event) => {
    callback(
      event.payload as {
        terminalId: string;
        command?: string;
        exitCode?: number;
      },
    );
  });
}

export interface ListeningPort {
  port: number;
  pid: number | null;
  process_name: string | null;
}

/** Get currently listening TCP ports. */
export async function getListeningPorts(): Promise<ListeningPort[]> {
  return invoke("get_listening_ports");
}

/** Get the current git branch for a working directory. */
export async function getGitBranch(workingDir: string): Promise<string | null> {
  return invoke("get_git_branch", { workingDir });
}

/** Listen for open-file events from the backend. */
export function onOpenFile(
  callback: (data: { path: string; terminalId: string }) => void,
): Promise<UnlistenFn> {
  return listen("open-file", (event) => {
    callback(event.payload as { path: string; terminalId: string });
  });
}

/** Send an OS-level notification. */
export async function sendOsNotification(title: string, body: string): Promise<void> {
  return invoke("send_os_notification", { title, body });
}

// -- Automation API --

export interface AutomationRequest {
  requestId: string;
  category: string;
  target: string;
  method: string;
  params: Record<string, unknown>;
}

/** Listen for automation requests from the backend HTTP server. */
export function onAutomationRequest(
  callback: (data: AutomationRequest) => void,
): Promise<UnlistenFn> {
  return listen<AutomationRequest>("automation-request", (event) => {
    callback(event.payload);
  });
}

/** Send automation response back to the backend. */
export async function automationResponse(
  requestId: string,
  success: boolean,
  data?: unknown,
  error?: string,
): Promise<void> {
  const responseJson = JSON.stringify({
    requestId,
    success,
    data: data ?? null,
    error: error ?? null,
  });
  return invoke("automation_response", { responseJson });
}

// -- Claude terminal detection (single source of truth in backend) --

/** Listen for Claude Code terminal detection events from the backend PTY callback. */
export function onClaudeTerminalDetected(
  callback: (terminalId: string) => void,
): Promise<UnlistenFn> {
  return listen<string>("claude-terminal-detected", (event) => {
    callback(event.payload);
  });
}

/** Listen for DEC 2026 output activity events from the backend PTY callback.
 *  Emitted (throttled, max 1/sec per terminal) when a TUI app redraws its screen.
 *  active=false is sent when a TUI app transitions from working→idle (e.g., task completion). */
export function onTerminalOutputActivity(
  callback: (data: { terminalId: string; active?: boolean }) => void,
): Promise<UnlistenFn> {
  return listen<{ terminalId: string; active?: boolean }>("terminal-output-activity", (event) => {
    callback(event.payload);
  });
}

/** Listen for Claude Code white-● message changes from the backend. */
export function onClaudeMessageChanged(
  callback: (data: { terminalId: string; message: string }) => void,
): Promise<UnlistenFn> {
  return listen<{ terminalId: string; message: string }>("claude-message-changed", (event) => {
    callback(event.payload);
  });
}

/** Register a terminal as running Claude Code in the backend (single source of truth).
 *  Called when the frontend detects Claude from command text (OSC 133 E). */
export async function markClaudeTerminal(id: string): Promise<boolean> {
  return invoke("mark_claude_terminal", { id });
}

/** Register a terminal as running Codex in the backend.
 *  Called when the frontend detects Codex from command text (OSC 133 E). */
export async function markCodexTerminal(id: string): Promise<boolean> {
  return invoke("mark_codex_terminal", { id });
}

/** Check if a terminal is registered as Claude Code in the backend. */
export async function isClaudeTerminal(id: string): Promise<boolean> {
  return invoke("is_claude_terminal", { id });
}

/** Check if a terminal is registered as Codex in the backend. */
export async function isCodexTerminal(id: string): Promise<boolean> {
  return invoke("is_codex_terminal", { id });
}

/** Resolve Claude Code session IDs for all known Claude terminals.
 *  Returns a map of terminal_id → Claude session ID.
 *  @param sessionMaxAgeHours - Max session age in hours. 0 disables the filter. */
export async function getClaudeSessionIds(
  sessionMaxAgeHours?: number,
): Promise<Record<string, string>> {
  return invoke("get_claude_session_ids", {
    sessionMaxAgeHours: sessionMaxAgeHours ?? null,
  });
}

// -- Terminal CWD (single source of truth in backend) --

/** Get CWD for all terminals from backend (single source of truth).
 *  Returns a map of terminal_id → normalized CWD path. */
export async function getTerminalCwds(): Promise<Record<string, string>> {
  return invoke("get_terminal_cwds");
}

/** Listen for CWD change events detected directly from PTY output in the backend. */
export function onTerminalCwdChanged(
  callback: (data: { terminalId: string; cwd: string; cwdSend?: boolean }) => void,
): Promise<UnlistenFn> {
  return listen<{ terminalId: string; cwd: string; cwdSend?: boolean }>(
    "terminal-cwd-changed",
    (event) => {
      callback(event.payload);
    },
  );
}

export interface TerminalTitleChangedData {
  terminalId: string;
  title: string;
  interactiveApp: string | null;
  notifyGateArmed: boolean;
}

export function onTerminalTitleChanged(
  callback: (data: TerminalTitleChangedData) => void,
): Promise<UnlistenFn> {
  return listen<TerminalTitleChangedData>("terminal-title-changed", (event) => {
    callback(event.payload);
  });
}

// -- Terminal summaries (single source of truth for workspace list) --

export interface TerminalNotificationResponse {
  id: number;
  terminalId: string;
  message: string;
  level: string;
  createdAt: number;
  readAt: number | null;
}

export interface TerminalSummaryResponse {
  id: string;
  profile: string;
  title: string;
  cwd: string | null;
  branch: string | null;
  lastCommand: string | null;
  lastExitCode: number | null;
  lastCommandAt: number | null;
  commandRunning: boolean;
  activity: { type: "shell" } | { type: "running" } | { type: "interactiveApp"; name: string };
  isClaude: boolean;
  claudeMessage: string | null;
  unreadNotificationCount: number;
  latestNotification: TerminalNotificationResponse | null;
}

/** Get comprehensive summary for requested terminals from backend (single source of truth).
 *  Returns all data needed to render WorkspaceSelectorView. */
export async function getTerminalSummaries(
  terminalIds: string[],
): Promise<TerminalSummaryResponse[]> {
  return invoke("get_terminal_summaries", { terminalIds });
}

/** Mark notifications as read for the given terminal IDs. Returns count of marked. */
export async function markNotificationsRead(terminalIds: string[]): Promise<number> {
  return invoke("mark_notifications_read", { terminalIds });
}
