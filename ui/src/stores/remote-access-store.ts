import { create } from "zustand";
import type { RemoteAccessStatus } from "@/lib/tauri-api";

interface RemoteAccessState {
  status: RemoteAccessStatus | null;
  setStatus: (status: RemoteAccessStatus | null) => void;
}

export const useRemoteAccessStore = create<RemoteAccessState>()((set) => ({
  status: null,
  setStatus: (status) => set({ status }),
}));
