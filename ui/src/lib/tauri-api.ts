import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open as openInDefaultApp } from "@tauri-apps/plugin-shell";
import { forgetTerminalOutputRecoveryCounters } from "./terminal-output-recovery-metrics";
import { forgetTerminalOutputPipelineCounters } from "./terminal-output-pipeline-metrics";
import { forgetTerminalInputDeliveryCounters } from "./terminal-input-delivery-metrics";
import type { TerminalOutputEnvelopePayload } from "./terminal-output-envelope";
import type { SyncCwdConfig, SyncCwdDefaults } from "./sync-cwd-config";
import type { TerminalActivityInfo } from "@/stores/terminal-store";
import type { InitialExecutionHost } from "./terminal-execution-host";

export type { SyncCwdConfig, SyncCwdDefaults } from "./sync-cwd-config";

export interface TerminalSessionResult {
  id: string;
  title: string;
  initialExecutionHost: InitialExecutionHost;
  config: {
    profile: string;
    cols: number;
    rows: number;
    sync_group: string;
    env: [string, string][];
    advertise_true_color: boolean;
  };
}

export interface ViewerStartupRequest {
  command: string;
  path: string;
}

export type TerminalStartupRequest = string | ViewerStartupRequest;

// React effect cleanup cannot await an async close before a replacement
// effect starts. Serialize create/close for each terminal id so an unmount
// during create becomes create→close, and an immediate remount becomes
// create→close→create instead of racing two backend lifecycle commands.
const terminalLifecycleChains = new Map<string, Promise<void>>();

function enqueueTerminalLifecycle<T>(id: string, task: () => Promise<T>): Promise<T> {
  const previous = terminalLifecycleChains.get(id) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(task);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  terminalLifecycleChains.set(id, settled);
  void settled.finally(() => {
    if (terminalLifecycleChains.get(id) === settled) terminalLifecycleChains.delete(id);
  });
  return result;
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
  startup?: TerminalStartupRequest,
): Promise<TerminalSessionResult> {
  const startupCommandOverride = typeof startup === "string" ? startup : null;
  const viewer = startup && typeof startup === "object" ? startup : null;
  return enqueueTerminalLifecycle(id, () =>
    invoke("create_terminal_session", {
      id,
      profile,
      cols,
      rows,
      syncGroup,
      cwdSend,
      cwdReceive,
      cwd: cwd ?? null,
      startupCommandOverride,
      viewer,
    }),
  );
}

export async function writeToTerminal(id: string, data: string): Promise<void> {
  return invoke("write_to_terminal", { id, data });
}

export async function writeTerminalProtocolReply(id: string, data: string): Promise<void> {
  return invoke("write_terminal_protocol_reply", { id, data });
}

/**
 * Shutdown-only Ctrl+C (issue #451). Sends ETX bypassing the human-control
 * owner gate so kill-on-exit still fires while a remote client holds the
 * control lease. Only ever sends ETX; not a general write path.
 */
export async function interruptTerminalOnExit(id: string): Promise<void> {
  return invoke("interrupt_terminal_on_exit", { id });
}

export async function writeTerminalInput(id: string, text: string, submit: boolean): Promise<void> {
  return invoke("write_terminal_input", { id, text, submit });
}

export interface TerminalAttachState {
  version: number;
  generation: number;
  snapshotStartSeq: number;
  snapshotSeq: number;
  sourceStartSeq: number;
  sourceSeq: number;
  snapshotKind: "raw";
  protocolRevision: number;
  modes: { bracketedPaste: boolean };
  geometry: { revision: number; cols: number; rows: number };
}

export interface TerminalOutputAttachmentPayload {
  state: TerminalAttachState;
  snapshot: number[];
  flowControl: {
    token: string;
    windowBytes: number;
    nextEnvelopeId?: number;
  };
}

export interface TerminalOutputAttachFailStoppedPayload {
  kind: "failStopped";
  terminalId: string;
  generation: number;
  reason: string;
}

export type TerminalOutputAttachResult =
  | TerminalOutputAttachmentPayload
  | TerminalOutputAttachFailStoppedPayload;

export interface TerminalOutputDeltaPayload {
  generation: number;
  seqStart: number;
  seqEnd: number;
  data: number[];
  geometry: { revision: number; cols: number; rows: number };
}

export async function attachTerminalOutput(id: string): Promise<TerminalOutputAttachResult> {
  return invoke("attach_terminal_output", { id });
}

export async function acknowledgeTerminalOutput(
  id: string,
  generation: number,
  token: string,
  seq: number,
): Promise<boolean> {
  return invoke("acknowledge_terminal_output", { id, generation, token, seq });
}

export async function acknowledgeTerminalOutputEnvelope(
  id: string,
  generation: number,
  token: string,
  envelopeId: number,
  grantId: string | null,
  seqEnd: number,
): Promise<boolean> {
  return invoke("acknowledge_terminal_output_envelope", {
    id,
    generation,
    token,
    envelopeId,
    grantId,
    seqEnd,
  });
}

export type TerminalOutputEnvelopeRepairStatus =
  | "idle"
  | "eventPending"
  | "exact"
  | "stale"
  | "alreadyReceipted"
  | "mismatch"
  | "exhausted";

export interface TerminalOutputEnvelopeRepairResponse {
  status: TerminalOutputEnvelopeRepairStatus;
  envelope: TerminalOutputEnvelopePayload | null;
}

export async function repairTerminalOutputEnvelope(
  id: string,
  generation: number,
  token: string,
  envelopeId: number,
  grantId: string | null,
  seqStart: number,
): Promise<TerminalOutputEnvelopeRepairResponse> {
  return invoke("repair_terminal_output_envelope", {
    id,
    generation,
    token,
    envelopeId,
    grantId,
    seqStart,
  });
}

export async function holdTerminalOutputContinuation(
  id: string,
  generation: number,
  token: string,
  envelopeId: number,
  grantId: string,
  frameStartSeq: number,
): Promise<boolean> {
  return invoke("hold_terminal_output_continuation", {
    id,
    generation,
    token,
    envelopeId,
    grantId,
    frameStartSeq,
  });
}

export async function closeTerminalOutputContinuation(
  id: string,
  generation: number,
  token: string,
  envelopeId: number,
  grantId: string,
  closeSeq: number,
  reason: string,
): Promise<boolean> {
  return invoke("close_terminal_output_continuation", {
    id,
    generation,
    token,
    envelopeId,
    grantId,
    closeSeq,
    reason,
  });
}

export type TerminalOutputSurfaceFailStopReason = "surface_unavailable" | "control_orphan_cap";

export interface TerminalOutputSurfaceFailStoppedPayload {
  terminalId: string;
  generation: number;
  /** Bootstrap/pre-attach failures have no desktop lease yet. */
  leaseToken: string | null;
  /** Backend delivery has a wider typed failure set than the two report inputs. */
  reason: string;
}

/** Best-effort publication of a current desktop v3 surface failure. */
export async function failStopTerminalOutputSurface(
  id: string,
  generation: number,
  token: string,
  reason: TerminalOutputSurfaceFailStopReason,
): Promise<boolean> {
  return invoke("fail_stop_terminal_output_surface", { id, generation, token, reason });
}

/**
 * Pull the exact byte range this surface lost to a `terminal-output-v2` delivery
 * gap (ADR-0072). `null` means the backend ring can no longer bridge `seq` — the
 * caller must fall back to `attachTerminalOutput`.
 */
export async function resumeTerminalOutput(
  id: string,
  generation: number,
  seq: number,
): Promise<TerminalOutputDeltaPayload | null> {
  return invoke("resume_terminal_output", { id, generation, seq });
}

export interface TerminalGeometryCapabilities {
  exactGeometryCutover: boolean;
  interruptibleRead: boolean;
  followUpIssue: number;
}

export async function getTerminalGeometryCapabilities(): Promise<TerminalGeometryCapabilities> {
  return invoke("get_terminal_geometry_capabilities");
}

export async function resizeTerminal(
  id: string,
  cols: number,
  rows: number,
  exact = false,
): Promise<void> {
  return invoke("resize_terminal", { id, cols, rows, exact });
}

export async function closeTerminalSession(id: string): Promise<void> {
  // A surface that requested close is already gone from the input owner's
  // perspective. Fence its diagnostics before the serialized backend close
  // starts so a prior IPC completion cannot settle into a retired/reused id.
  forgetTerminalInputDeliveryCounters(id);
  return enqueueTerminalLifecycle(id, async () => {
    try {
      await invoke<void>("close_terminal_session", { id });
    } finally {
      // The output ring, the generation and every sequence the recovery totals
      // describe die with the session, so the diagnostic entry has nothing left
      // to describe. Dropped in `finally` because a failed close still means
      // this id's session is gone as far as the surface is concerned, and a
      // surviving entry would leak one map slot per terminal the window ever
      // opened (issue #607).
      forgetTerminalOutputRecoveryCounters(id);
      forgetTerminalOutputPipelineCounters(id);
      forgetTerminalInputDeliveryCounters(id);
    }
  });
}

export async function getSyncGroupTerminals(groupName: string): Promise<string[]> {
  return invoke("get_sync_group_terminals", { groupName });
}

export interface RemoteControlStatus {
  active: boolean;
  leaseId?: string | null;
  remoteAddr?: string | null;
  clientName?: string | null;
  heartbeatTimeoutSeconds: number;
}

export interface RemoteAccessStatus {
  effectiveEnabled: boolean;
  persistentEnabled: boolean;
  runtimeEnabled: boolean;
  authTokenConfigured: boolean;
  effectiveAuthToken: string;
}

export interface CloudStatus {
  connected: boolean;
  instanceId?: string | null;
  lastError?: string | null;
}

export async function getRemoteAccessStatus(): Promise<RemoteAccessStatus> {
  return invoke("get_remote_access_status");
}

export async function setRemoteRuntimeAccess(
  enabled: boolean,
  authToken?: string | null,
): Promise<RemoteAccessStatus> {
  return invoke("set_remote_runtime_access", {
    enabled,
    authToken: authToken ?? null,
  });
}

export async function getRemoteControlStatus(): Promise<RemoteControlStatus> {
  return invoke("get_remote_control_status");
}

export interface HostCandidate {
  kind: "loopback" | "tailscale" | "lan";
  host: string;
  label: string;
}

export async function getRemoteHostCandidates(): Promise<HostCandidate[]> {
  return invoke("get_remote_host_candidates");
}

export async function getCloudStatus(): Promise<CloudStatus> {
  return invoke("get_cloud_status");
}

export async function cloudConnectStart(): Promise<CloudStatus> {
  return invoke("cloud_connect_start");
}

export async function cloudDisconnect(): Promise<CloudStatus> {
  return invoke("cloud_disconnect");
}

export async function reclaimRemoteControl(): Promise<RemoteControlStatus> {
  return invoke("reclaim_remote_control");
}

/** Whether the window is currently viewed over an OS remote-desktop (RDP) session. */
export async function getRemoteSessionActive(): Promise<boolean> {
  return invoke("get_remote_session_active");
}

/** Listen for OS remote-desktop (RDP) session connect/disconnect transitions. */
export function onRemoteSessionChanged(callback: (active: boolean) => void): Promise<UnlistenFn> {
  return listen<boolean>("remote-session-changed", (event) => {
    callback(event.payload);
  });
}

export interface TerminalStateInfo {
  activity: TerminalActivityInfo;
}

/**
 * Snapshot of every live terminal's backend-detected activity. Unlike the
 * `terminal-title-changed` event stream (which only fires on new OSC titles),
 * this is a pull of the current truth — used on mount/reload to re-seed the
 * activity store for already-running interactive apps that emit no further
 * events (e.g. an idle Claude after a webview reload). See ADR-0009.
 */
export async function getTerminalStates(): Promise<Record<string, TerminalStateInfo>> {
  return invoke("get_terminal_states");
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
  /**
   * Type-error paths were dropped in favour of their defaults (ADR-0116).
   * User-authored values were lost, so settings writes stay blocked until the
   * user acknowledges the listed paths.
   */
  | {
      status: "recovered";
      settings: Settings;
      warnings: ValidationWarning[];
      settingsPath: string;
    }
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

// ── Claude usage probe (ADR-0102) ────────────────────────────────

/** One usage limit row. `reset` is verbatim Claude Code text, not parsed here. */
export interface UsageLimit {
  percent: number | null;
  reset: string | null;
}

/**
 * Why a probe is or is not reporting numbers. Only `ready` means the
 * percentages are meaningful.
 */
export type UsageProbeStatus =
  | { type: "idle" }
  | { type: "starting" }
  | { type: "ready" }
  | { type: "claudeMissing" }
  | { type: "startupTimeout" }
  | { type: "parseFailed" }
  | { type: "upstreamError"; message: string }
  | { type: "failed"; message: string };

export interface UsageSnapshot {
  /** `CLAUDE_CONFIG_DIR` this snapshot describes; empty = default config dir. */
  configDir: string;
  status: UsageProbeStatus;
  session: UsageLimit;
  weekAll: UsageLimit;
  /**
   * Per-model weekly row. Claude Code names it after the account's model
   * (`Current week (Fable)`, `Current week (Sonnet only)`), so the label travels
   * with it instead of being assumed.
   */
  weekModel: UsageLimit;
  weekModelLabel: string | null;
  plan: string | null;
  model: string | null;
  capturedAtMs: number | null;
  nextQueryAtMs: number | null;
  /** Last captured screen, for diagnosing an upstream TUI change. */
  rawScreen: string | null;
}

export type CodexUsageStatus =
  | { type: "ready" }
  | { type: "codexMissing" }
  | { type: "unauthorized" }
  | { type: "failed"; message: string };

/** Which window of a quota family a limit row describes. */
export type CodexUsageWindowKind = "primary" | "secondary";

export interface CodexUsageLimit {
  key: string;
  label: string;
  kind: CodexUsageWindowKind;
  usedPercent: number;
  windowDurationMins: number;
  resetsAtSecs: number;
}

export interface CodexUsageSnapshot {
  status: CodexUsageStatus;
  limits: CodexUsageLimit[];
  plan: string | null;
  capturedAtMs: number | null;
}

/**
 * Keep a probe alive for `configDir` on behalf of one view instance. Resolves
 * with whatever snapshot is already cached, which may predate this call.
 */
export async function subscribeUsageProbe(
  subscriberId: string,
  configDir: string,
): Promise<UsageSnapshot> {
  return invoke("subscribe_usage_probe", { subscriberId, configDir });
}

/** Release a view instance's claim; the probe stops when none remain. */
export async function unsubscribeUsageProbe(subscriberId: string): Promise<void> {
  return invoke("unsubscribe_usage_probe", { subscriberId });
}

/** Read the cached snapshot without starting a probe. */
export async function getUsageSnapshot(configDir: string): Promise<UsageSnapshot> {
  return invoke("get_usage_snapshot", { configDir });
}

/** Ask a running probe to query now. `false` = no probe was running. */
export async function refreshUsageProbe(configDir: string): Promise<boolean> {
  return invoke("refresh_usage_probe", { configDir });
}

/** Read one local Codex CLI account's structured rate limits. */
export async function getCodexUsageSnapshot(configDir = ""): Promise<CodexUsageSnapshot> {
  return invoke("get_codex_usage_snapshot", { configDir });
}

// -- GitHub issue/PR list (issue #708) --

export type GithubRepoStatus =
  | { type: "ready" }
  /** A read for this repo is already in flight and nothing is cached yet. */
  | { type: "pending" }
  | { type: "notAGithubRepo" }
  | { type: "ghMissing" }
  | { type: "unauthorized" }
  | { type: "failed"; message: string };

export interface GithubItem {
  number: number;
  title: string;
  author: string;
  url: string;
  updatedAt: string;
  labels: string[];
  isDraft: boolean;
}

export interface GithubRepoSnapshot {
  status: GithubRepoStatus;
  /** `owner/repo`, or null when the working dir is not a GitHub repo. */
  repo: string | null;
  repoUrl: string | null;
  issues: GithubItem[];
  pulls: GithubItem[];
  fetchedAtMs: number | null;
}

/** Every mutating action the GitHub view may ask the backend to run. */
export type GithubItemAction =
  | "issue.close"
  | "issue.closeNotPlanned"
  | "pr.merge"
  | "pr.squash"
  | "pr.rebase"
  | "pr.close";

/**
 * Read the shared open issue/PR snapshot for the repository containing
 * `workingDir`. The backend serves one repository's snapshot from a registry,
 * so polling panes that watch the same repo do not each run `gh`.
 * `force` skips that refresh window for an explicit user refresh.
 */
export async function getGithubRepoSnapshot(
  workingDir: string,
  force = false,
): Promise<GithubRepoSnapshot> {
  return invoke("get_github_repo_snapshot", { workingDir, force });
}

/** Close/merge one issue or PR through `gh`. Rejects with gh's message. */
export async function runGithubItemAction(
  workingDir: string,
  action: GithubItemAction,
  number: number,
): Promise<void> {
  return invoke("run_github_item_action", { workingDir, action, number });
}

/** Listen for fresh usage captures so the view need not poll. */
export function onUsageSnapshotChanged(
  callback: (snapshot: UsageSnapshot) => void,
): Promise<UnlistenFn> {
  return listen<UsageSnapshot>("usage-snapshot-changed", (event) => {
    callback(event.payload);
  });
}

/**
 * Listen for sleep inhibitor changes nobody asked for (ADR-0114).
 *
 * The watchdog can acquire or lose one on its own. The frontend only sends
 * *changes*, so without this the UI would keep showing whatever the last
 * request returned — lit over a machine that is no longer protected, or failed
 * over one that has since recovered.
 */
export function onSleepInhibitChanged(
  callback: (state: { active: boolean; satisfied: boolean }) => void,
): Promise<UnlistenFn> {
  return listen<{ active: boolean; satisfied: boolean }>("sleep-inhibit-changed", (event) => {
    callback(event.payload);
  });
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
  /** Auto-send a resume message after a session-limit reset (default: true). */
  sessionLimitAutoResume: boolean;
  /** Seconds to wait after the reset time before resuming (default: 60). */
  sessionLimitResumeDelaySeconds: number;
  /** Message sent to resume work after the limit resets (default: "go on"). */
  sessionLimitResumeMessage: string;
}

export interface CodexSettings {
  /** Status message display mode (default: "title"). */
  statusMessageMode: CodexStatusMessageMode;
  /** Delimiter between bullet and title when both shown (default: " · "). */
  statusMessageDelimiter: string;
}

/** App-exit behavior (issue #451). */
export interface ExitSettings {
  /** Send Ctrl+C to all terminals on app exit. Default: false (opt-in). */
  interruptTerminals: boolean;
  /** How many Ctrl+C presses to send per terminal. Clamped 1..=10. Default: 3. */
  interruptRounds: number;
  /** Delay (ms) after the last Ctrl+C so agents can print their session id. Clamped 0..=10000. Default: 700. */
  settleMs: number;
}

/** What the workspace clear does with a pane that is mid-task (ADR-0113). */
export type WorkspaceClearBusyPolicyValue = "skip" | "interrupt" | "restart";

export interface WorkspaceClearSettings {
  /** Command submitted to a plain shell (`clear`, `cls`, …). Empty → `clear`. */
  shellCommand: string;
  /** Mid-task pane handling. Default: "skip". */
  busyPolicy: WorkspaceClearBusyPolicyValue;
  /** Ctrl+C presses before clearing under "interrupt". Clamped 1..=10. Default: 2. */
  interruptRounds: number;
  /** Delay (ms) after the last Ctrl+C. Clamped 0..=10000. Default: 400. */
  settleMs: number;
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
  /** Repository list ("owner/repo"). First entry is the default selection. */
  repositories: string[];
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
  profile: string;
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

/** Palette tokens offered for the `#123` emphasis. Names, so themes still own the hue. */
export type GithubNumberColor =
  | "yellow"
  | "accent"
  | "green"
  | "red"
  | "primary"
  | "secondary"
  | "muted";

export interface GithubSettings {
  /** Tab shown when the view first mounts. */
  defaultTab: "issues" | "pulls";
  /** Seconds between snapshot polls. Values below the backend's own refresh
   *  window just re-read its cache instead of hitting `gh` again. */
  refreshSeconds: number;
  /** Hide draft pull requests from the pulls tab. */
  hideDraftPulls: boolean;
  /** Row typeface; "" means the app UI font. */
  fontFamily: string;
  /** Row font size in px for the number and title; secondary columns derive from it. */
  fontSize: number;
  /** Palette token that paints `#123` — a name, never a raw color. */
  numberColor: GithubNumberColor;
  showAuthor: boolean;
  showUpdated: boolean;
  showDraftBadge: boolean;
  /** Labels shown per row; `0` hides the column. */
  labelMaxCount: number;
  /** Widest one label chip may get, in px. */
  labelMaxWidth: number;
}

/** One entry of an archive listing; mirrors Rust `commands::ArchiveEntry`. */
export interface ArchiveEntry {
  name: string;
  size: number;
  compressedSize: number;
  isDirectory: boolean;
}

/**
 * What `read_file_for_viewer` decided a file is. Hand-mirrored from the Rust
 * `FileViewerContent` enum (`commands/file_viewer.rs`) — there is no codegen,
 * so a new variant has to be added on both sides.
 */
export type FileViewerContent =
  | { kind: "text"; content: string; truncated: boolean }
  | { kind: "image"; dataUrl: string }
  | { kind: "pdf"; dataUrl: string }
  | {
      kind: "archive";
      /** `"zip" | "tar" | "tar.gz"`. */
      format: string;
      entries: ArchiveEntry[];
      /** Entries in the archive, which exceeds `entries.length` when capped. */
      totalEntries: number;
      /** Uncompressed bytes across every entry, not only the listed ones. */
      totalBytes: number;
      truncated: boolean;
    }
  | { kind: "binary"; size: number };

export type {
  AppearanceSettings,
  PasteSettings,
  TerminalSettings,
  ControlBarSettings,
  DockSettings,
  NotificationSettings,
  WorkspaceDisplaySettings,
  WorkspaceSelectorSettings,
} from "@/stores/settings-store";

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
  maxOutputCacheKB?: number;
  syncCwd?: SyncCwdConfig;
}

export interface RemoteSettings {
  enabled: boolean;
  bindAddress: string;
  allowedOrigins: string[];
  allowedIps: string[];
  authToken: string;
  heartbeatTimeoutSeconds: number;
  autoMobileModeMinWidth: number;
  snapshotMaxKib: number;
  preferredHost: string;
  customHosts: string[];
  cloudEnabled: boolean;
  relayBaseUrl: string;
  cloudInstanceId?: string | null;
  cloudTunnelUrl?: string | null;
  cloudServerBaseUrl?: string | null;
  cloudAutoReconnect: boolean;
  /** Send the desktop terminal font file to remote browsers (ADR-0077). */
  serveTerminalFont: boolean;
}

export interface Settings {
  /** App UI language: "system" (OS locale), "ko", or "en". */
  language?: import("@/stores/settings-store").LanguageSetting;
  colorSchemes: ColorScheme[];
  profiles: Profile[];
  keybindings: Keybinding[];
  defaultProfile: string;
  profileDefaults?: ProfileDefaults;
  syncCwdDefaults?: SyncCwdDefaults;
  viewOrder?: string[];
  appearance: import("@/stores/settings-store").AppearanceSettings;
  layouts: SettingsLayout[];
  workspaces: SettingsWorkspace[];
  docks: DockSetting[];
  workspaceDisplayOrder?: string[];
  paste: import("@/stores/settings-store").PasteSettings;
  terminal: import("@/stores/settings-store").TerminalSettings;
  controlBar: import("@/stores/settings-store").ControlBarSettings;
  usage: import("@/stores/settings-store").UsageSettings;
  widgets: import("@/lib/widget-placement").WidgetsSettings;
  dock: import("@/stores/settings-store").DockSettings;
  notifications: import("@/stores/settings-store").NotificationSettings;
  power?: import("@/stores/settings-store").PowerSettings;
  workspaceSelector: import("@/stores/settings-store").WorkspaceSelectorSettings;
  claude: ClaudeSettings;
  codex?: CodexSettings;
  exit?: ExitSettings;
  workspaceClear?: WorkspaceClearSettings;
  memo: MemoSettings;
  issueReporter: IssueReporterSettings;
  fileExplorer: FileExplorerSettings;
  remote?: RemoteSettings;
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
  pasteType: string; // "path" | "text" | "none"
  content: string;
  /** All resolved file paths when the clipboard holds files (issue #325). */
  paths?: string[];
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

/** Filesystem facts about a path (used by the File Explorer address bar, #278). */
export interface PathInfo {
  exists: boolean;
  isDirectory: boolean;
}

/**
 * Resolve a path (WSL/Windows translation handled by the backend) and report
 * whether it exists and is a directory. Never throws on a missing path —
 * returns `{ exists: false }` so the caller can show validation feedback.
 */
export async function statPath(path: string, wslDistro?: string): Promise<PathInfo> {
  return invoke("stat_path", { path, wslDistro: wslDistro ?? null });
}

/**
 * Hand a verified path-link target to the host desktop (issue #687, ADR-0100).
 * `open` uses the host file association (file) or file manager (directory);
 * `reveal` shows the target inside its parent directory.
 *
 * Only a spawn failure rejects — the host decides everything after that, so an
 * "how do you want to open this file?" dialog is a success, not an error.
 */
export async function openInOs(path: string, mode: "open" | "reveal"): Promise<void> {
  return invoke("open_in_os", { path, wslDistro: null, mode });
}

/** Resolve the user's home directory (fallback CWD for File Explorer). */
export async function getHomeDirectory(): Promise<string> {
  return invoke("get_home_directory");
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

/**
 * 1회성 CWD 전파 (issue #293). 해당 터미널의 현재 CWD 를 sync group 에 한 번 밀어넣는다.
 * 지속 동기화 토글(cwdSend/cwdReceive)과 무관하게, 평소 동기화를 꺼둔 file explorer/viewer 도
 * 이 순간의 CWD 로 따라오게 만든다. 전파할 CWD 가 없으면 백엔드에서 no-op 으로 처리된다.
 */
export async function propagateCwdOnce(terminalId: string): Promise<void> {
  return invoke("propagate_cwd_once", { terminalId });
}

/** Move a terminal to a different sync group in the backend. */
export async function updateTerminalSyncGroup(terminalId: string, newGroup: string): Promise<void> {
  return invoke("update_terminal_sync_group", { terminalId, newGroup });
}

/** Open a URL in the user's default browser via Tauri shell plugin. */
export async function openExternal(url: string): Promise<void> {
  try {
    await openInDefaultApp(url);
  } catch (e) {
    console.error("Failed to open external URL:", url, e);
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

/** Listen for sequenced terminal output used by listener-before-attach surfaces. */
export function onTerminalOutputV2(
  terminalId: string,
  callback: (delta: TerminalOutputDeltaPayload) => void,
): Promise<UnlistenFn> {
  return listen<TerminalOutputDeltaPayload>(`terminal-output-v2-${terminalId}`, (event) => {
    callback(event.payload);
  });
}

/** Listen for bounded v3 terminal output envelopes without copying their payload. */
export function onTerminalOutputV3(
  terminalId: string,
  callback: (envelope: TerminalOutputEnvelopePayload) => void,
): Promise<UnlistenFn> {
  return listen<TerminalOutputEnvelopePayload>(`terminal-output-v3-${terminalId}`, (event) => {
    callback(event.payload);
  });
}

/** Listen for the backend delivery owner fail-stopping a v3 surface. */
export function onTerminalOutputFailStopped(
  callback: (failure: TerminalOutputSurfaceFailStoppedPayload) => void,
): Promise<UnlistenFn> {
  return listen<TerminalOutputSurfaceFailStoppedPayload>("terminal-output-fail-stopped", (event) =>
    callback(event.payload),
  );
}

/**
 * Listen for sync-cwd events from the backend.
 *
 * `force`(issue #293): 컨트롤 패널의 "1회 전파" 버튼이 `propagate_cwd_once`(force=true)
 * 로 트리거한 전파에는 true 가 실린다. 평소 동기화를 꺼둔 file explorer 가 이 1회 전파에는
 * 따라오도록 프론트 게이트를 우회하는 데 사용한다.
 */
export function onSyncCwd(
  callback: (data: {
    path: string;
    terminalId: string;
    groupId: string;
    targets: string[];
    force?: boolean;
  }) => void,
): Promise<UnlistenFn> {
  return listen("sync-cwd", (event) => {
    callback(
      event.payload as {
        path: string;
        terminalId: string;
        groupId: string;
        targets: string[];
        force?: boolean;
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

/**
 * Resolve a path's git `origin` remote to its GitHub base URL
 * (`https://github.com/{owner}/{repo}`), or null when it is not a
 * GitHub-backed repo. Used to make plain-text `#123` references clickable
 * (issue #439).
 */
export async function resolveGitRemote(path: string): Promise<string | null> {
  return invoke("resolve_git_remote", { path });
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
  /** Wall-clock ms when Rust emitted this request. `Date.now()` − this = queue depth. */
  emittedAtMs: number;
  /**
   * Wall-clock ms after which `bridge_request` has stopped waiting. Past this
   * point a query's answer is worthless, so producing it only takes main-thread
   * time away from catching up (issue #606).
   */
  deadlineMs: number;
}

/** Listen for automation requests from the backend HTTP server. */
export function onAutomationRequest(
  callback: (data: AutomationRequest) => void,
): Promise<UnlistenFn> {
  return listen<AutomationRequest>("automation-request", (event) => {
    callback(event.payload);
  });
}

/** Listen for Direct Remote Mode controller lease changes. */
export function onRemoteControlChanged(
  callback: (data: RemoteControlStatus) => void,
): Promise<UnlistenFn> {
  return listen<RemoteControlStatus>("remote-control-changed", (event) => {
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

/**
 * Push the frontend's responsiveness vitals into Rust state (issue #606).
 *
 * Served back out by `GET /api/v1/diagnostics/frontend`, which is the only way to
 * read the frontend's condition while its main thread is too busy to answer an
 * `automation-request`.
 */
export async function reportFrontendHealth(report: Record<string, unknown>): Promise<void> {
  return invoke("report_frontend_health", { report });
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
  /**
   * True when the backend's Claude/Codex title state machine just
   * observed an explicit exit. Title handlers must drop the
   * `InteractiveApp{Claude|Codex}` pin even if their
   * `shouldPreserveActivityOnTitleReset` heuristic would normally hold
   * it across a shell-prompt title (issue #234 was the reason that
   * heuristic returns `true` unconditionally; this flag is the override
   * that re-introduces a real exit signal).
   */
  interactiveAppExited?: boolean;
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

/**
 * Hold or release the OS sleep inhibitor (ADR-0114). Idempotent — the backend
 * only touches the OS when the state actually changes. Resolves to the state
 * in effect afterwards.
 */
export async function setSleepInhibit(enabled: boolean): Promise<boolean> {
  return invoke("set_sleep_inhibit", { enabled });
}

/** Mark notifications as read for the given terminal IDs. Returns count of marked. */
export async function markNotificationsRead(terminalIds: string[]): Promise<number> {
  return invoke("mark_notifications_read", { terminalIds });
}
