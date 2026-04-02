import { useEffect, useRef, useState, useCallback } from "react";
import {
  getTerminalSummaries,
  markNotificationsRead,
  type TerminalSummaryResponse,
} from "@/lib/tauri-api";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Hook that fetches terminal summaries from the backend (single source of truth).
 * Listens for invalidation events and re-fetches with debounce.
 */
export function useBackendSummaries(terminalIds: string[]) {
  const [summaries, setSummaries] = useState<TerminalSummaryResponse[]>([]);
  const idsRef = useRef(terminalIds);
  idsRef.current = terminalIds;

  const fetchSummaries = useCallback(async () => {
    if (idsRef.current.length === 0) {
      setSummaries([]);
      return;
    }
    try {
      const result = await getTerminalSummaries(idsRef.current);
      setSummaries(result);
    } catch (err) {
      console.warn("[useBackendSummaries] fetch failed:", err);
    }
  }, []);

  useEffect(() => {
    // Initial fetch
    fetchSummaries();

    // Debounced fetch on invalidation events
    let timer: ReturnType<typeof setTimeout> | null = null;
    const debouncedFetch = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(fetchSummaries, 100);
    };

    // Listen to all events that can change terminal state
    const unlisteners: Promise<UnlistenFn>[] = [
      listen("command-status", debouncedFetch),
      listen("terminal-cwd-changed", debouncedFetch),
      listen("sync-cwd", debouncedFetch),
      listen("sync-branch", debouncedFetch),
      listen("lx-notify", debouncedFetch),
      listen("claude-terminal-detected", debouncedFetch),
    ];

    // Also poll every 2s for output_active changes (no event for those)
    const pollTimer = setInterval(fetchSummaries, 2000);

    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(pollTimer);
      for (const p of unlisteners) {
        p.then((unlisten) => unlisten());
      }
    };
  }, [fetchSummaries]);

  // Re-fetch when terminal IDs change
  useEffect(() => {
    fetchSummaries();
  }, [terminalIds.join(","), fetchSummaries]);

  const markRead = useCallback(
    async (tIds: string[]) => {
      await markNotificationsRead(tIds);
      fetchSummaries(); // Refresh after marking
    },
    [fetchSummaries],
  );

  return { summaries, refresh: fetchSummaries, markRead };
}
