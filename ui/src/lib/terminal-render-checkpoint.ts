import { Terminal } from "@xterm/xterm";
import { TerminalRenderCheckpointModel as CoreModel } from "./terminal-render-checkpoint-core";
import type { TerminalRenderCheckpointModelOptions as CoreOptions } from "./terminal-render-checkpoint-core";
export type {
  TerminalRenderCheckpoint,
  TerminalRenderCheckpointTarget,
} from "./terminal-render-checkpoint-core";
export type TerminalRenderCheckpointModelOptions = Omit<CoreOptions, "terminal"> &
  Partial<Pick<CoreOptions, "terminal">>;

/** Browser adapter retained for inline parity tests and existing callers. */
export class TerminalRenderCheckpointModel extends CoreModel {
  constructor(options: TerminalRenderCheckpointModelOptions = {}) {
    super({
      ...options,
      terminal:
        options.terminal ??
        new Terminal({
          allowProposedApi: true,
          cols: 80,
          rows: 24,
          scrollback: 10_000,
          windowsPty: { backend: "conpty", buildNumber: 21376 },
        }),
    });
  }
}
