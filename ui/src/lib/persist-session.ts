import { saveSettings, saveTerminalOutputCache, cleanTerminalOutputCache } from "@/lib/tauri-api";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useDockStore } from "@/stores/dock-store";
import { getTerminalSerializeMap } from "@/lib/terminal-serialize-registry";
import {
  collectSessionCheckpoint,
  type CollectedSessionCheckpoint,
  type TerminalAttributionCoverage,
} from "@/lib/settings-snapshot";
import { interruptTerminalsOnExit } from "@/lib/interrupt-terminals-on-exit";
import { isSettingsWriteBlocked } from "@/lib/settings-write-guard";

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
  if (checkpoint.attributionLookupFailed) {
    throw new Error("Session attribution lookup failed");
  }
  const coverage = coverageForTargets(checkpoint, terminalIds);
  const sorted = [...coverage].sort((left, right) =>
    left.terminalId.localeCompare(right.terminalId),
  );
  for (const entry of sorted) {
    if (entry.state !== "identified" && entry.state !== "noAgent") {
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
  const checkpoint = await collectStableCheckpoint(options);
  await saveSettings(checkpoint.settings);
  return {
    checkpointCommitId: nextCheckpointCommitId++,
    frontendMutationRevision: collectedRevision,
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
export async function persistSession(options: SessionCheckpointOptions = {}): Promise<void> {
  if (closingDown || isSettingsWriteBlocked()) return;
  await flushSessionCheckpoint(options);
}

/**
 * Serialize all terminal outputs and persist session state before window close.
 * Sets closingDown flag to suppress any concurrent persistSession() calls
 * that store actions might trigger during teardown.
 */
export async function saveBeforeClose(): Promise<void> {
  closingDown = true;

  // Drain any older write and commit the final attribution before Ctrl+C can
  // return an agent to the shell and erase the process evidence.
  if (!isSettingsWriteBlocked()) {
    await flushSessionCheckpoint({ reason: "close" });
  }

  // Kill-on-exit (issue #451): before serializing scrollback, send Ctrl+C to
  // running terminals so cron/agents wind down and Claude/Codex print their
  // resume session id. This must run before the serialize loop below so the
  // printed id lands in the cached scrollback. Opt-in; no-op when disabled.
  await interruptTerminalsOnExit();

  // When settings had a parse error, don't overwrite the user's original file with defaults.
  // Terminal output caching is still safe — only settings.json persistence is blocked.
  if (isSettingsWriteBlocked()) return;

  const wsState = useWorkspaceStore.getState();
  const dockState = useDockStore.getState();

  // 1. Serialize and cache terminal outputs
  const serializeMap = getTerminalSerializeMap();
  const cachePromises: Promise<void>[] = [];
  for (const [paneId, serializeFn] of serializeMap.entries()) {
    try {
      let data = serializeFn();
      if (!data || data.length === 0) continue;
      const maxChars = getMaxCacheChars();
      if (data.length > maxChars) {
        data = truncateFromEnd(data, maxChars);
      }
      if (data.length > 0) {
        cachePromises.push(saveTerminalOutputCache(paneId, data));
      }
    } catch (err) {
      console.warn(`[saveBeforeClose] Failed to serialize pane ${paneId}:`, err);
    }
  }

  // 2. Persist session directly (bypasses closingDown guard)
  // Wait for cache writes before cleaning — otherwise clean may race and
  // delete files that are still being written.
  await Promise.allSettled(cachePromises);

  // Clean orphaned cache files after all cache writes have completed.
  const activePaneIds: string[] = [];
  for (const ws of wsState.workspaces) {
    for (const p of ws.panes) if (p.id) activePaneIds.push(p.id);
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
