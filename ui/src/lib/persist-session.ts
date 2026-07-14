import { saveSettings, saveTerminalOutputCache, cleanTerminalOutputCache } from "@/lib/tauri-api";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useDockStore } from "@/stores/dock-store";
import { getTerminalSerializeMap } from "@/lib/terminal-serialize-registry";
import { collectSettingsSnapshot } from "@/lib/settings-snapshot";

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

/** When true, persistSession/saveBeforeClose skip writing settings.json (e.g. parse_error recovery). */
let persistBlocked = false;

/** Block settings persistence (e.g. when settings.json had a parse error and we don't want to overwrite it). */
export function setBlockPersist(blocked: boolean): void {
  persistBlocked = blocked;
}

/** Reset closingDown flag (for tests only). */
export function _resetClosingDown(): void {
  closingDown = false;
}

/**
 * Core implementation: gathers state from all stores and saves to settings.json.
 */
async function persistSessionCore(): Promise<void> {
  await saveSettings(await collectSettingsSnapshot());
}

/**
 * Gathers state from all stores and persists to settings.json via Tauri backend.
 * Called by workspace store save actions and other persistence triggers.
 * No-op if saveBeforeClose() is already in progress (prevents duplicate saves during teardown).
 */
export async function persistSession(): Promise<void> {
  if (closingDown || persistBlocked) return;
  await persistSessionCore();
}

/**
 * Serialize all terminal outputs and persist session state before window close.
 * Sets closingDown flag to suppress any concurrent persistSession() calls
 * that store actions might trigger during teardown.
 */
export async function saveBeforeClose(): Promise<void> {
  closingDown = true;

  // When settings had a parse error, don't overwrite the user's original file with defaults.
  // Terminal output caching is still safe — only settings.json persistence is blocked.
  if (persistBlocked) return;

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
  cachePromises.push(persistSessionCore());

  // Wait for save + persist before cleaning — otherwise clean may race and
  // delete files that are still being written.
  await Promise.allSettled(cachePromises);

  // 3. Clean orphaned cache files (safe now that saves have completed)
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
