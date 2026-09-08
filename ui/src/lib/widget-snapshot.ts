/**
 * The display models the remote client draws its widget strip from (ADR-0124).
 *
 * The remote page shares no code with the desktop widgets — it is vanilla JS in
 * `remote_server/page.html` — so anything it had to compute for itself would be
 * a second implementation of row selection, colours and failure wording, and the
 * same account would read differently in a browser than on the desktop. This
 * module is where that stops: the desktop owns every value, the remote owns only
 * the drawing.
 *
 * Two rules follow from "the remote mirrors the desktop", and both live here:
 * a widget the desktop is not drawing (status line off, unknown type) produces
 * no item, and reading a snapshot never registers probe demand — the desktop
 * widget being mounted is the demand (ADR-0102, ADR-0104).
 */

import i18n from "i18next";

import {
  getGrokUsageSnapshot,
  getUsageSnapshot,
  type GrokUsageSnapshot,
  type UsageSnapshot,
} from "@/lib/tauri-api";
import { readCodexSnapshot } from "@/lib/codex-usage-subscription";
import {
  buildClaudeUsageRows,
  buildCodexUsageRows,
  buildGrokUsageRows,
  selectVisibleRows,
  usageRowStatuslineText,
  usageWidgetTooltip,
  type UsageDisplayRow,
} from "@/lib/usage-rows";
import {
  claudeUsageStatusMessage,
  codexUsageStatusMessage,
  grokUsageStatusMessage,
} from "@/lib/usage-status";
import { isTerminalWorking } from "@/lib/terminal-working";
import { resolveFocusedTerminalCwd } from "@/lib/focused-terminal";
import { abbreviatePath } from "@/lib/workspace-summary";
import {
  readWidgetFontSize,
  type WidgetInstance,
  type WidgetsSettings,
} from "@/lib/widget-placement";
import {
  readBarHeight,
  readBarWidth,
  readDisplay,
  readElapsedHeight,
  readTerminalActivityScope,
  type UsageWidgetDisplay,
} from "@/components/widgets/widget-options";
import { useNotificationStore } from "@/stores/notification-store";
import { useSettingsStore, type UsageColorSettings } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useGridStore } from "@/stores/grid-store";
import { useDockStore } from "@/stores/dock-store";

/** Which end of the strip an item sticks to. The desktop's two surfaces both fold into one line. */
export type RemoteWidgetAlign = "left" | "right";

interface RemoteWidgetBase {
  id: string;
  /** Registry type, carried so the remote can label an item without guessing from `kind`. */
  type: string;
  align: RemoteWidgetAlign;
  /** Hover text, identical to the desktop tooltip. */
  title: string;
}

export interface RemoteUsageRow {
  key: string;
  /** Already-formatted `Session 42%`; the remote never composes this itself. */
  text: string;
  percent: number | null;
  elapsed: number | null;
}

/**
 * `kind` is what the remote switches on, and it is deliberately coarser than
 * `type`: a new widget that maps onto an existing kind needs no remote change.
 */
export type RemoteWidgetItem =
  | (RemoteWidgetBase & {
      kind: "usage";
      label: string;
      display: UsageWidgetDisplay;
      /** Non-null whenever the numbers are not usable — never replaced by the last good ones. */
      unavailable: string | null;
      rows: RemoteUsageRow[];
      colors: UsageColorSettings;
      barWidth: number;
      barHeight: number;
      elapsedHeight: number;
    })
  | (RemoteWidgetBase & { kind: "activity"; busy: number; total: number })
  | (RemoteWidgetBase & { kind: "notifications"; unread: number })
  | (RemoteWidgetBase & { kind: "text"; text: string; copyText: string | null });

export interface RemoteWidgetSnapshot {
  /** Empty means "inherit the interface font", same as on the desktop. */
  fontFamily: string;
  fontSize: number;
  items: RemoteWidgetItem[];
}

function t(key: string, params?: Record<string, unknown>): string {
  return i18n.t(key, { ns: "settings", ...params });
}

/**
 * Placements in the order the strip draws them.
 *
 * The two surfaces collapse into left and right only; a status line the desktop
 * is not showing contributes nothing, because the remote never revives a widget
 * the desktop skipped.
 */
function placements(
  widgets: WidgetsSettings,
): { instance: WidgetInstance; align: RemoteWidgetAlign }[] {
  const statusLine = widgets.statusLine.enabled
    ? { left: widgets.statusLine.left, right: widgets.statusLine.right }
    : { left: [], right: [] };

  return [
    ...[...widgets.topBar.left, ...statusLine.left].map((instance) => ({
      instance,
      align: "left" as const,
    })),
    ...[...widgets.topBar.right, ...statusLine.right].map((instance) => ({
      instance,
      align: "right" as const,
    })),
  ];
}

function usageItem({
  instance,
  align,
  label,
  rows,
  message,
  capturedAtMs,
  colors,
  configDir,
}: {
  instance: WidgetInstance;
  align: RemoteWidgetAlign;
  label: string;
  rows: UsageDisplayRow[];
  message: string | null;
  capturedAtMs: number | null;
  colors: UsageColorSettings;
  configDir?: string;
}): RemoteWidgetItem {
  return {
    id: instance.id,
    type: instance.type,
    align,
    kind: "usage",
    title: usageWidgetTooltip({ label, configDir, message, rows, capturedAtMs }),
    label,
    display: readDisplay(instance.options),
    unavailable: message,
    rows: rows.map((row) => ({
      key: row.key,
      text: usageRowStatuslineText(row),
      percent: row.percent,
      elapsed: row.elapsed,
    })),
    colors,
    barWidth: readBarWidth(instance.options),
    barHeight: readBarHeight(instance.options),
    elapsedHeight: readElapsedHeight(instance.options),
  };
}

/**
 * Claude snapshots, one read per distinct config dir.
 *
 * `get_usage_snapshot` reports what a probe last captured and never starts one,
 * which is exactly the read a mirror is allowed to make.
 */
async function claudeSnapshots(configDirs: readonly string[]): Promise<Map<string, UsageSnapshot>> {
  const unique = [...new Set(configDirs)];
  const entries = await Promise.all(
    unique.map(async (configDir): Promise<[string, UsageSnapshot] | null> => {
      try {
        return [configDir, await getUsageSnapshot(configDir)];
      } catch {
        // A failed read is not a stale number: the widget falls back to the
        // probe-stopped wording below rather than showing an old capture.
        return null;
      }
    }),
  );
  return new Map(entries.filter((entry): entry is [string, UsageSnapshot] => entry !== null));
}

function claudeConfigDir(instance: WidgetInstance): string {
  return typeof instance.options.configDir === "string" ? instance.options.configDir : "";
}

async function grokSnapshots(
  configDirs: readonly string[],
): Promise<Map<string, GrokUsageSnapshot>> {
  const unique = [...new Set(configDirs)];
  const entries = await Promise.all(
    unique.map(async (configDir): Promise<[string, GrokUsageSnapshot] | null> => {
      try {
        return [configDir, await getGrokUsageSnapshot(configDir)];
      } catch {
        return null;
      }
    }),
  );
  return new Map(entries.filter((entry): entry is [string, GrokUsageSnapshot] => entry !== null));
}

/**
 * Everything the remote strip needs, resolved against the desktop's own state.
 *
 * `now` is a parameter because elapsed percentages are derived from it and a
 * test that cannot fix the clock cannot assert on them.
 */
export async function buildRemoteWidgetSnapshot(
  now: Date = new Date(),
): Promise<RemoteWidgetSnapshot> {
  const settings = useSettingsStore.getState();
  const widgets = settings.widgets;
  const placed = placements(widgets);

  const snapshots = await claudeSnapshots(
    placed
      .filter((placement) => placement.instance.type === "claudeUsage")
      .map((placement) => claudeConfigDir(placement.instance)),
  );
  const grokSnaps = await grokSnapshots(
    placed
      .filter((placement) => placement.instance.type === "grokUsage")
      .map((placement) => claudeConfigDir(placement.instance)),
  );

  const terminals = useTerminalStore.getState().instances;
  const workspaceState = useWorkspaceStore.getState();
  const activeWorkspaceId = workspaceState.activeWorkspaceId;
  const gridState = useGridStore.getState();
  const dockState = useDockStore.getState();
  const unread = useNotificationStore
    .getState()
    .notifications.filter((notification) => notification.readAt === null).length;
  const cwd = resolveFocusedTerminalCwd({
    terminals,
    workspaces: workspaceState.workspaces,
    activeWorkspaceId,
    focusedPaneIndex: gridState.focusedPaneIndex,
    docks: dockState.docks,
    focusedDock: dockState.focusedDock,
    focusedDockPaneId: dockState.focusedDockPaneId,
  });

  const items = placed.flatMap(({ instance, align }): RemoteWidgetItem[] => {
    switch (instance.type) {
      case "claudeUsage": {
        const configDir = claudeConfigDir(instance);
        const snapshot = snapshots.get(configDir);
        const rows = snapshot
          ? selectVisibleRows(
              buildClaudeUsageRows(snapshot, now),
              settings.usage.claude.visibleRows,
            )
          : [];
        return [
          usageItem({
            instance,
            align,
            label: "Claude",
            rows,
            message: snapshot ? claudeUsageStatusMessage(snapshot.status) : "Probe stopped",
            capturedAtMs: snapshot?.capturedAtMs ?? null,
            colors: settings.usage.claude.colors,
            configDir,
          }),
        ];
      }
      case "grokUsage": {
        const configDir = claudeConfigDir(instance);
        const snapshot = grokSnaps.get(configDir);
        const rows = snapshot
          ? selectVisibleRows(
              buildGrokUsageRows(snapshot.rows, now),
              settings.usage.grok.visibleRows,
            )
          : [];
        return [
          usageItem({
            instance,
            align,
            label: "Grok",
            rows,
            message: snapshot ? grokUsageStatusMessage(snapshot.status) : "Probe stopped",
            capturedAtMs: snapshot?.capturedAtMs ?? null,
            colors: settings.usage.grok.colors,
            configDir,
          }),
        ];
      }
      case "codexUsage": {
        const snapshot = readCodexSnapshot("");
        return [
          usageItem({
            instance,
            align,
            label: "Codex",
            rows: selectVisibleRows(
              buildCodexUsageRows(snapshot.limits, now),
              settings.usage.codex.visibleRows,
            ),
            message: codexUsageStatusMessage(snapshot.status),
            capturedAtMs: snapshot.capturedAtMs,
            colors: settings.usage.codex.colors,
          }),
        ];
      }
      case "terminalActivity": {
        const scope = readTerminalActivityScope(instance.options);
        const counted =
          scope === "all"
            ? terminals
            : terminals.filter((terminal) => terminal.workspaceId === activeWorkspaceId);
        const busy = counted.filter(isTerminalWorking).length;
        return [
          {
            id: instance.id,
            type: instance.type,
            align,
            kind: "activity",
            title: t(
              scope === "all" ? "widgets.activityBusyAll" : "widgets.activityBusyWorkspace",
              { busy, total: counted.length },
            ),
            busy,
            total: counted.length,
          },
        ];
      }
      case "notifications":
        return [
          {
            id: instance.id,
            type: instance.type,
            align,
            kind: "notifications",
            title:
              unread === 0
                ? t("widgets.notificationsNone")
                : t("widgets.notificationsUnread", { num: unread }),
            unread,
          },
        ];
      case "cwd":
        return [
          {
            id: instance.id,
            type: instance.type,
            align,
            kind: "text",
            title: cwd ? `${cwd}\n${t("widgets.cwdCopyHint")}` : t("widgets.cwdNone"),
            text: cwd ? abbreviatePath(cwd) : "—",
            copyText: cwd ?? null,
          },
        ];
      // An unregistered type renders nowhere on the desktop, so it has no
      // display model to mirror. The placement itself stays in settings.
      default:
        return [];
    }
  });

  return {
    fontFamily: widgets.fontFamily,
    fontSize: readWidgetFontSize(widgets.fontSize),
    items,
  };
}
