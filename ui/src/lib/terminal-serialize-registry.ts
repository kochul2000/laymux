type SerializeFn = () => string;

const registry = new Map<string, SerializeFn>();

export function registerTerminalSerializer(paneId: string, fn: SerializeFn): void {
  registry.set(paneId, fn);
}

export function unregisterTerminalSerializer(paneId: string): void {
  registry.delete(paneId);
}

export function getTerminalSerializeMap(): ReadonlyMap<string, SerializeFn> {
  return new Map(registry);
}

/**
 * Buffer inspector registry — exposes xterm's *reflowed* buffer for automated
 * verification (issue #285). Unlike the PTY ring buffer, this reflects xterm's
 * own line model after a resize, including the `isWrapped` flag that decides
 * whether ConPTY hard-wrapped rows re-join on a width change. Keyed by paneId.
 */
export interface TerminalBufferLine {
  /** Absolute line index in the active buffer (0 = top of scrollback). */
  index: number;
  /** Line text with trailing whitespace trimmed. */
  text: string;
  /** xterm's wrap flag: true means this row continues the previous logical line. */
  isWrapped: boolean;
}

export interface TerminalBufferDump {
  cols: number;
  rows: number;
  /** Total lines in the active buffer (scrollback + viewport). */
  length: number;
  /** Scrollback rows above the viewport (buffer.baseY). */
  baseY: number;
  /** Lines returned (a trailing slice when the buffer exceeds `limit`). */
  lines: TerminalBufferLine[];
}

type BufferDumpFn = (limit: number) => TerminalBufferDump;

const inspectRegistry = new Map<string, BufferDumpFn>();

export function registerTerminalInspector(paneId: string, fn: BufferDumpFn): void {
  inspectRegistry.set(paneId, fn);
}

export function unregisterTerminalInspector(paneId: string): void {
  inspectRegistry.delete(paneId);
}

export function getTerminalInspector(paneId: string): BufferDumpFn | undefined {
  return inspectRegistry.get(paneId);
}
