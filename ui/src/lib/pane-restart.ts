import i18n from "@/i18n";
import { useNotificationStore } from "@/stores/notification-store";
import { useTerminalRestartStore } from "@/stores/terminal-restart-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { findTerminalPane } from "./pane-clear";
import { resolvePaneCwd } from "./pane-cwd";
import { toTerminalId } from "./pane-ids";
import { flushSessionCheckpoint } from "./persist-session";

const pendingRestarts = new Map<string, Promise<boolean>>();

/** Restart View uses the same committed session metadata as app startup. */
export function restartPaneView(paneId: string): Promise<boolean> {
  const pending = pendingRestarts.get(paneId);
  if (pending) return pending;
  const terminalId = toTerminalId(paneId);
  const instance = () =>
    useTerminalStore.getState().instances.find((item) => item.id === terminalId);
  const before = instance();
  const pane = findTerminalPane(paneId);
  if (!pane) return Promise.resolve(false);

  const result = (async () => {
    const live = before && before.sessionReady !== false;
    if (live) {
      // This publishes the DB's committed last*Session fields into the view
      // before the epoch can unmount the old PTY. Unknown must keep it alive.
      const commit = await flushSessionCheckpoint({
        requireConclusive: true,
        terminalIds: [terminalId],
      });
      const target = commit.coverage.find((entry) => entry.terminalId === terminalId);
      if (!target || commit.unresolvedTerminalIds?.includes(terminalId)) {
        throw new Error("Session checkpoint is not conclusive");
      }
      if (before.generation !== undefined && target.generation !== before.generation) return false;
    }
    const currentPane = findTerminalPane(paneId);
    const current = instance();
    if (
      !currentPane ||
      currentPane.view.profile !== pane.view.profile ||
      current?.generation !== before?.generation ||
      current?.sessionReady !== before?.sessionReady ||
      (!current && before)
    )
      return false;

    useTerminalRestartStore.getState().requestRestart(paneId, resolvePaneCwd(currentPane), !!live);
    return true;
  })()
    .catch((error: unknown) => {
      console.warn(`[pane restart] ${paneId}:`, error);
      useNotificationStore.getState().addNotification({
        terminalId,
        workspaceId: before?.workspaceId ?? "",
        level: "error",
        message: i18n.t("paneRestartFailed", { ns: "common" }),
      });
      return false;
    })
    .finally(() => {
      pendingRestarts.delete(paneId);
    });
  pendingRestarts.set(paneId, result);
  return result;
}
