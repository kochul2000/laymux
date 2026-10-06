import { saveSettings, saveTerminalOutputCache, cleanTerminalOutputCache } from "@/lib/tauri-api";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useDockStore } from "@/stores/dock-store";
import type { DockPane, ViewInstanceConfig, WorkspacePane } from "@/stores/types";
import { getTerminalSerializeMap } from "@/lib/terminal-serialize-registry";
import {
  collectSessionCheckpoint,
  type CollectedSessionCheckpoint,
  type TerminalAttributionCoverage,
} from "@/lib/settings-snapshot";
import { interruptTerminalsOnExit } from "@/lib/interrupt-terminals-on-exit";
import { isSettingsWriteBlocked } from "@/lib/settings-write-guard";
import type { ProgressReporter } from "@/lib/lifecycle-progress";
import type { ExitSettings } from "@/lib/tauri-api";
import { withCodexStatusCheckpoint } from "@/lib/codex-status-probe";

export { setBlockPersist } from "@/lib/settings-write-guard";

/** Default maximum serialized terminal output size to cache (256KB). Overridden by profileDefaults.maxOutputCacheKB. */
const DEFAULT_MAX_CACHE_CHARS = 256 * 1024;

/** Get max cache chars from settings. */
function getMaxCacheChars(): number {
  const kb = useSettingsStore.getState().profileDefaults.maxOutputCacheKB;
  return kb > 0 ? kb * 1024 : DEFAULT_MAX_CACHE_CHARS;
}

/** Truncate serialized output by dropping oldest lines until it fits within maxChars. */
export function truncateFromEnd(data: string, maxChars: number): string {
  if (data.length <= maxChars) return data;
  const lines = data.split("\n");
  let total = 0;
  let startIdx = lines.length;
  for (let i = lines.length - 1; i >= 0; i--) {
    const lineLen = lines[i].length + (i < lines.length - 1 ? 1 : 0);
    if (total + lineLen > maxChars) break;
    total += lineLen;
    startIdx = i;
  }
  if (startIdx >= lines.length) return "";
  return lines.slice(startIdx).join("\n");
}

/** True once saveBeforeClose() starts — prevents duplicate persistSession() calls during teardown. */
let closingDown = false;
let preparingUpdate = false;
export function setPreparingUpdate(value: boolean): void {
  preparingUpdate = value;
}

export interface SessionCheckpointOptions {
  reason?:
    | "mutation"
    | "completion"
    | "workspaceEntry"
    | "watchdog"
    | "eviction"
    | "close"
    | "update";
  requireConclusive?: boolean;
  terminalIds?: readonly string[];
}

export interface SessionCheckpointCommit {
  checkpointCommitId: number;
  frontendMutationRevision: number;
  coverage: TerminalAttributionCoverage[];
}

const CRITICAL_OBSERVATION_SETTLE_MS = 150;
const SESSION_VIEW_FIELDS = [
  "lastCwd",
  "lastClaudeSession",
  "lastCodexSession",
  "lastGrokSession",
  "lastAgentFresh",
] as const;
let nextCheckpointCommitId = 1;
let activeCheckpoint: Promise<SessionCheckpointCommit> | null = null;
let trailingCheckpointRequested = false;
let pendingOptions: SessionCheckpointOptions = {};
let frontendMutationRevision = 0;

export function markSessionCheckpointMutation(): void {
  frontendMutationRevision += 1;
}

/** Reset closingDown flag (for tests only). */
export function _resetClosingDown(): void {
  closingDown = false;
  preparingUpdate = false;
  activeCheckpoint = null;
  trailingCheckpointRequested = false;
  pendingOptions = {};
  frontendMutationRevision = 0;
}

function mergeCheckpointOptions(
  current: SessionCheckpointOptions,
  next: SessionCheckpointOptions,
): SessionCheckpointOptions {
  const currentCritical = Boolean(current.requireConclusive);
  const nextCritical = Boolean(next.requireConclusive);
  let terminalIds: string[] | undefined;
  if (currentCritical && nextCritical) {
    // Missing/empty targets mean every live terminal. "All" dominates a
    // narrower eviction scope when an update barrier overlaps it.
    terminalIds =
      !current.terminalIds?.length || !next.terminalIds?.length
        ? undefined
        : Array.from(new Set([...current.terminalIds, ...next.terminalIds]));
  } else if (currentCritical) {
    terminalIds = current.terminalIds?.length ? [...current.terminalIds] : undefined;
  } else if (nextCritical) {
    terminalIds = next.terminalIds?.length ? [...next.terminalIds] : undefined;
  } else if (current.terminalIds || next.terminalIds) {
    terminalIds = Array.from(
      new Set([...(current.terminalIds ?? []), ...(next.terminalIds ?? [])]),
    );
  }
  return {
    reason: next.reason ?? current.reason,
    requireConclusive: currentCritical || nextCritical,
    terminalIds,
  };
}

function coverageForTargets(
  checkpoint: CollectedSessionCheckpoint,
  terminalIds?: readonly string[],
): TerminalAttributionCoverage[] {
  if (!terminalIds?.length) return checkpoint.coverage;
  const targets = new Set(terminalIds);
  return checkpoint.coverage.filter((entry) => targets.has(entry.terminalId));
}

function conclusiveFingerprint(
  checkpoint: CollectedSessionCheckpoint,
  terminalIds?: readonly string[],
): string {
  if (checkpoint.cwdLookupFailed) {
    throw new Error("Terminal CWD lookup failed");
  }
  if (checkpoint.attributionLookupFailed) {
    throw new Error("Session attribution lookup failed");
  }
  const coverage = coverageForTargets(checkpoint, terminalIds);
  const sorted = [...coverage].sort((left, right) =>
    left.terminalId.localeCompare(right.terminalId),
  );
  for (const entry of sorted) {
    if (
      entry.state !== "identified" &&
      entry.state !== "noAgent" &&
      entry.state !== "restorePending" &&
      entry.state !== "fresh"
    ) {
      throw new Error(
        `Session attribution is not conclusive for ${entry.terminalId}: ${entry.state}`,
      );
    }
  }
  return JSON.stringify(sorted);
}

async function collectStableCheckpoint(
  options: SessionCheckpointOptions,
): Promise<CollectedSessionCheckpoint> {
  const first = await collectSessionCheckpoint();
  if (!options.requireConclusive) return first;
  const firstFingerprint = conclusiveFingerprint(first, options.terminalIds);
  await new Promise((resolve) => setTimeout(resolve, CRITICAL_OBSERVATION_SETTLE_MS));
  const second = await collectSessionCheckpoint();
  const secondFingerprint = conclusiveFingerprint(second, options.terminalIds);
  if (firstFingerprint !== secondFingerprint) {
    throw new Error("Session attribution changed while establishing a destructive-action barrier");
  }
  return second;
}

async function persistSessionCore(
  options: SessionCheckpointOptions,
): Promise<SessionCheckpointCommit> {
  const collectedRevision = frontendMutationRevision;
  // Content views keyed by content id: workspace layers (ADR-0295) and dock panes.
  const sourceViews = new Map<string, ViewInstanceConfig>([
    ...useWorkspaceStore
      .getState()
      .workspaces.flatMap((workspace) => workspace.panes.flatMap((pane) => pane.layers))
      .map((layer) => [layer.id, layer.view] as const),
    ...useDockStore
      .getState()
      .docks.flatMap((dock) => dock.panes)
      .map((pane) => [pane.id, pane.view] as const),
  ]);
  const checkpoint = await collectStableCheckpoint(options);
  await saveSettings(checkpoint.settings);
  // Unknown attribution and hidden-pane remounts read these views. Publish only
  // committed metadata, otherwise a later save can resurrect startup-era IDs.
  const savedViews = new Map<string, { [key: string]: unknown }>();
  for (const workspace of checkpoint.settings.workspaces) {
    for (const pane of workspace.panes ?? []) {
      if (pane.layers?.length) {
        for (const layer of pane.layers) savedViews.set(layer.id, layer.view);
      } else if (pane.id && pane.view) {
        savedViews.set(pane.id, pane.view);
      }
    }
  }
  for (const dock of checkpoint.settings.docks ?? []) {
    for (const pane of dock.panes ?? []) savedViews.set(pane.id, pane.view);
  }
  /** The view with committed session fields published, or the same object. */
  function publishedView(id: string, view: ViewInstanceConfig): ViewInstanceConfig {
    const saved = savedViews.get(id);
    if (
      view.type !== "TerminalView" ||
      view !== sourceViews.get(id) ||
      !saved ||
      SESSION_VIEW_FIELDS.every((key) => view[key] === saved[key])
    )
      return view;
    const next: ViewInstanceConfig = { ...view };
    for (const key of SESSION_VIEW_FIELDS) {
      if (saved[key] === undefined) delete next[key];
      else next[key] = saved[key];
    }
    return next;
  }
  function updateSlot(pane: WorkspacePane): WorkspacePane {
    const layers = pane.layers.map((layer) => {
      const view = publishedView(layer.id, layer.view);
      return view === layer.view ? layer : { ...layer, view };
    });
    return layers.every((layer, index) => layer === pane.layers[index])
      ? pane
      : { ...pane, layers };
  }
  function updateDockPane(pane: DockPane): DockPane {
    const view = publishedView(pane.id, pane.view);
    return view === pane.view ? pane : { ...pane, view };
  }
  function updateGroups<P, T extends { panes: P[] }>(groups: T[], update: (pane: P) => P): T[] {
    const updated = groups.map((group) => {
      const panes = group.panes.map(update);
      return panes.every((pane, index) => pane === group.panes[index])
        ? group
        : { ...group, panes };
    });
    return updated.every((group, index) => group === groups[index]) ? groups : updated;
  }
  const revisionBeforePublication = frontendMutationRevision;
  useWorkspaceStore.setState((state) => {
    const workspaces = updateGroups(state.workspaces, updateSlot);
    return workspaces === state.workspaces ? state : { workspaces };
  });
  useDockStore.setState((state) => {
    const docks = updateGroups(state.docks, updateDockPane);
    return docks === state.docks ? state : { docks };
  });
  // These synchronous notifications publish metadata already saved above.
  // Count them in this commit so slow probes do not run twice at close. Any
  // mutation during collection/save still differs and requires a trailing pass.
  const publicationRevision = frontendMutationRevision - revisionBeforePublication;
  return {
    checkpointCommitId: nextCheckpointCommitId++,
    frontendMutationRevision: collectedRevision + publicationRevision,
    coverage: checkpoint.coverage,
  };
}

async function runCheckpointCoordinator(): Promise<SessionCheckpointCommit> {
  let commit: SessionCheckpointCommit | undefined;
  do {
    trailingCheckpointRequested = false;
    const options = pendingOptions;
    pendingOptions = {};
    commit = await persistSessionCore(options);
    if (commit.frontendMutationRevision !== frontendMutationRevision) {
      trailingCheckpointRequested = true;
    }
    // A normal trigger arriving behind a destructive barrier must not weaken
    // the trailing pass that every waiter ultimately observes.
    if (trailingCheckpointRequested) {
      pendingOptions = mergeCheckpointOptions(pendingOptions, options);
    }
  } while (trailingCheckpointRequested);
  return commit;
}

/** Coalesce overlap into one in-flight write plus one trailing checkpoint. */
export function flushSessionCheckpoint(
  options: SessionCheckpointOptions = {},
): Promise<SessionCheckpointCommit> {
  // Native watchdog/update/eviction requests bypass persistSession(). Once
  // closing starts, only the pre-interrupt close checkpoint may collect state.
  if (
    (preparingUpdate && options.reason !== "update") ||
    (closingDown && options.reason !== "close")
  ) {
    return Promise.reject(new Error("Window close is in progress"));
  }
  if (isSettingsWriteBlocked()) {
    return Promise.reject(
      new Error("Settings persistence is blocked until recovery is acknowledged"),
    );
  }
  pendingOptions = mergeCheckpointOptions(pendingOptions, options);
  if (activeCheckpoint) {
    trailingCheckpointRequested = true;
    return activeCheckpoint;
  }
  activeCheckpoint = runCheckpointCoordinator().finally(() => {
    activeCheckpoint = null;
  });
  return activeCheckpoint;
}

/**
 * Gathers state from all stores and persists to settings.json via Tauri backend.
 * Called by workspace store save actions and other persistence triggers.
 * No-op if saveBeforeClose() is already in progress (prevents duplicate saves during teardown).
 */
export function persistSession(options: SessionCheckpointOptions = {}): Promise<void> {
  if (closingDown || preparingUpdate || isSettingsWriteBlocked()) return Promise.resolve();
  const pending = flushSessionCheckpoint(options).then(() => {});
  // Background hints may join a failing critical barrier. Handle their rejected
  // promise while preserving the rejection for callers that explicitly await it.
  void pending.catch((error: unknown) => {
    console.warn("[session-checkpoint] Failed to persist session:", error);
  });
  return pending;
}

/**
 * Serialize all terminal outputs and persist session state before window close.
 * Sets closingDown flag to suppress any concurrent persistSession() calls
 * that store actions might trigger during teardown.
 */
export async function saveBeforeClose(report?: ProgressReporter): Promise<void> {
  closingDown = true;
  await report?.({ stage: "checkpoint", completed: 0, total: null });
  const codex = useSettingsStore.getState().codex;
  const verifyStatus =
    !isSettingsWriteBlocked() && codex.restoreSession && codex.verifySessionOnExit;
  try {
    await withCodexStatusCheckpoint(verifyStatus, undefined, async () => {
      // The status proof remains fenced through the final save. Ctrl+C, if
      // enabled separately, still follows the committed restoration point.
      if (!isSettingsWriteBlocked())
        await flushSessionCheckpoint({ reason: "close", requireConclusive: verifyStatus });
      await prepareTerminalExit(report);
    });
  } catch (error) {
    closingDown = false;
    throw error;
  }
}

/** Shared post-checkpoint preparation; never recollect attribution after Ctrl+C. */
export async function prepareTerminalExit(
  report?: ProgressReporter,
  exit?: Partial<ExitSettings>,
): Promise<void> {
  await interruptTerminalsOnExit(report, exit);
  await report?.({ stage: "caching", completed: 0, total: null });

  // When settings had a parse error, don't overwrite the user's original file with defaults.
  // Terminal output caching is still safe — only settings.json persistence is blocked.
  if (isSettingsWriteBlocked()) return;

  const wsState = useWorkspaceStore.getState();
  const dockState = useDockStore.getState();

  // 1. Serialize and cache terminal outputs
  const serializeMap = getTerminalSerializeMap();
  const cachePromises: Promise<void>[] = [];
  let completed = 0;
  let serializationFailed = false;
  for (const [paneId, serializeFn] of serializeMap.entries()) {
    try {
      let data = serializeFn();
      if (!data || data.length === 0) {
        completed++;
        continue;
      }
      const maxChars = getMaxCacheChars();
      if (data.length > maxChars) {
        data = truncateFromEnd(data, maxChars);
      }
      if (data.length > 0) {
        cachePromises.push(
          saveTerminalOutputCache(paneId, data).then(async () => {
            completed++;
            await report?.({ stage: "caching", completed, total: serializeMap.size });
          }),
        );
      } else {
        completed++;
      }
    } catch (err) {
      serializationFailed = true;
      console.warn(`[saveBeforeClose] Failed to serialize pane ${paneId}:`, err);
    }
  }

  // Wait for cache writes before cleaning — otherwise clean may race and
  // delete files that are still being written.
  const results = await Promise.allSettled(cachePromises);
  if (report && (serializationFailed || results.some((result) => result.status === "rejected"))) {
    throw new Error(
      "Terminal history could not be saved. Tasks may already have been interrupted.",
    );
  }
  await report?.({ stage: "caching", completed, total: serializeMap.size });

  // Clean orphaned cache files after all cache writes have completed.
  const activePaneIds: string[] = [];
  // Output caches belong to content: every stacked layer keeps its own (ADR-0295).
  for (const ws of wsState.workspaces) {
    for (const p of ws.panes)
      for (const layer of p.layers) if (layer.id) activePaneIds.push(layer.id);
  }
  for (const d of dockState.docks) {
    for (const p of d.panes) if (p.id) activePaneIds.push(p.id);
  }
  try {
    await cleanTerminalOutputCache(activePaneIds);
  } catch (err) {
    console.warn("[saveBeforeClose] Failed to clean orphaned cache:", err);
  }
}
