import { create } from "zustand";

interface LocalMobileModeState {
  active: boolean;
  url: string | null;
  /**
   * Increments on every entry. The URL alone cannot key per-entry state — the
   * same port and token rebuild the identical string — so a second entry would
   * inherit the first one's "the frame already greeted us" verdict and lose its
   * host-drawn exit (#955).
   */
  session: number;
  enter: (url: string) => void;
  exit: () => void;
}

export const useLocalMobileModeStore = create<LocalMobileModeState>()((set) => ({
  active: false,
  url: null,
  session: 0,
  enter: (url) => set((state) => ({ active: true, url, session: state.session + 1 })),
  exit: () => set({ active: false, url: null }),
}));
