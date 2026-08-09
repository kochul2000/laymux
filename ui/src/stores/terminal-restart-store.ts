import { create } from "zustand";

export interface TerminalRestartRequest {
  /** Bumped on every request; `ViewRenderer` uses it as the remount key. */
  epoch: number;
  /** CWD the fresh session should start in, resolved at request time. */
  cwd?: string;
  /**
   * True until `TerminalView` has consumed the request. A fresh restart skips
   * session/output/cwd restore; once consumed the same epoch must not skip it
   * again (a later remount for an unrelated reason would lose the scrollback).
   */
  fresh: boolean;
}

interface TerminalRestartStoreState {
  requests: Readonly<Record<string, TerminalRestartRequest>>;
  requestRestart: (paneId: string, cwd?: string) => void;
  consumeRestart: (paneId: string) => void;
  forgetRestart: (paneId: string) => void;
  /** Drop every request whose pane no longer exists. */
  gcStale: (alivePaneIds: Set<string>) => void;
}

/**
 * Single owner of "this pane's next terminal session must start fresh, in this
 * CWD" (ADR-0113, ADR-0140).
 *
 * Two producers share it because the payload and the lifetime are identical:
 * the user-requested restart of a running terminal, and the CWD seed a freshly
 * split pane inherits from the pane it was split off. A split pane
 * is born as an `EmptyView`, so its request simply waits until the user picks a
 * terminal — the same consume-on-first-session rule then retires it.
 *
 * `PaneGrid` and `Dock` each used to hold this in local component state, which
 * made the restart unreachable from anywhere else — the workspace-clear action
 * needs to request it for a whole workspace. Pane ids are globally unique, so
 * both surfaces can share one keyspace.
 */
export const useTerminalRestartStore = create<TerminalRestartStoreState>()((set) => ({
  requests: {},

  requestRestart: (paneId, cwd) =>
    set((state) => ({
      requests: {
        ...state.requests,
        [paneId]: { epoch: (state.requests[paneId]?.epoch ?? 0) + 1, cwd, fresh: true },
      },
    })),

  consumeRestart: (paneId) =>
    set((state) => {
      const request = state.requests[paneId];
      if (!request?.fresh) return state;
      return { requests: { ...state.requests, [paneId]: { ...request, fresh: false } } };
    }),

  forgetRestart: (paneId) =>
    set((state) => {
      if (!(paneId in state.requests)) return state;
      const { [paneId]: _removed, ...rest } = state.requests;
      return { requests: rest };
    }),

  // `forgetRestart` covers the explicit removal paths, but a pane can also
  // disappear without one — a restored session replaces the whole workspace
  // array, and `setPaneView` can turn a TerminalView into something else. Same
  // startup sweep the override store gets (`overrides-store.gcStale`).
  gcStale: (alivePaneIds) =>
    set((state) => {
      const kept = Object.entries(state.requests).filter(([paneId]) => alivePaneIds.has(paneId));
      if (kept.length === Object.keys(state.requests).length) return state;
      return { requests: Object.fromEntries(kept) };
    }),
}));
