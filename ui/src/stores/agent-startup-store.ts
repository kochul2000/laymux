import { create } from "zustand";

export type AgentId = "claude" | "codex" | "grok";
export type AgentStartupIntent = AgentId | "shell";

interface AgentStartupState {
  /** One-shot intent for a new pane. It is never included in settings or session snapshots. */
  requests: Record<string, AgentStartupIntent>;
  outcomes: Record<string, { status: "ready" | "failed"; detail?: string }>;
  request: (paneId: string, intent: AgentStartupIntent) => void;
  report: (paneId: string, outcome: { status: "ready" | "failed"; detail?: string }) => void;
  consume: (paneId: string) => void;
  clear: (paneId: string) => void;
  clearAll: () => void;
}

export const useAgentStartupStore = create<AgentStartupState>()((set) => ({
  requests: {},
  outcomes: {},
  request: (paneId, intent) =>
    set((state) => ({ requests: { ...state.requests, [paneId]: intent } })),
  report: (paneId, outcome) =>
    set((state) => ({ outcomes: { ...state.outcomes, [paneId]: outcome } })),
  consume: (paneId) =>
    set((state) => {
      if (!(paneId in state.requests)) return state;
      const requests = { ...state.requests };
      delete requests[paneId];
      return { requests };
    }),
  clear: (paneId) =>
    set((state) => {
      if (!(paneId in state.requests) && !(paneId in state.outcomes)) return state;
      const requests = { ...state.requests };
      const outcomes = { ...state.outcomes };
      delete requests[paneId];
      delete outcomes[paneId];
      return { requests, outcomes };
    }),
  clearAll: () => set({ requests: {}, outcomes: {} }),
}));
