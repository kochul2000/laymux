import { create } from "zustand";

interface PaneRevealStoreState {
  /** Reference counts for panes temporarily forced through the reveal queue. */
  requestCounts: Readonly<Record<string, number>>;
  requestReveal: (paneId: string) => () => void;
}

/**
 * Internal bridge between Automation requests and PaneGrid's progressive mount
 * queue. A request is reference-counted so concurrent writes to the same queued
 * pane cannot release each other's reveal request early.
 */
export const usePaneRevealStore = create<PaneRevealStoreState>()((set) => ({
  requestCounts: {},
  requestReveal: (paneId) => {
    set((state) => ({
      requestCounts: {
        ...state.requestCounts,
        [paneId]: (state.requestCounts[paneId] ?? 0) + 1,
      },
    }));

    let released = false;
    return () => {
      if (released) return;
      released = true;
      set((state) => {
        const count = state.requestCounts[paneId] ?? 0;
        if (count <= 1) {
          const { [paneId]: _removed, ...rest } = state.requestCounts;
          return { requestCounts: rest };
        }
        return {
          requestCounts: { ...state.requestCounts, [paneId]: count - 1 },
        };
      });
    };
  },
}));
