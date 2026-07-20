import { create } from "zustand";
import {
  createTerminalStartupState,
  settleTerminalStartup,
  syncTerminalStartupCandidates,
  type TerminalStartupState,
  type TerminalStartupSyncInput,
} from "@/lib/terminal-startup-coordinator";

interface TerminalStartupStoreState extends TerminalStartupState {
  syncCandidates: (input: TerminalStartupSyncInput) => void;
  settleStartup: (paneId: string) => void;
}

/** App-global source of truth for the single terminal startup slot. */
export const useTerminalStartupStore = create<TerminalStartupStoreState>()((set) => ({
  ...createTerminalStartupState(),
  syncCandidates: (input) => set((state) => syncTerminalStartupCandidates(state, input)),
  settleStartup: (paneId) => set((state) => settleTerminalStartup(state, paneId)),
}));
