/**
 * One Codex rate-limit poller per account, shared by every surface showing it.
 *
 * Codex has no backend subscription: each read spawns a short-lived
 * `codex app-server` ([ADR-0104]). Polling per component would therefore spawn
 * one process per view *and* leave each surface on its own phase, so a widget
 * and a UsageView of the same account would show numbers captured at different
 * times — the state [ADR-0105] rules out. This module keeps a single interval
 * and a single snapshot per config dir, refcounted by its subscribers.
 *
 * [ADR-0104]: ../../../docs/adr/0104-codex-usage-app-server-probe.md
 * [ADR-0105]: ../../../docs/adr/0105-widget-slots-and-status-line.md
 */

import { getCodexUsageSnapshot, type CodexUsageSnapshot } from "@/lib/tauri-api";

export const CODEX_PENDING_SNAPSHOT: CodexUsageSnapshot = {
  status: { type: "failed", message: "Starting Codex usage reader" },
  limits: [],
  plan: null,
  capturedAtMs: null,
};

interface Entry {
  snapshot: CodexUsageSnapshot;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  intervalMs: number;
}

const entries = new Map<string, Entry>();

function entryFor(configDir: string): Entry {
  let entry = entries.get(configDir);
  if (!entry) {
    entry = { snapshot: CODEX_PENDING_SNAPSHOT, listeners: new Set(), timer: null, intervalMs: 0 };
    entries.set(configDir, entry);
  }
  return entry;
}

function publish(entry: Entry, snapshot: CodexUsageSnapshot): void {
  entry.snapshot = snapshot;
  entry.listeners.forEach((listener) => listener());
}

export function readCodexSnapshot(configDir: string): CodexUsageSnapshot {
  return entries.get(configDir)?.snapshot ?? CODEX_PENDING_SNAPSHOT;
}

export function refreshCodexSnapshot(configDir: string): void {
  const entry = entryFor(configDir);
  getCodexUsageSnapshot(configDir)
    .then((snapshot) => publish(entry, snapshot))
    .catch((error: unknown) => {
      publish(entry, {
        status: { type: "failed", message: String(error) },
        limits: [],
        plan: null,
        capturedAtMs: null,
      });
    });
}

/**
 * Register one consumer. The poll runs while at least one is registered.
 *
 * The shortest interval any live subscriber asks for wins, so a surface can
 * never be starved by another one's slower setting.
 */
export function subscribeCodexUsage(
  configDir: string,
  intervalMs: number,
  onChange: () => void,
): () => void {
  const entry = entryFor(configDir);
  entry.listeners.add(onChange);

  const wasIdle = entry.timer === null;
  if (wasIdle || intervalMs < entry.intervalMs) {
    if (entry.timer !== null) clearInterval(entry.timer);
    entry.intervalMs = intervalMs;
    entry.timer = setInterval(() => refreshCodexSnapshot(configDir), intervalMs);
  }
  if (wasIdle) refreshCodexSnapshot(configDir);

  return () => {
    entry.listeners.delete(onChange);
    if (entry.listeners.size > 0) return;
    if (entry.timer !== null) clearInterval(entry.timer);
    entry.timer = null;
    entry.intervalMs = 0;
  };
}

/** Test seam: drop every poller and cached snapshot. */
export function resetCodexUsageSubscriptions(): void {
  entries.forEach((entry) => {
    if (entry.timer !== null) clearInterval(entry.timer);
  });
  entries.clear();
}
