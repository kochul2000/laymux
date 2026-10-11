import i18n from "@/i18n";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useDockStore } from "@/stores/dock-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { toPaneId } from "./pane-ids";
import { paneNumberFor } from "./pane-numbers";
import { findLayerInWorkspaces } from "./pane-layers";

function paneLabel(terminalId: string): string {
  const paneId = toPaneId(terminalId);
  // Workspace content lives in stacked layers (ADR-0297); dock panes are content.
  const found = findLayerInWorkspaces(useWorkspaceStore.getState().workspaces, paneId);
  const workspace = found?.workspace;
  const dock = useDockStore
    .getState()
    .docks.find((item) => item.panes.some((pane) => pane.id === paneId));
  const panes = workspace?.panes ?? dock?.panes;
  if (!panes) return terminalId;
  const view = found?.entry.layer.view ?? dock?.panes.find((item) => item.id === paneId)?.view;
  const instance = useTerminalStore.getState().instances.find((item) => item.id === terminalId);
  const title = instance?.title || instance?.label || view?.profile;
  const location = workspace?.name ?? i18n.t(`codexCheckpoint.dock.${dock!.position}`);
  return [
    location,
    `pane ${paneNumberFor(panes, paneId)}`,
    typeof title === "string" ? title : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Rust preserves terminal IDs in diagnostic strings; layout labels stay UI-owned. */
export function formatCodexCheckpointError(cause: unknown): Error {
  const reason = cause instanceof Error ? cause.message : String(cause);
  const readable = reason.replace(
    /\[(terminal-[^\]\s]+)\]/g,
    (_, id: string) => `[${paneLabel(id)}]`,
  );
  return new Error(
    `${i18n.t("codexCheckpoint.failed")}\n${readable}\n${i18n.t("codexCheckpoint.retry")}`,
    { cause },
  );
}
