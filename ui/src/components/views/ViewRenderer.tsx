import { useId, useRef, useEffect } from "react";
import type { ViewType, ViewInstanceConfig } from "@/stores/types";
import { useSettingsStore, FALLBACK_PROFILE, type TerminalLocation } from "@/stores/settings-store";
import { resolveSyncCwd } from "@/lib/sync-cwd-config";
import { getInstanceId } from "@/lib/view-instance-id";
import { EmptyView, type EmptyViewContext } from "./EmptyView";
import { WorkspaceSelectorView } from "./WorkspaceSelectorView";
import { TerminalView } from "./TerminalView";
import { SettingsView } from "./SettingsView";
import { IssueReporterView } from "./IssueReporterView";
import { MemoView } from "./MemoView";
import { UsageView } from "./UsageView";
import { CodexUsageView } from "./CodexUsageView";
import { FileExplorerView } from "./FileExplorerView";
import { GitHubView } from "./GitHubView";

export interface ViewRendererProps {
  viewType: ViewType | null;
  viewConfig?: ViewInstanceConfig;
  onSelectView?: (config: ViewInstanceConfig) => void;
  workspaceId?: string;
  workspaceName?: string;
  paneId?: string;
  emptyViewContext?: EmptyViewContext;
  isFocused?: boolean;
  onKeyboardActivity?: () => void;
  /** Where this view is rendered: "workspace" or "dock". Affects CWD sync defaults. */
  location?: TerminalLocation;
  /** TerminalView를 새 PTY 세션으로 교체할 때 증가시키는 로컬 epoch. */
  terminalRestartEpoch?: number;
  /** 재시작 시 현재 세션의 CWD를 설정 복원 여부와 무관하게 전달한다. */
  terminalRestartCwd?: string;
  /** 재시작 요청이 아직 첫 세션 생성에 소비되지 않았는지 나타낸다. */
  terminalRestartFresh?: boolean;
  /** 재시작 요청을 첫 세션 생성 뒤 소비한다. */
  onTerminalRestartConsumed?: () => void;
}

/** Wrapper that subscribes to sync-cwd settings only for TerminalView instances. */
function TerminalViewWithSyncCwd({
  viewConfig,
  workspaceId,
  paneId,
  isFocused,
  onKeyboardActivity,
  location,
  terminalRestartEpoch,
  terminalRestartCwd,
  terminalRestartFresh,
  onTerminalRestartConsumed,
}: {
  viewConfig?: ViewInstanceConfig;
  workspaceId?: string;
  paneId?: string;
  isFocused?: boolean;
  onKeyboardActivity?: () => void;
  location: TerminalLocation;
  terminalRestartEpoch?: number;
  terminalRestartCwd?: string;
  terminalRestartFresh?: boolean;
  onTerminalRestartConsumed?: () => void;
}) {
  const defaultProfile = useSettingsStore((s) => s.defaultProfile);
  const profileDefaultsSyncCwd = useSettingsStore((s) => s.profileDefaults.syncCwd);
  const syncCwdDefaults = useSettingsStore((s) => s.syncCwdDefaults);
  const fallbackId = useId();

  const configSyncGroup = (viewConfig?.syncGroup as string) ?? "";
  const effectiveSyncGroup = configSyncGroup || workspaceId || "";
  const instanceId = getInstanceId("TerminalView", paneId || fallbackId);
  const lastCwd = (viewConfig?.lastCwd as string) ?? undefined;
  const lastClaudeSession = (viewConfig?.lastClaudeSession as string) ?? undefined;
  const profileName = (viewConfig?.profile as string) || defaultProfile || FALLBACK_PROFILE;
  const profileSyncCwd = useSettingsStore(
    (s) => s.profiles.find((p) => p.name === profileName)?.syncCwd,
  );
  const resolvedDefaults = resolveSyncCwd({
    profileName,
    location,
    profileSyncCwd,
    profileDefaultsSyncCwd,
    syncCwdDefaults,
  });
  const cwdSend = (viewConfig?.cwdSend as boolean | undefined) ?? resolvedDefaults.send;
  const cwdReceive = (viewConfig?.cwdReceive as boolean | undefined) ?? resolvedDefaults.receive;

  return (
    <TerminalView
      key={terminalRestartEpoch ?? 0}
      instanceId={instanceId}
      paneId={paneId}
      profile={profileName}
      syncGroup={effectiveSyncGroup}
      cwdSend={cwdSend}
      cwdReceive={cwdReceive}
      workspaceId={workspaceId}
      isFocused={isFocused}
      onKeyboardActivity={onKeyboardActivity}
      lastCwd={lastCwd}
      lastClaudeSession={lastClaudeSession}
      restartCwd={terminalRestartCwd}
      isUserRestart={terminalRestartFresh ?? false}
      onUserRestartConsumed={onTerminalRestartConsumed}
    />
  );
}

/** Wrapper that subscribes to sync-cwd settings for FileExplorerView instances. */
function FileExplorerViewWithSyncCwd({
  viewConfig,
  workspaceId,
  paneId,
  isFocused,
  location,
}: {
  viewConfig?: ViewInstanceConfig;
  workspaceId?: string;
  paneId?: string;
  isFocused?: boolean;
  location: TerminalLocation;
}) {
  const defaultProfile = useSettingsStore((s) => s.defaultProfile);
  const fileExplorerSettings = useSettingsStore((s) => s.fileExplorer);
  const profileDefaultsSyncCwd = useSettingsStore((s) => s.profileDefaults.syncCwd);
  const syncCwdDefaults = useSettingsStore((s) => s.syncCwdDefaults);
  const fallbackId = useId();

  const configSyncGroup = (viewConfig?.syncGroup as string) ?? "";
  const effectiveSyncGroup = configSyncGroup || workspaceId || "";
  const instanceId = getInstanceId("FileExplorerView", paneId || fallbackId);
  const lastCwd = (viewConfig?.lastCwd as string) ?? undefined;

  // Use file explorer's shellProfile setting, or fall back to defaultProfile
  const profileName = fileExplorerSettings.shellProfile || defaultProfile || FALLBACK_PROFILE;
  const profileSyncCwd = useSettingsStore(
    (s) => s.profiles.find((p) => p.name === profileName)?.syncCwd,
  );
  const resolvedDefaults = resolveSyncCwd({
    profileName,
    location,
    profileSyncCwd,
    profileDefaultsSyncCwd,
    syncCwdDefaults,
  });
  const cwdSend = (viewConfig?.cwdSend as boolean | undefined) ?? resolvedDefaults.send;
  const cwdReceive = (viewConfig?.cwdReceive as boolean | undefined) ?? resolvedDefaults.receive;

  return (
    <FileExplorerView
      instanceId={instanceId}
      paneId={paneId}
      profile={profileName}
      syncGroup={effectiveSyncGroup}
      cwdSend={cwdSend}
      cwdReceive={cwdReceive}
      workspaceId={workspaceId}
      isFocused={isFocused}
      lastCwd={lastCwd}
    />
  );
}

/**
 * Wrapper that resolves the sync-cwd receive gate for GitHubView instances.
 * The view only follows a CWD (it never propagates one), so the send half of
 * the resolved defaults is not read here.
 */
function GitHubViewWithSyncCwd({
  viewConfig,
  workspaceId,
  paneId,
  isFocused,
  location,
}: {
  viewConfig?: ViewInstanceConfig;
  workspaceId?: string;
  paneId?: string;
  isFocused?: boolean;
  location: TerminalLocation;
}) {
  const defaultProfile = useSettingsStore((s) => s.defaultProfile);
  const profileDefaultsSyncCwd = useSettingsStore((s) => s.profileDefaults.syncCwd);
  const syncCwdDefaults = useSettingsStore((s) => s.syncCwdDefaults);
  const githubSettings = useSettingsStore((s) => s.github);
  const fallbackId = useId();

  const configSyncGroup = (viewConfig?.syncGroup as string) ?? "";
  const effectiveSyncGroup = configSyncGroup || workspaceId || "";
  const instanceId = getInstanceId("GitHubView", paneId || fallbackId);
  const profileName = defaultProfile || FALLBACK_PROFILE;
  const profileSyncCwd = useSettingsStore(
    (s) => s.profiles.find((p) => p.name === profileName)?.syncCwd,
  );
  const resolvedDefaults = resolveSyncCwd({
    profileName,
    location,
    profileSyncCwd,
    profileDefaultsSyncCwd,
    syncCwdDefaults,
  });
  const cwdReceive = (viewConfig?.cwdReceive as boolean | undefined) ?? resolvedDefaults.receive;

  return (
    <GitHubView
      instanceId={instanceId}
      paneId={paneId}
      syncGroup={effectiveSyncGroup}
      cwdReceive={cwdReceive}
      workspaceId={workspaceId}
      isFocused={isFocused}
      defaultTab={githubSettings.defaultTab}
      refreshSeconds={githubSettings.refreshSeconds}
      hideDraftPulls={githubSettings.hideDraftPulls}
      fontFamily={githubSettings.fontFamily}
      fontSize={githubSettings.fontSize}
      numberColor={githubSettings.numberColor}
      showAuthor={githubSettings.showAuthor}
      showUpdated={githubSettings.showUpdated}
      showDraftBadge={githubSettings.showDraftBadge}
      labelMaxCount={githubSettings.labelMaxCount}
      labelMaxWidth={githubSettings.labelMaxWidth}
    />
  );
}

/** Wrapper that grabs DOM focus for views that don't manage it themselves. */
function FocusableView({
  isFocused,
  testId,
  children,
}: {
  isFocused?: boolean;
  testId: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isFocused) ref.current?.focus();
  }, [isFocused]);
  return (
    <div
      ref={ref}
      data-testid={testId}
      className="h-full"
      tabIndex={-1}
      style={{ outline: "none" }}
    >
      {children}
    </div>
  );
}

export function ViewRenderer({
  viewType,
  viewConfig,
  onSelectView,
  workspaceId,
  paneId,
  emptyViewContext,
  isFocused,
  onKeyboardActivity,
  location = "workspace",
  terminalRestartEpoch,
  terminalRestartCwd,
  terminalRestartFresh,
  onTerminalRestartConsumed,
}: ViewRendererProps) {
  const fallbackId = useId();
  switch (viewType) {
    case "WorkspaceSelectorView":
      return (
        <FocusableView testId="view-workspace-selector" isFocused={isFocused}>
          <WorkspaceSelectorView />
        </FocusableView>
      );
    case "SettingsView":
      return (
        <FocusableView testId="view-settings" isFocused={isFocused}>
          <SettingsView />
        </FocusableView>
      );
    case "TerminalView":
      return (
        <div data-testid="view-terminal" className="h-full w-full min-w-0 overflow-hidden">
          <TerminalViewWithSyncCwd
            viewConfig={viewConfig}
            workspaceId={workspaceId}
            paneId={paneId}
            isFocused={isFocused}
            onKeyboardActivity={onKeyboardActivity}
            location={location}
            terminalRestartEpoch={terminalRestartEpoch}
            terminalRestartCwd={terminalRestartCwd}
            terminalRestartFresh={terminalRestartFresh}
            onTerminalRestartConsumed={onTerminalRestartConsumed}
          />
        </div>
      );
    case "IssueReporterView":
      return (
        <FocusableView testId="view-issue-reporter" isFocused={isFocused}>
          <IssueReporterView isFocused={isFocused} />
        </FocusableView>
      );
    case "MemoView": {
      const memoKey = paneId ? `memo-${paneId}` : `memo-${fallbackId}`;
      return (
        <div data-testid="view-memo" className="h-full">
          <MemoView memoKey={memoKey} paneId={paneId ?? fallbackId} isFocused={isFocused} />
        </div>
      );
    }
    case "UsageView": {
      const configDir = typeof viewConfig?.configDir === "string" ? viewConfig.configDir : "";
      return (
        <div data-testid="view-usage" className="h-full">
          <UsageView configDir={configDir} paneId={paneId ?? fallbackId} />
        </div>
      );
    }
    case "CodexUsageView": {
      const configDir = typeof viewConfig?.configDir === "string" ? viewConfig.configDir : "";
      return (
        <div data-testid="view-codex-usage" className="h-full">
          <CodexUsageView paneId={paneId ?? fallbackId} configDir={configDir} />
        </div>
      );
    }
    case "FileExplorerView":
      return (
        <div data-testid="view-file-explorer" className="h-full">
          <FileExplorerViewWithSyncCwd
            viewConfig={viewConfig}
            workspaceId={workspaceId}
            paneId={paneId}
            isFocused={isFocused}
            location={location}
          />
        </div>
      );
    case "GitHubView":
      return (
        <div data-testid="view-github-wrapper" className="h-full">
          <GitHubViewWithSyncCwd
            viewConfig={viewConfig}
            workspaceId={workspaceId}
            paneId={paneId}
            isFocused={isFocused}
            location={location}
          />
        </div>
      );
    case "EmptyView":
    case null:
    default:
      return (
        <EmptyView onSelectView={onSelectView} context={emptyViewContext} isFocused={isFocused} />
      );
  }
}
