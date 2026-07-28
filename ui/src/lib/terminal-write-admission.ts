export interface TerminalWriteAdmission {
  write: () => void;
  isBackpressure: (error: unknown) => boolean;
  onAccepted: () => void;
  restoreBackpressure: () => void;
  onBackpressure: () => void;
  onRejectedWarning: (error: unknown) => void;
  onDiscard: () => void;
}

function bestEffort(step: () => void): void {
  try {
    step();
  } catch {
    // Diagnostics and logical outcome listeners cannot change byte admission.
  }
}

/**
 * Keep xterm admission as the only operation that decides accepted/rejected.
 * Every operation after acceptance is diagnostic. A rejected backpressure
 * batch is restored before any fallible warning or counter is attempted.
 */
export function attemptTerminalWrite(admission: TerminalWriteAdmission): boolean {
  let rejected = false;
  let rejection: unknown;
  try {
    admission.write();
  } catch (error) {
    rejected = true;
    rejection = error;
  }

  if (!rejected) {
    bestEffort(admission.onAccepted);
    return true;
  }

  let backpressure = false;
  try {
    backpressure = admission.isBackpressure(rejection);
  } catch {
    // An unclassifiable rejection cannot safely be retried as backpressure.
  }
  if (backpressure) {
    admission.restoreBackpressure();
    bestEffort(() => admission.onRejectedWarning(rejection));
    bestEffort(admission.onBackpressure);
    return false;
  }

  bestEffort(admission.onDiscard);
  bestEffort(() => admission.onRejectedWarning(rejection));
  return true;
}
