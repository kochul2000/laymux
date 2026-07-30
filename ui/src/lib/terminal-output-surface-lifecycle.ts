export interface TerminalOutputParserLifecycle {
  alive: boolean;
  ready: boolean;
  generation?: number;
  leaseToken?: string;
}

export interface TerminalOutputSurfaceLifecycle {
  generation: number;
  leaseToken: string;
  attachEpoch: number;
  visible: TerminalOutputParserLifecycle;
  checkpoint: TerminalOutputParserLifecycle;
  disposed: boolean;
  failStoppedReason: string | null;
  /** Native stabilizer lexical/frame ownership is normal bounded work. */
  stabilizerHolding: boolean;
  /** Queue or parsed-credit admission waiting is normal bounded work. */
  capacityWaiting: boolean;
}

export type TerminalOutputSurfaceAvailability =
  | { kind: "healthy"; backpressured: boolean }
  | { kind: "unavailable"; reason: string };

export type TerminalOutputReplacementDecision = "allow" | "wait-for-grant-close" | "fail-stop";

/**
 * Compute the mount-local desktop surface verdict from raw lifecycle facts.
 * Queue length, parser latency and stabilizer holds never become independent
 * authorities that can replace the current generation or lease.
 */
export function terminalOutputSurfaceAvailability(
  lifecycle: TerminalOutputSurfaceLifecycle,
): TerminalOutputSurfaceAvailability {
  if (lifecycle.failStoppedReason !== null) {
    return { kind: "unavailable", reason: lifecycle.failStoppedReason };
  }
  if (lifecycle.disposed) return { kind: "unavailable", reason: "surface_disposed" };

  const visibleFailure = parserFailureReason("visible", lifecycle.visible, lifecycle);
  if (visibleFailure) return { kind: "unavailable", reason: visibleFailure };
  const checkpointFailure = parserFailureReason("checkpoint", lifecycle.checkpoint, lifecycle);
  if (checkpointFailure) return { kind: "unavailable", reason: checkpointFailure };

  return {
    kind: "healthy",
    backpressured: lifecycle.stabilizerHolding || lifecycle.capacityWaiting,
  };
}

/** Never reset/replay across an active continuation grant. */
export function decideTerminalOutputReplacement(
  lifecycle: TerminalOutputSurfaceLifecycle,
  continuationGrantActive: boolean,
): TerminalOutputReplacementDecision {
  const availability = terminalOutputSurfaceAvailability(lifecycle);
  if (availability.kind === "unavailable") {
    if (continuationGrantActive || lifecycle.failStoppedReason !== null) return "fail-stop";
    return "allow";
  }
  return continuationGrantActive ? "wait-for-grant-close" : "allow";
}

function parserFailureReason(
  name: "visible" | "checkpoint",
  parser: TerminalOutputParserLifecycle,
  lifecycle: TerminalOutputSurfaceLifecycle,
): string | undefined {
  if (!parser.alive) return `${name}_parser_unavailable`;
  if (!parser.ready) return `${name}_parser_not_ready`;
  if (parser.generation !== lifecycle.generation) return `${name}_generation_stale`;
  if (parser.leaseToken !== lifecycle.leaseToken) return `${name}_lease_stale`;
  return undefined;
}
