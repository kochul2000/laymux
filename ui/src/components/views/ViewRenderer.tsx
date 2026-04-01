import { useId } from "react";
import type { ViewType, ViewInstanceConfig } from "@/stores/types";
import { useSettingsStore, type TerminalLocation } from "@/stores/settings-store";
import { EmptyView, type EmptyViewContext } from "./EmptyView";
import { WorkspaceSelectorView } from "./WorkspaceSelectorView";
import { TerminalView } from "./TerminalView";
import { BrowserPreviewView } from "./BrowserPreviewView";
import { SettingsView } from "./SettingsView";
import { IssueReporterView } from "./IssueReporterView";
import { MemoView } from "./MemoView";

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
  const defaultProfile = useSettingsStore((s) => s.defaultProfile);
  const resolveSyncCwdForProfile = useSettingsStore((s) => s.resolveSyncCwdForProfile);
  const fallbackId = useId();
  switch (viewType) {
    case "WorkspaceSelectorView":
      return (
        <div data-testid="view-workspace-selector" className="h-full">
          <WorkspaceSelectorView />
        </div>
      );
    case "SettingsView":
      return (
        <div data-testid="view-settings" className="h-full">
          <SettingsView />
        </div>
      );
    case "TerminalView": {
      const configSyncGroup = (viewConfig?.syncGroup as string) ?? "";
      const effectiveSyncGroup = configSyncGroup || workspaceId || "";
      const instanceId = paneId ? `terminal-${paneId}` : `terminal-${fallbackId}`;
      const lastCwd = (viewConfig?.lastCwd as string) ?? undefined;
      const profileName = (viewConfig?.profile as string) || defaultProfile || "PowerShell";
      // Resolve CWD sync defaults from settings cascade; per-pane overrides take priority
      const resolvedDefaults = resolveSyncCwdForProfile(profileName, location);
      const cwdSend = (viewConfig?.cwdSend as boolean | undefined) ?? resolvedDefaults.send;
      const cwdReceive =
        (viewConfig?.cwdReceive as boolean | undefined) ?? resolvedDefaults.receive;
      return (
        <div data-testid="view-terminal" className="h-full">
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
          />
        </div>
      );
    }
    case "IssueReporterView":
      return (
        <div data-testid="view-issue-reporter" className="h-full">
          <IssueReporterView />
        </div>
      );
    case "MemoView": {
      const memoKey = paneId ? `memo-${paneId}` : `memo-${fallbackId}`;
      return (
        <div data-testid="view-memo" className="h-full">
          <MemoView memoKey={memoKey} isFocused={isFocused} />
        </div>
      );
    }
    case "BrowserPreviewView":
      return (
        <div data-testid="view-browser-preview" className="h-full">
          <BrowserPreviewView url={(viewConfig?.url as string) ?? undefined} />
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
