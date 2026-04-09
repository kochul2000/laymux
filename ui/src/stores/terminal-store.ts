import { create } from "zustand";

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
  lastCommand?: string;
  lastExitCode?: number;
  lastCommandAt?: number;
  /** Detected terminal activity state. */
  activity?: TerminalActivityInfo;
  /** True if terminal is actively producing output. */
  outputActive?: boolean;
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
        | "activity"
        | "outputActive"
        | "syncGroup"
        | "activityMessage"
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
      instances: state.instances.map((inst) => (inst.id === id ? { ...inst, ...info } : inst)),
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
