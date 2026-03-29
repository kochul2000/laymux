import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

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
): Promise<TerminalSessionResult> {
  return invoke("create_terminal_session", {
    id,
    profile,
    cols,
    rows,
    syncGroup,
  });
}

export async function writeToTerminal(
  id: string,
  data: string,
): Promise<void> {
  return invoke("write_to_terminal", { id, data });
}

export async function resizeTerminal(
  id: string,
  cols: number,
  rows: number,
): Promise<void> {
  return invoke("resize_terminal", { id, cols, rows });
}

export async function closeTerminalSession(id: string): Promise<void> {
  return invoke("close_terminal_session", { id });
}

export async function getSyncGroupTerminals(
  groupName: string,
): Promise<string[]> {
  return invoke("get_sync_group_terminals", { groupName });
}

export interface LxResponse {
  success: boolean;
  data: string | null;
  error: string | null;
}

export async function handleLxMessage(
  messageJson: string,
): Promise<LxResponse> {
  return invoke("handle_lx_message", { messageJson });
}

export async function loadSettings(): Promise<Settings> {
  return invoke("load_settings");
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

export interface ConvenienceSettings {
  smartPaste: boolean;
  pasteImageDir: string;
}

export type ClaudeSyncCwdMode = "skip" | "command";

export interface ClaudeSettings {
  syncCwd: ClaudeSyncCwdMode;
}

export interface ProfileDefaults {
  colorScheme?: string;
  cursorShape?: string;
  padding?: PaddingSettings;
  scrollbackLines?: number;
  opacity?: number;
  bellStyle?: string;
  closeOnExit?: string;
  antialiasingMode?: string;
  suppressApplicationTitle?: boolean;
  snapOnInput?: boolean;
  font?: FontSettings;
}

export interface Settings {
  colorSchemes: ColorScheme[];
  profiles: Profile[];
  keybindings: Keybinding[];
  font?: FontSettings;
  defaultProfile: string;
  profileDefaults?: ProfileDefaults;
  viewOrder?: string[];
  appThemeId?: string;
  layouts: SettingsLayout[];
  workspaces: SettingsWorkspace[];
  docks: DockSetting[];
  convenience: ConvenienceSettings;
  claude: ClaudeSettings;
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
  panes: { x: number; y: number; w: number; h: number; viewType: string }[];
}

export interface SettingsWorkspace {
  id: string;
  name: string;
  layoutId: string;
  panes: {
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
export async function smartPaste(
  imageDir: string,
  profile: string,
): Promise<SmartPasteResult> {
  return invoke("smart_paste", { imageDir, profile });
}

/** Write text to the system clipboard via Tauri backend. */
export async function clipboardWriteText(text: string): Promise<void> {
  return invoke("clipboard_write_text", { text });
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
    callback(event.payload as {
      path: string;
      terminalId: string;
      groupId: string;
      targets: string[];
    });
  });
}

/** Listen for sync-branch events from the backend. */
export function onSyncBranch(
  callback: (data: {
    branch: string;
    terminalId: string;
    groupId: string;
  }) => void,
): Promise<UnlistenFn> {
  return listen("sync-branch", (event) => {
    callback(event.payload as {
      branch: string;
      terminalId: string;
      groupId: string;
    });
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
  callback: (data: {
    terminalId: string;
    command?: string;
    exitCode?: number;
  }) => void,
): Promise<UnlistenFn> {
  return listen("command-status", (event) => {
    callback(event.payload as {
      terminalId: string;
      command?: string;
      exitCode?: number;
    });
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
export async function getGitBranch(
  workingDir: string,
): Promise<string | null> {
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
export async function sendOsNotification(
  title: string,
  body: string,
): Promise<void> {
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
