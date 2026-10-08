import { Terminal } from "@xterm/headless";
import { SerializeAddon } from "@xterm/addon-serialize";
import { activateTerminalUnicodeProvider } from "../../ui/src/lib/terminal-unicode-width";
import { completeCheckpoint } from "./checkpoint";
import { pendingBytes } from "./pending";
import { HeadlessColors } from "./colors";
import type { XtermTheme } from "../../ui/src/lib/color-scheme";
import { captureDaemonParserState, type DaemonParserState } from "../../ui/src/lib/daemon-parser-state";

export interface ScreenCheckpoint {
  cols: number;
  rows: number;
  serialized: string;
  pendingBytes: number[];
  parserState: DaemonParserState;
}

/** The daemon parser exists independently of attached presentation clients. */
export class HeadlessScreen {
  readonly terminal: Terminal;
  private readonly serializer: SerializeAddon;
  private readonly colors: HeadlessColors;

  constructor(cols: number, rows: number, reply: (data: string) => void, theme: XtermTheme = {}) {
    this.terminal = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true,
      windowsPty: { backend: "conpty", buildNumber: 21376 } });
    activateTerminalUnicodeProvider(this.terminal);
    this.serializer = new SerializeAddon();
    this.terminal.loadAddon(this.serializer);
    this.terminal.onData(reply);
    this.colors = new HeadlessColors(this.terminal, theme, reply);
  }

  write(data: string | Uint8Array): Promise<void> {
    return new Promise((resolve) => this.terminal.write(data, resolve));
  }

  checkpoint(): ScreenCheckpoint {
    const serialized = this.colors.checkpointPrefix() + completeCheckpoint(this.terminal, this.serializer.serialize());
    return { cols: this.terminal.cols, rows: this.terminal.rows, serialized, pendingBytes: pendingBytes(this.terminal), parserState: captureDaemonParserState(this.terminal) };
  }

  dispose(): void {
    this.terminal.dispose();
  }
}
