import { create } from "zustand";
import { observeTask, type TaskObservation, type TerminalTask } from "@/lib/terminal-task";

export const SESSION_ATTRIBUTION_STARTUP_GRACE_MS = 15_000;

export type TerminalActivityType = "shell" | "running" | "interactiveApp";

export interface TerminalActivityInfo {
  type: TerminalActivityType;
  name?: string; // For interactiveApp: "Claude", "vim", "neovim", etc.
}

export interface TerminalInstance {
  id: string;
  profile: string;
  syncGroup: string;
  workspaceId: string;
  label: string;
  cwd?: string;
  branch?: string;
  title?: string;
  lastActivityAt: number;
  isFocused: boolean;
  /** False between React mount and successful backend PTY session creation. */
  sessionReady?: boolean;
  generation?: number;
  taskEpoch?: number;
  appSession?: number;
  livenessConfirmed?: boolean;
  taskObservation?: TaskObservation;
  task?: TerminalTask;
  /** Codex input received after a closed turn, awaiting authoritative turn attribution. */
  deferredTaskInput?: {
    source: string;
    taskId: string;
    inputAt: number;
    observation?: TaskObservation;
  };
  /** Resume startup grace: do not classify the pane as a conclusive shell yet. */
  attributionPendingUntil?: number;
  lastCommand?: string;
  lastExitCode?: number;
  lastCommandAt?: number;
  /** Latest user text submitted to this terminal; runtime-only and never persisted. */
  lastUserInput?: string;
  lastUserInputAt?: number;
  /** Detected terminal activity state. */
  activity?: TerminalActivityInfo;
  /**
   * Backend stamp of the activity above, taken when the backend *derived* it.
   *
   * Two producers write activity — the PTY callback per title, and the periodic
   * reconcile worker — and they do not arrive in derivation order: a reconcile
   * pass snapshots state, walks every pane, then emits, so a title resolved in
   * that window is newer but lands first. Keeping the winning stamp lets the
   * later-arriving older verdict be ignored (ADR-0135).
   */
  activitySequence?: number;
  /** True if terminal is actively producing output. */
  outputActive?: boolean;
  /** Current Codex turn, independent of terminal rendering activity. Runtime only. */
  codexTurn?: import("@/lib/tauri-api").CodexTurnSnapshot;
  /**
   * Which backend detector armed the current `outputActive` (ADR-0147), or
   * `undefined` when it came from a path that does not report one (the title
   * spinner) or `outputActive` is false.
   *
   * Rendering and byte-volume diagnostics stay independent of task lifecycle.
   * Neither source proves Codex completion (ADR-0248).
   */
  outputActiveSource?: "frame" | "volume";
  /** Latest provider-specific activity status message. */
  activityMessage?: string;
}

interface TerminalStoreState {
  instances: TerminalInstance[];

  registerInstance: (config: {
    id: string;
    profile: string;
    syncGroup: string;
    workspaceId: string;
    label?: string;
  }) => void;
  unregisterInstance: (id: string) => void;
  observeTask: (id: string, observation: TaskObservation) => void;
  getInstancesBySyncGroup: (group: string) => TerminalInstance[];
  getTerminalsForWorkspace: (workspaceId: string) => TerminalInstance[];
  updateInstanceInfo: (
    id: string,
    info: Partial<
      Pick<
        TerminalInstance,
        | "cwd"
        | "branch"
        | "title"
        | "lastCommand"
        | "lastExitCode"
        | "lastCommandAt"
        | "lastUserInput"
        | "lastUserInputAt"
        | "deferredTaskInput"
        | "activity"
        | "activitySequence"
        | "outputActive"
        | "codexTurn"
        | "outputActiveSource"
        | "syncGroup"
        | "activityMessage"
        | "sessionReady"
        | "generation"
        | "appSession"
        | "livenessConfirmed"
        | "attributionPendingUntil"
      >
    >,
  ) => void;
  clearCommandState: (id: string) => void;
  updateTerminalActivity: (id: string) => void;
  setTerminalFocus: (id: string) => void;
}

export const useTerminalStore = create<TerminalStoreState>()((set, get) => ({
  instances: [],

  registerInstance: (config) => {
    const instance: TerminalInstance = {
      id: config.id,
      profile: config.profile,
      syncGroup: config.syncGroup,
      workspaceId: config.workspaceId,
      label: config.label ?? config.profile,
      lastActivityAt: Date.now(),
      isFocused: false,
      sessionReady: false,
    };
    set((state) => ({
      instances: state.instances.some((i) => i.id === config.id)
        ? state.instances.map((i) => (i.id === config.id ? instance : i))
        : [...state.instances, instance],
    }));
  },

  unregisterInstance: (id) => {
    set((state) => ({
      instances: state.instances.filter((inst) => inst.id !== id),
    }));
  },

  getInstancesBySyncGroup: (group) => {
    return get().instances.filter((inst) => inst.syncGroup === group);
  },

  getTerminalsForWorkspace: (workspaceId) => {
    return get().instances.filter((inst) => inst.workspaceId === workspaceId);
  },

  updateInstanceInfo: (id, info) => {
    set((state) => ({
      instances: state.instances.map((inst) => {
        if (inst.id !== id) return inst;
        const next = { ...inst, ...info };
        const changed =
          inst.activity?.name !== next.activity?.name ||
          inst.generation !== next.generation ||
          inst.appSession !== next.appSession ||
          (inst.sessionReady !== false && next.sessionReady === false);
        return changed
          ? {
              ...next,
              task: undefined,
              taskObservation: undefined,
              deferredTaskInput: undefined,
              codexTurn: undefined,
              taskEpoch: (inst.taskEpoch ?? 0) + 1,
              livenessConfirmed: info.livenessConfirmed ?? false,
            }
          : {
              ...next,
              ...(info.lastUserInputAt !== undefined &&
              info.lastUserInputAt !== inst.lastUserInputAt
                ? {
                    deferredTaskInput:
                      next.activity?.name === "Codex" && inst.task?.state === "ended"
                        ? {
                            source: inst.task.source,
                            taskId: inst.task.taskId,
                            inputAt: info.lastUserInputAt,
                          }
                        : undefined,
                  }
                : {}),
            };
      }),
    }));
  },

  observeTask: (id, observation) => {
    set((state) => ({
      instances: state.instances.map((inst) =>
        inst.id === id
          ? {
              ...inst,
              taskObservation: observation,
              task: observeTask(inst.task, observation, Date.now()),
            }
          : inst,
      ),
    }));
  },

  clearCommandState: (id) => {
    set((state) => ({
      instances: state.instances.map((inst) =>
        inst.id === id
          ? { ...inst, lastCommand: undefined, lastExitCode: undefined, lastCommandAt: undefined }
          : inst,
      ),
    }));
  },

  updateTerminalActivity: (id) => {
    set((state) => ({
      instances: state.instances.map((inst) =>
        inst.id === id ? { ...inst, lastActivityAt: Date.now() } : inst,
      ),
    }));
  },

  setTerminalFocus: (id) => {
    const target = get().instances.find((i) => i.id === id);
    if (!target) return;
    set((state) => ({
      instances: state.instances.map((inst) => {
        if (inst.id === id) return { ...inst, isFocused: true };
        // Clear focus for other terminals in the same workspace
        if (inst.workspaceId === target.workspaceId) return { ...inst, isFocused: false };
        return inst;
      }),
    }));
  },
}));
