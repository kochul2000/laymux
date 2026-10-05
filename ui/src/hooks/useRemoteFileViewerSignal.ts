import { useEffect } from "react";
import { reportFileViewerSignal, type FileViewerSignal } from "@/lib/tauri-api";
import { useFileViewerStore } from "@/stores/file-viewer-store";

function currentSignal(): FileViewerSignal {
  const { open, path, openEpoch, openRevision } = useFileViewerStore.getState();
  return { open: open && Boolean(path), epoch: openEpoch, revision: openRevision };
}

function sameSignal(a: FileViewerSignal, b: FileViewerSignal): boolean {
  return a.open === b.open && a.epoch === b.epoch && a.revision === b.revision;
}

/**
 * Mirror the desktop viewer's path-less open signal into the backend, which
 * hands it to Remote clients on every heartbeat (ADR-0291). The store stays the
 * source of truth; the backend only keeps the last value so a heartbeat never
 * waits on a bridge round trip to this WebView.
 *
 * Mount once, in `App` beside `useAutomationBridge` — not under the session
 * loading gate, so a reloaded WebView replaces the previous epoch at once. It
 * subscribes instead of selecting, like `useSleepPrevention`: nothing here
 * renders, so a store update must not reconcile the tree.
 */
export function useRemoteFileViewerSignal(): void {
  useEffect(() => {
    let last: FileViewerSignal | null = null;
    const sync = () => {
      const next = currentSignal();
      if (last && sameSignal(last, next)) return;
      last = next;
      reportFileViewerSignal(next).catch((error: unknown) => {
        // Forget what was sent so the next store update reports again instead
        // of leaving the backend on a stale value.
        if (last === next) last = null;
        console.warn("[file-viewer] failed to report the Remote viewer signal", error);
      });
    };

    // A reloaded WebView starts a new epoch with nothing open, so the first
    // value always goes out — the backend may still hold the previous epoch.
    sync();
    return useFileViewerStore.subscribe(sync);
  }, []);
}
