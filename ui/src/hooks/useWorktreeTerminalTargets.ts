import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { useGridStore } from "@/stores/grid-store";
import { useTerminalStore, type TerminalInstance } from "@/stores/terminal-store";
import { useTerminalDisplayStore } from "@/stores/terminal-display-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";
import { sortWorkspaces } from "@/lib/workspace-sort";
import {
  computeWorkspaceSummary,
  formatActivity,
  projectWorkspaceTerminals,
} from "@/lib/workspace-summary";
import { projectTerminalDisplay } from "@/lib/terminal-display-context";
import { paneNumberFor } from "@/lib/pane-numbers";
import type { WorktreeUsage } from "@/lib/worktree-api";

/** 기존 selector의 정렬·표시 모델을 사용한다. usage 순서는 이동 대상의 순서다. */
export function useWorktreeTerminalTargets(usage: WorktreeUsage[]) {
  const terminals = useTerminalStore((s) => s.instances);
  const contexts = useTerminalDisplayStore((s) => s.contexts);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const displayOrder = useWorkspaceStore((s) => s.workspaceDisplayOrder);
  const sortOrder = useSettingsStore((s) => s.workspaceSelector.sortOrder);
  const notifications = useNotificationStore((s) => s.notifications);
  const hiddenIds = useUiStore((s) => s.hiddenWorkspaceIds);
  const docks = useDockStore((s) => s.docks);
  const focusedDockPaneId = useDockStore((s) => s.focusedDockPaneId);
  const focusedPaneIndex = useGridStore((s) => s.focusedPaneIndex);
  const visibleWorkspaces = sortWorkspaces(
    workspaces,
    sortOrder,
    displayOrder,
    notifications,
  ).filter((ws) => ws.id === activeWorkspaceId || !hiddenIds.has(ws.id));

  return usage.map((value) => {
    const workspace = workspaces.find((ws) =>
      ws.panes.some((slot) => slot.layers.some((layer) => layer.id === value.paneId)),
    );
    const dock = docks.find((d) => d.panes.some((pane) => pane.id === value.paneId));
    const slotIndex =
      workspace?.panes.findIndex((slot) =>
        slot.layers.some((layer) => layer.id === value.paneId),
      ) ?? -1;
    const slot = workspace?.panes[slotIndex];
    const layer = slot?.layers.find((layer) => layer.id === value.paneId);
    const dockPane = dock?.panes.find((pane) => pane.id === value.paneId);
    const live = terminals.find((terminal) => terminal.id === value.terminalId);
    const projected =
      workspace &&
      projectWorkspaceTerminals(workspace.id, workspace.panes, terminals, contexts).find(
        (terminal) => terminal.id === value.terminalId,
      );
    const profile = (layer?.view.profile ?? dockPane?.view.profile) as string | undefined;
    const fallback: TerminalInstance = {
      id: value.terminalId ?? "",
      profile: profile ?? "",
      label: profile || "Terminal",
      syncGroup: value.workspaceId ?? "",
      workspaceId: value.workspaceId ?? "",
      cwd: value.cwd,
      lastActivityAt: 0,
      isFocused: false,
      ...live,
    };
    const terminal = projected || projectTerminalDisplay(fallback, contexts[fallback.id]);
    const agentName = value.agentType
      ? ({ claude: "Claude", codex: "Codex", grok: "Grok" } as Record<string, string>)[
          value.agentType.toLowerCase()
        ] || value.agentType
      : null;
    // 현재 selector의 표시가 우선이며, pane 정보가 아직 없을 때만 backend 식별을 쓴다.
    const activity =
      terminal.activity ??
      (agentName ? { type: "interactiveApp" as const, name: agentName } : undefined);
    const summary = computeWorkspaceSummary(
      terminal.workspaceId,
      [{ ...terminal, activity }],
      new Map(),
      notifications,
    ).terminalSummaries[0];
    const kind = live?.sessionReady ? "live" : value.kind;
    const availability = kind === "saved" ? "저장된 세션" : kind === "daemon" ? "백그라운드" : "";
    const name =
      workspace?.name ||
      value.workspaceName ||
      (dock ? `${dock.position} dock` : availability || "위치 미확인");
    const panes = workspace?.panes ?? dock?.panes ?? [];
    const number = value.paneId ? paneNumberFor(panes, value.paneId) : null;
    const isActive = workspace?.id === activeWorkspaceId;
    return {
      value,
      name,
      index: visibleWorkspaces.findIndex((ws) => ws.id === workspace?.id),
      terminal: summary,
      panes,
      paneIndex: workspace
        ? slotIndex
        : (dock?.panes.findIndex((pane) => pane.id === value.paneId) ?? -1),
      isFocusedPane: workspace
        ? isActive && focusedPaneIndex === slotIndex && slot?.activeLayerId === value.paneId
        : !!value.paneId && focusedDockPaneId === value.paneId,
      title: [
        name,
        number ? `pane ${number}` : null,
        formatActivity(activity).label,
        availability,
        value.paneId ? value.cwd : "이동할 pane이 없는 터미널입니다",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
}
