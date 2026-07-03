import { create } from "zustand";

interface LocalMobileModeState {
  active: boolean;
  url: string | null;
  enter: (url: string) => void;
  exit: () => void;
}

export const useLocalMobileModeStore = create<LocalMobileModeState>()((set) => ({
  active: false,
  url: null,
  enter: (url) => set({ active: true, url }),
  exit: () => set({ active: false, url: null }),
}));
