import { create } from "zustand";
import type { TerminalDisplayContext } from "@/lib/terminal-display-context";

/** Live daemon history only: never included in settings/session serialization. */
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
