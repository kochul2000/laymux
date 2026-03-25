import type { ViewType, ViewInstanceConfig } from "@/stores/types";
import { useSettingsStore } from "@/stores/settings-store";
import { EmptyView, type EmptyViewContext } from "./EmptyView";
import { WorkspaceSelectorView } from "./WorkspaceSelectorView";
import { TerminalView } from "./TerminalView";
import { BrowserPreviewView } from "./BrowserPreviewView";
import { SettingsView } from "./SettingsView";
import { IssueReporterView } from "./IssueReporterView";

interface ViewRendererProps {
  viewType: ViewType | null;
  viewConfig?: ViewInstanceConfig;
  onSelectView?: (config: ViewInstanceConfig) => void;
  workspaceName?: string;
  workspaceCwd?: string;
  paneId?: string;
  emptyViewContext?: EmptyViewContext;
  isFocused?: boolean;
  onKeyboardActivity?: () => void;
}

export function ViewRenderer({ viewType, viewConfig, onSelectView, workspaceName, workspaceCwd, paneId, emptyViewContext, isFocused, onKeyboardActivity }: ViewRendererProps) {
  const defaultProfile = useSettingsStore((s) => s.defaultProfile);
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
      const effectiveSyncGroup = configSyncGroup || workspaceName || "";
      const instanceId = paneId ? `terminal-${paneId}` : `terminal-fallback-${Math.random().toString(36).slice(2)}`;
      return (
        <div data-testid="view-terminal" className="h-full">
          <TerminalView
            instanceId={instanceId}
            profile={(viewConfig?.profile as string) || defaultProfile || "PowerShell"}
            syncGroup={effectiveSyncGroup}
            workspaceCwd={workspaceCwd}
            isFocused={isFocused}
            onKeyboardActivity={onKeyboardActivity}
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
    case "BrowserPreviewView":
      return (
        <div data-testid="view-browser-preview" className="h-full">
          <BrowserPreviewView
            url={(viewConfig?.url as string) ?? undefined}
          />
        </div>
      );
    case "EmptyView":
    case null:
    default:
      return <EmptyView onSelectView={onSelectView} context={emptyViewContext} isFocused={isFocused} />;
  }
}
