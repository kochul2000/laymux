import type {
  TerminalRenderCheckpoint,
  TerminalRenderCheckpointTarget,
} from "./terminal-render-checkpoint";

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

export type TerminalRenderCheckpointProvider = (
  target: TerminalRenderCheckpointTarget,
  maxBytes: number,
) => Promise<TerminalRenderCheckpoint>;

const renderCheckpointRegistry = new Map<string, TerminalRenderCheckpointProvider>();

export function registerTerminalRenderCheckpointProvider(
  terminalId: string,
  provider: TerminalRenderCheckpointProvider,
): void {
  renderCheckpointRegistry.set(terminalId, provider);
}

export function unregisterTerminalRenderCheckpointProvider(terminalId: string): void {
  renderCheckpointRegistry.delete(terminalId);
}

export function getTerminalRenderCheckpointProvider(
  terminalId: string,
): TerminalRenderCheckpointProvider | undefined {
  return renderCheckpointRegistry.get(terminalId);
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

/** 실제 PTY 격자에서 순서대로 파싱한 현재 입력창 판독용 화면. */
export interface TerminalPtyBufferDump extends TerminalBufferDump {
  generation: number;
  seq: number;
}

type PtyInspector = () => Promise<TerminalPtyBufferDump>;
const ptyInspectRegistry = new Map<string, PtyInspector>();

export function registerTerminalPtyInspector(id: string, inspect: PtyInspector): void {
  ptyInspectRegistry.set(id, inspect);
}

export function unregisterTerminalPtyInspector(id: string): void {
  ptyInspectRegistry.delete(id);
}

export function getTerminalPtyInspector(id: string): PtyInspector | undefined {
  return ptyInspectRegistry.get(id);
}

export interface TerminalViewportState {
  cols: number;
  rows: number;
  /** Bottom-most scroll offset in the active buffer. */
  baseY: number;
  /** Absolute line shown at the top of the viewport. */
  viewportY: number;
  isAtBottom: boolean;
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

type ScrollFn = (lines: number) => TerminalViewportState;

const scrollRegistry = new Map<string, ScrollFn>();

export function registerTerminalScroller(paneId: string, fn: ScrollFn): void {
  scrollRegistry.set(paneId, fn);
}

export function unregisterTerminalScroller(paneId: string): void {
  scrollRegistry.delete(paneId);
}

export function getTerminalScroller(paneId: string): ScrollFn | undefined {
  return scrollRegistry.get(paneId);
}
