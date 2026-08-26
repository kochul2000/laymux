import type { Terminal } from "@xterm/xterm";

const CODEX_TRANSCRIPT_HEADER = "/ T R A N S C R I P T";
const CODEX_TRANSCRIPT_HEADER_MIN_COLUMNS = 9;

type WheelEventConsumer = {
  consumeWheelEvent(event: WheelEvent, cellHeight?: number, devicePixelRatio?: number): number;
};

type XtermWheelInternals = {
  _core?: {
    coreMouseService?: WheelEventConsumer;
    _renderService?: {
      dimensions?: {
        device?: {
          cell?: { height?: number };
        };
      };
    };
    _coreBrowserService?: { dpr?: number };
  };
};

export interface CodexTranscriptWheelHandlerOptions {
  terminal: Terminal;
  isCodexActive(): boolean;
  isLocalControlAllowed(): boolean;
}

/**
 * Codex's transcript pager can run in the normal buffer when the user's Codex
 * config disables alternate-screen rendering. Identify that live screen from
 * the pager's own header instead of hard-coding its configurable Ctrl+T chord.
 */
export function isCodexTranscriptPagerVisible(terminal: Terminal): boolean {
  const buffer = terminal.buffer.active;
  if (buffer.type !== "normal") return false;

  const headerColumns = Math.min(terminal.cols, CODEX_TRANSCRIPT_HEADER.length);
  if (headerColumns < CODEX_TRANSCRIPT_HEADER_MIN_COLUMNS) return false;
  const visibleHeader = CODEX_TRANSCRIPT_HEADER.slice(0, headerColumns).trimEnd();

  const firstVisibleLine = Math.max(0, buffer.viewportY);
  const visibleLineCount = Math.min(terminal.rows, buffer.length - firstVisibleLine);
  for (let offset = 0; offset < visibleLineCount; offset += 1) {
    const text = buffer.getLine(firstVisibleLine + offset)?.translateToString(true);
    if (text?.startsWith(visibleHeader)) return true;
  }
  return false;
}

function consumeWheelLines(terminal: Terminal, event: WheelEvent): number | undefined {
  const core = (terminal as unknown as XtermWheelInternals)._core;
  const mouseService = core?.coreMouseService;
  if (!mouseService) return undefined;

  return mouseService.consumeWheelEvent(
    event,
    core?._renderService?.dimensions?.device?.cell?.height,
    core?._coreBrowserService?.dpr,
  );
}

/**
 * Routes wheel rows to Codex's normal-buffer transcript pager. Returning true
 * delegates every other state to xterm's ordinary scrollback/application-mode
 * handling. Each row is emitted separately because ConPTY can collapse a run of
 * identical cursor sequences written as one chunk.
 */
export function createCodexTranscriptWheelHandler({
  terminal,
  isCodexActive,
  isLocalControlAllowed,
}: CodexTranscriptWheelHandlerOptions): (event: WheelEvent) => boolean {
  return (event) => {
    if (!isLocalControlAllowed() || !isCodexActive() || !isCodexTranscriptPagerVisible(terminal)) {
      return true;
    }

    const lines = consumeWheelLines(terminal, event);
    if (lines === undefined || !Number.isFinite(lines)) return true;

    event.preventDefault();
    event.stopPropagation();
    if (lines === 0) return false;

    const sequence = `\x1b${terminal.modes.applicationCursorKeysMode ? "O" : "["}${
      lines < 0 ? "A" : "B"
    }`;
    for (let row = 0; row < Math.abs(Math.trunc(lines)); row += 1) {
      terminal.input(sequence, true);
    }
    return false;
  };
}
