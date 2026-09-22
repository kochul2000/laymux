import { create } from "zustand";
import type { AppUpdateStatus } from "@/lib/tauri-api";
import type { ExitProgress } from "@/lib/lifecycle-progress";

interface LifecycleState {
  open: boolean;
  kind: "update" | "close";
  status: AppUpdateStatus | null;
  progress: ExitProgress | null;
  cleanup: boolean;
  preview: boolean;
  error: string | null;
  forceClose: (() => void) | null;
  openUpdate: () => void;
  receiveStatus: (status: AppUpdateStatus) => void;
  startClose: (cleanup: boolean) => void;
  report: (progress: ExitProgress) => void;
}
export const useLifecycleStore = create<LifecycleState>((set) => ({
  open: false,
  kind: "update",
  status: null,
  progress: null,
  cleanup: false,
  preview: false,
  error: null,
  forceClose: null,
  openUpdate: () =>
    set((state) =>
      state.kind === "close" && !state.preview
        ? {}
        : { open: true, kind: "update", preview: false, error: null, progress: null },
    ),
  receiveStatus: (status) =>
    set((state) => {
      if (state.preview || state.kind === "close") return {};
      const active =
        status.operation === "downloading" ||
        status.operation === "preparing" ||
        status.operation === "installing";
      const wasActive = state.status && !["idle", "checking"].includes(state.status.operation);
      return {
        status,
        open:
          state.open ||
          (active && state.status?.operation !== status.operation) ||
          Boolean(wasActive && status.lastError),
        error: wasActive && status.lastError ? status.lastError : state.error,
      };
    }),
  startClose: (cleanup) =>
    set({
      kind: "close",
      open: true,
      cleanup,
      preview: false,
      error: null,
      progress: { stage: "checkpoint", completed: 0, total: null },
    }),
  report: (progress) =>
    set((state) => ({
      progress: { ...progress, warning: progress.warning ?? state.progress?.warning },
    })),
}));

export async function waitForCloseDecision(error: string, pending: Promise<void>): Promise<void> {
  let release!: () => void;
  const forced = new Promise<void>((resolve) => {
    release = resolve;
  });
  useLifecycleStore.setState({ error, forceClose: release });
  // A late successful save may still close normally; a failure waits for the user.
  await Promise.race([
    forced,
    pending.catch((cause: unknown) => {
      useLifecycleStore.setState({ error: String(cause) });
      return forced;
    }),
  ]);
  useLifecycleStore.setState({ forceClose: null });
}

export function keepWaitingForClose(): void {
  const decision = useLifecycleStore.getState().forceClose;
  useLifecycleStore.setState({ error: null });
  setTimeout(() => {
    const state = useLifecycleStore.getState();
    if (decision && state.forceClose === decision && state.error === null) {
      useLifecycleStore.setState({ error: "timeout" });
    }
  }, 5000);
}
