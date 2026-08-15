import { useCallback, useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  onGrokUsageSnapshotChanged,
  refreshGrokUsageProbe,
  subscribeGrokUsageProbe,
  unsubscribeGrokUsageProbe,
  type GrokUsageSnapshot,
} from "@/lib/tauri-api";

function pendingSnapshot(configDir: string): GrokUsageSnapshot {
  return {
    configDir,
    status: { type: "starting" },
    rows: [],
    capturedAtMs: null,
    nextQueryAtMs: null,
    rawScreen: null,
  };
}

interface ProbeState {
  configDir: string;
  snapshot: GrokUsageSnapshot | null;
  error: string | null;
}

let claimSeq = 0;

export function useGrokUsageSnapshot(subscriberKey: string, configDir: string) {
  const [state, setState] = useState<ProbeState>(() => ({
    configDir,
    snapshot: null,
    error: null,
  }));

  useEffect(() => {
    let active = true;
    let unlisten: UnlistenFn | null = null;
    claimSeq += 1;
    const subscriberId = `${subscriberKey}#${claimSeq}`;

    onGrokUsageSnapshotChanged((next) => {
      if (!active) return;
      if (next.configDir !== configDir) return;
      setState({ configDir, snapshot: next, error: null });
    })
      .then((fn) => {
        if (!active) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {});

    subscribeGrokUsageProbe(subscriberId, configDir)
      .then((initial) => {
        if (!active) return;
        setState((current) =>
          current.configDir === configDir && current.snapshot !== null
            ? current
            : { configDir, snapshot: initial, error: null },
        );
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setState({ configDir, snapshot: null, error: String(reason) });
      });

    return () => {
      active = false;
      unlisten?.();
      unsubscribeGrokUsageProbe(subscriberId).catch(() => {});
    };
  }, [subscriberKey, configDir]);

  const matchesCurrentDir = state.configDir === configDir;
  const snapshot =
    matchesCurrentDir && state.snapshot ? state.snapshot : pendingSnapshot(configDir);
  const error = matchesCurrentDir ? state.error : null;

  const refresh = useCallback(() => {
    refreshGrokUsageProbe(configDir).catch(() => {});
  }, [configDir]);

  return { snapshot, error, refresh };
}
