import { useTranslation } from "react-i18next";
import { useTerminalStore } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGridStore } from "@/stores/grid-store";
import { useDockStore } from "@/stores/dock-store";
import { resolveFocusedTerminalCwd } from "@/lib/focused-terminal";
import { abbreviatePath } from "@/lib/workspace-summary";
import { clipboardWriteText } from "@/lib/tauri-api";
import { WidgetChrome } from "./WidgetChrome";
import type { WidgetComponentProps } from "./types";
import { CWD_WIDGET_WIDTH } from "./widget-options";

/**
 * The focused terminal's working directory.
 *
 * Reads the CWD the SyncGroup already tracks rather than asking a shell
 * (ADR-0003); with no focused terminal there is nothing to show, and the widget
 * says so instead of showing another pane's path.
 */
export function CwdWidget({ instance }: WidgetComponentProps) {
  const { t } = useTranslation("settings");
  const terminals = useTerminalStore((state) => state.instances);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const focusedPaneIndex = useGridStore((state) => state.focusedPaneIndex);
  const docks = useDockStore((state) => state.docks);
  const focusedDock = useDockStore((state) => state.focusedDock);
  const focusedDockPaneId = useDockStore((state) => state.focusedDockPaneId);
  const cwd = resolveFocusedTerminalCwd({
    terminals,
    workspaces,
    activeWorkspaceId,
    focusedPaneIndex,
    docks,
    focusedDock,
    focusedDockPaneId,
  });

  return (
    <WidgetChrome
      testId={`widget-cwd-${instance.id}`}
      title={cwd ? `${cwd}\n${t("widgets.cwdCopyHint")}` : t("widgets.cwdNone")}
      onClick={cwd ? () => void clipboardWriteText(cwd).catch(() => {}) : undefined}
    >
      <span className="truncate" style={{ maxWidth: CWD_WIDGET_WIDTH }}>
        {cwd ? abbreviatePath(cwd) : "—"}
      </span>
    </WidgetChrome>
  );
}
