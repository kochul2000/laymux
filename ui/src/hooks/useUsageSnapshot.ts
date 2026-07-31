import { useCallback, useEffect, useState } from "react";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  onUsageSnapshotChanged,
  refreshUsageProbe,
  subscribeUsageProbe,
  unsubscribeUsageProbe,
  type UsageSnapshot,
} from "@/lib/tauri-api";

/** Snapshot shown before the backend has answered. */
function pendingSnapshot(configDir: string): UsageSnapshot {
  return {
    configDir,
    status: { type: "starting" },
    session: { percent: null, reset: null },
    weekAll: { percent: null, reset: null },
    weekModel: { percent: null, reset: null },
    weekModelLabel: null,
    plan: null,
    model: null,
    capturedAtMs: null,
    nextQueryAtMs: null,
    rawScreen: null,
  };
}

/**
 * What the backend has told us, tagged with the config dir it describes.
 *
 * The tag is what lets a config-dir switch be handled by deriving during render
 * instead of resetting state from an effect: data for the previous dir is simply
 * not the data for the current one.
 */
interface ProbeState {
  configDir: string;
  snapshot: UsageSnapshot | null;
  error: string | null;
}

/**
 * Distinguishes one effect run's claim from another's.
 *
 * The claim id must be unique per run, not per pane: React can run an effect,
 * clean it up, and run it again (StrictMode, remounts, a fast config-dir flip).
 * With one shared id the *stale* cleanup releases the *live* claim, demand drops
 * to zero, and the backend retires the probe that the mounted view is waiting on
 * — observed live as a subscribed view stuck on `idle`.
 */
let claimSeq = 0;

/**
 * Subscribe one view instance to a config dir's usage probe.
 *
 * The subscription is what keeps the probe (and its `claude` process) alive, so
 * it is released on unmount and re-established whenever the config dir changes
 * — that is the demand signal the backend counts (ADR-0102).
 *
 * `subscriberKey` identifies the view instance; the actual claim id is derived
 * from it per effect run.
 */
export function useUsageSnapshot(subscriberKey: string, configDir: string) {
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

    // Listening starts before subscribing so the probe's first publish — which
    // can land while `subscribe` is still resolving — is not missed.
    onUsageSnapshotChanged((next) => {
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

    subscribeUsageProbe(subscriberId, configDir)
      .then((initial) => {
        if (!active) return;
        setState((current) =>
          // A live publish for this dir already arrived; the cached value handed
          // back by `subscribe` is older, so it must not overwrite it.
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
      unsubscribeUsageProbe(subscriberId).catch(() => {});
    };
  }, [subscriberKey, configDir]);

  const matchesCurrentDir = state.configDir === configDir;
  const snapshot =
    matchesCurrentDir && state.snapshot ? state.snapshot : pendingSnapshot(configDir);
  const error = matchesCurrentDir ? state.error : null;

  const refresh = useCallback(() => {
    refreshUsageProbe(configDir).catch(() => {});
  }, [configDir]);

  return { snapshot, error, refresh };
}

/**
 * A clock that ticks on an interval.
 *
 * Pace and countdowns are derived from "now", so they need a re-render even when
 * no new capture arrives.
 */
export function useNowTick(intervalMs: number): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);

  return now;
}
