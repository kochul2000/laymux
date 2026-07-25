export type TerminalWriteSource = "live" | "replay";
export type XtermDataRoute = "human" | "protocol" | "suppress";

export type Disposable = { dispose(): void };

type XtermCoreUserInputSource = {
  _core?: {
    coreService?: {
      onUserInput?: (listener: () => void) => Disposable;
    };
  };
};

/**
 * xterm's public onData event drops CoreService's `wasUserInput` bit. The
 * internal onUserInput event is fired synchronously immediately before onData,
 * so it is the only deterministic discriminator for delayed CompositionHelper
 * commits that can overlap an asynchronous parser write.
 *
 * This adapter deliberately returns undefined when the pinned xterm internals
 * change. Callers then fail closed by treating live-write data as human input;
 * they must never guess that ambiguous data is an owner-independent reply.
 */
export function subscribeXtermUserInputOrigin(
  terminal: unknown,
  listener: () => void,
): Disposable | undefined {
  const source = terminal as XtermCoreUserInputSource;
  const coreService = source._core?.coreService;
  if (!coreService || typeof coreService.onUserInput !== "function") return undefined;
  try {
    const subscription = coreService.onUserInput(listener);
    return subscription && typeof subscription.dispose === "function" ? subscription : undefined;
  } catch {
    return undefined;
  }
}

export function routeXtermData(input: {
  writeSource: TerminalWriteSource | undefined;
  humanEventActive: boolean;
  userInputOriginReliable: boolean;
}): XtermDataRoute {
  if (input.humanEventActive) return "human";
  if (input.writeSource === "replay") return "suppress";
  if (input.writeSource === "live" && input.userInputOriginReliable) return "protocol";
  return "human";
}
