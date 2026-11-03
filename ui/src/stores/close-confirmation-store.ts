import { create } from "zustand";
import { useSettingsStore } from "./settings-store";
import { collectSettingsSnapshot, saveAndApplySettingsSnapshot } from "@/lib/settings-snapshot";

interface CloseConfirmationState {
  open: boolean;
  dontShowAgain: boolean;
  saving: boolean;
  error: string | null;
  resolve: ((confirmed: boolean) => void) | null;
  cancel: () => void;
  confirm: () => Promise<void>;
}

export const useCloseConfirmationStore = create<CloseConfirmationState>((set, get) => ({
  open: false,
  dontShowAgain: false,
  saving: false,
  error: null,
  resolve: null,
  cancel: () => {
    const state = get();
    if (state.saving) return;
    set({ open: false, resolve: null });
    state.resolve?.(false);
  },
  confirm: async () => {
    const state = get();
    if (!state.open || state.saving) return;
    set({ saving: true, error: null });
    try {
      if (state.dontShowAgain) {
        const settings = await collectSettingsSnapshot({ includeRuntimeStructuralState: false });
        await saveAndApplySettingsSnapshot(
          { ...settings, exit: { ...useSettingsStore.getState().exit, confirmBeforeExit: false } },
          { includeStructural: false, expectedSettings: settings },
        );
      }
      set({ open: false, saving: false, resolve: null });
      state.resolve?.(true);
    } catch (cause) {
      set({ saving: false, error: String(cause) });
    }
  },
}));

/** Called inside the existing single-flight close handler, before any teardown. */
export function requestCloseConfirmation(): Promise<boolean> {
  if (!useSettingsStore.getState().exit.confirmBeforeExit) return Promise.resolve(true);
  return new Promise((resolve) => {
    useCloseConfirmationStore.setState({
      open: true,
      dontShowAgain: false,
      saving: false,
      error: null,
      resolve,
    });
  });
}
