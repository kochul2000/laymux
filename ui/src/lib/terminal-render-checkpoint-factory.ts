import { TerminalRenderCheckpointModel } from "./terminal-render-checkpoint";
import { TerminalRenderCheckpointWorker } from "./terminal-render-checkpoint-worker";
import type { TerminalParserAdmission } from "./terminal-parser-admission";

/** Both modes keep the same state, admission and capture contracts. */
export function createTerminalRenderCheckpoint(
  workerEnabled: boolean | undefined,
  admission: Pick<TerminalParserAdmission, "request" | "cancel">,
) {
  return workerEnabled !== false
    ? new TerminalRenderCheckpointWorker({ admission })
    : new TerminalRenderCheckpointModel({ admission });
}
