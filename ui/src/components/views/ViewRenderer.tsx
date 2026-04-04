import { useId, useRef, useEffect } from "react";
import type { ViewType, ViewInstanceConfig } from "@/stores/types";
import { useSettingsStore, FALLBACK_PROFILE, type TerminalLocation } from "@/stores/settings-store";
import { resolveSyncCwd } from "@/lib/sync-cwd-config";
import { EmptyView, type EmptyViewContext } from "./EmptyView";
import { WorkspaceSelectorView } from "./WorkspaceSelectorView";
import { TerminalView } from "./TerminalView";
import { SettingsView } from "./SettingsView";
import { IssueReporterView } from "./IssueReporterView";
import { MemoView } from "./MemoView";
import { ExplorerView } from "./ExplorerView";

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
}

/** Wrapper that subscribes to sync-cwd settings only for TerminalView instances. */
function TerminalViewWithSyncCwd({
  viewConfig,
  workspaceId,
  paneId,
  isFocused,
  onKeyboardActivity,
  location,
}: {
  viewConfig?: ViewInstanceConfig;
  workspaceId?: string;
  paneId?: string;
  isFocused?: boolean;
  onKeyboardActivity?: () => void;
  location: TerminalLocation;
}) {
  const defaultProfile = useSettingsStore((s) => s.defaultProfile);
  const profileDefaultsSyncCwd = useSettingsStore((s) => s.profileDefaults.syncCwd);
  const syncCwdDefaults = useSettingsStore((s) => s.syncCwdDefaults);
  const fallbackId = useId();

  const configSyncGroup = (viewConfig?.syncGroup as string) ?? "";
  const effectiveSyncGroup = configSyncGroup || workspaceId || "";
  const instanceId = paneId ? `terminal-${paneId}` : `terminal-${fallbackId}`;
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
    />
  );
}

/** Wrapper that subscribes to sync-cwd settings for ExplorerView instances. */
function ExplorerViewWithSyncCwd({
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
  const explorerSettings = useSettingsStore((s) => s.explorer);
  const fallbackId = useId();

  const configSyncGroup = (viewConfig?.syncGroup as string) ?? "";
  const effectiveSyncGroup = configSyncGroup || workspaceId || "";
  const instanceId = paneId ? `explorer-${paneId}` : `explorer-${fallbackId}`;
  const lastCwd = (viewConfig?.lastCwd as string) ?? undefined;

  // Use file explorer's shellProfile setting, or fall back to defaultProfile
  const profileName = explorerSettings.shellProfile || defaultProfile || FALLBACK_PROFILE;
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
    <ExplorerView
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
        <div data-testid="view-terminal" className="h-full">
          <TerminalViewWithSyncCwd
            viewConfig={viewConfig}
            workspaceId={workspaceId}
            paneId={paneId}
            isFocused={isFocused}
            onKeyboardActivity={onKeyboardActivity}
            location={location}
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
          <MemoView memoKey={memoKey} isFocused={isFocused} />
        </div>
      );
    }
    case "ExplorerView":
      return (
        <div data-testid="view-explorer" className="h-full">
          <ExplorerViewWithSyncCwd
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
