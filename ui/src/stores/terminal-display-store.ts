import { create } from "zustand";
import type { TerminalDisplayContext } from "@/lib/terminal-display-context";

/** Display history restored from the local checkpoint or daemon; never live authority. */
export const useTerminalDisplayStore = create<{
  contexts: Record<string, TerminalDisplayContext>;
  setContext: (id: string, context: TerminalDisplayContext | undefined) => void;
}>((set) => ({
  contexts: {},
  setContext: (id, context) =>
    set((state) => {
      const contexts = { ...state.contexts };
      if (context) contexts[id] = context;
      else delete contexts[id];
      return { contexts };
    }),
}));
