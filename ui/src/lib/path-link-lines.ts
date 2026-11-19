import { readLineCells, reconstructLine, type BufferLineLike } from "./terminal-cell-map";
import {
  PATH_LINK_MAX_STAT_BATCH,
  type PathLinkForegroundRange,
  type PathLinkForegroundSpan,
  type PathSelectionCandidate,
  type SelectionPos,
} from "./path-link-detect";

export interface PathLinkBuffer {
  getLine: (row: number) => (BufferLineLike & { isWrapped?: boolean }) | undefined;
}

export interface PathLinkPart {
  bufferLine: number;
  startCol: number;
  endCol: number;
  token: string;
  rowWidth: number;
  isWrapped: boolean;
  /** 첫 조각에만 기록한다. 빈 문자열은 검증 당시 겹치는 강조 구간이 없었다는 뜻이다. */
  foreground?: string;
}

export interface PathLinkLine {
  text: string;
  points: Array<{ row: number; col: number; endCol: number; width: number; wrapped: boolean }>;
  foregroundRanges?: PathLinkForegroundSpan[];
}

export type PathLinkFrame = Map<number, PathLinkLine | null>;

/** 한 번 읽는 물리 줄·UTF-16 문자 수 상한. 잘린 논리 줄은 통째로 버린다. */
export const PATH_LINK_CONTEXT_ROWS = 8;
const MAX_ROWS = 64;
const MAX_CHARS = 8192;

/**
 * ADR-0235: xterm 자동 wrap은 그대로 결합한다. TUI의 hard wrap은 오른쪽
 * 끝에 닿은 경로 토큰 + 같은 들여쓰기의 비절대경로 토큰일 때만 결합한다.
 * 일반 개행의 의미를 텍스트만으로 확정할 수 없으므로 최종 판정은 기존 stat이다.
 */
function hardWrapIndent(previous: BufferLineLike, next: BufferLineLike): number | null {
  const left = reconstructLine(readLineCells(previous));
  const right = reconstructLine(readLineCells(next));
  const tail = left.text.trimEnd();
  const lastCol = left.endColumns[tail.length - 1] ?? 0;
  if (lastCol < previous.length - 1) return null;
  const indent = /^ */.exec(left.text)![0].length;
  const nextIndent = /^ */.exec(right.text)![0].length;
  if (indent !== nextIndent) return null;
  const token = tail.match(/[^\s"'`()<>[\]{}|]+$/)?.[0] ?? "";
  const continuation = right.text.slice(nextIndent);
  if (!/[\\/]/.test(token) || /[.,;:)\]}]$/.test(token)) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(token)) return null;
  if (!/^[^\s"'`()<>[\]{}|/\\]/.test(continuation)) return null;
  // 드라이브·홈 상대경로(`~/`, ADR-0288)·URL 로 시작하면 새 경로다.
  if (/^[A-Za-z]:|^~(?:[\\/]|$)|^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(continuation)) return null;
  if (/\.[A-Za-z][A-Za-z0-9_-]{0,15}$/.test(token)) return null;
  if (!/^[^\s]*[\\/.]/.test(continuation)) return null;
  return nextIndent;
}

/** 읽은 문자열과 셀 좌표는 항상 함께 이동한다. endRow는 exclusive다. */
function readLines(
  buffer: PathLinkBuffer,
  startRow: number,
  endRow: number,
  selection?: SelectionPos,
): PathLinkLine[] {
  const result: PathLinkLine[] = [];
  const foregrounds: Array<Array<number | undefined>> = [];
  const start = Math.max(0, startRow);
  const end = Math.min(endRow, start + MAX_ROWS);
  let current: PathLinkLine | undefined;
  let colors: Array<number | undefined> = [];
  let clipped = false;
  let chars = 0;
  for (let row = start; row < end; row++) {
    const line = buffer.getLine(row);
    if (!line) {
      current = undefined;
      continue;
    }
    const previous = row > 0 ? buffer.getLine(row - 1) : undefined;
    const hardIndent = previous && !line.isWrapped ? hardWrapIndent(previous, line) : null;
    const joined = Boolean(line.isWrapped) || hardIndent !== null;
    if (!joined || !current) {
      current = { text: "", points: [] };
      clipped = !selection && joined && row === start;
      result.push(current);
      colors = [];
      foregrounds.push(colors);
    }
    const cells = readLineCells(line, true);
    // Null padding is not text. Preserve actual spaces, including wrap-boundary
    // spaces in filenames; also remove the null slot before a wrapped wide cell.
    while (cells.length && cells.at(-1)!.chars === "" && cells.at(-1)!.width !== 0) cells.pop();
    const { text, columns, endColumns } = reconstructLine(cells);
    const fromCol = selection && row === selection.start.y ? selection.start.x + 1 : 1;
    const toCol = selection && row === selection.end.y ? selection.end.x : line.length;
    const indent = joined && !line.isWrapped && row > start ? (hardIndent ?? 0) : 0;
    if (joined && !line.isWrapped && row > start) {
      const trimmedLength = current.text.trimEnd().length;
      const nextColor = cells[columns[indent] - 1]?.foreground;
      const keepsSpace =
        nextColor !== undefined &&
        nextColor !== 0 &&
        colors[trimmedLength - 1] === nextColor &&
        colors.slice(trimmedLength).every((color) => color === nextColor);
      if (!keepsSpace) {
        current.text = current.text.slice(0, trimmedLength);
        current.points.length = trimmedLength;
        colors.length = trimmedLength;
      }
    }
    for (let offset = indent; offset < text.length; offset++) {
      if (endColumns[offset] < fromCol || columns[offset] > toCol) continue;
      chars++;
      if (chars > MAX_CHARS) {
        clipped = true;
        break;
      }
      current.text += text[offset];
      colors.push(cells[columns[offset] - 1]?.foreground);
      current.points.push({
        row,
        col: columns[offset],
        endCol: endColumns[offset],
        width: line.length,
        wrapped: Boolean(line.isWrapped),
      });
    }
    const next = buffer.getLine(row + 1);
    const continues = next && (next.isWrapped || hardWrapIndent(line, next) !== null);
    if (clipped || (!selection && row === end - 1 && continues)) {
      current.text = "";
      current.points = [];
      colors.length = 0;
    }
    if (chars > MAX_CHARS) break;
  }
  for (const [index, line] of result.entries()) {
    const colors = foregrounds[index];
    if (colors.some((color) => color !== undefined))
      line.foregroundRanges = foregroundSpans(colors);
  }
  return result;
}

function foregroundSpans(colors: Array<number | undefined>): PathLinkForegroundSpan[] {
  const spans: PathLinkForegroundSpan[] = [];
  let startIndex = 0;
  for (let endIndex = 1; endIndex <= colors.length; endIndex++) {
    const color = colors[startIndex];
    if (color === colors[endIndex]) continue;
    if (
      color !== undefined &&
      color !== 0 &&
      (startIndex > 0 || endIndex < colors.length) &&
      (startIndex === 0 || colors[startIndex - 1] !== undefined) &&
      (endIndex === colors.length || colors[endIndex] !== undefined)
    ) {
      spans.push({ startIndex, endIndex });
    }
    startIndex = endIndex;
  }
  return spans;
}

export function readPathLinkLines(
  buffer: PathLinkBuffer,
  startRow: number,
  endRow: number,
  selection?: SelectionPos,
): PathLinkLine[] {
  const lines = readLines(buffer, startRow, endRow, selection);
  if (!selection) return lines;

  const frame: PathLinkFrame = new Map();
  for (const line of lines) {
    if (!line.foregroundRanges || !line.points.length) continue;
    const first = line.points[0];
    const full = readPathLinkLineAt(buffer, first.row, frame);
    const offset =
      full?.points.findIndex((point) => point.row === first.row && point.col === first.col) ?? -1;
    if (!full || offset < 0 || full.text.slice(offset, offset + line.text.length) !== line.text) {
      line.foregroundRanges = undefined;
      continue;
    }
    line.foregroundRanges = full.foregroundRanges
      ?.filter(
        ({ startIndex, endIndex }) => startIndex < offset + line.text.length && endIndex > offset,
      )
      .map(({ startIndex, endIndex }) => ({
        startIndex: startIndex - offset,
        endIndex: endIndex - offset,
      }));
  }
  return lines;
}

/** 현재 물리 행을 포함하는 논리 줄을 안정 프레임 안에서 한 번만 복원한다. */
export function readPathLinkLineAt(
  buffer: PathLinkBuffer,
  row: number,
  frame?: PathLinkFrame,
): PathLinkLine | null {
  const existing = frame?.get(row);
  if (existing !== undefined) return existing;
  let start = row;
  while (start > 0 && row - start < MAX_ROWS) {
    const line = buffer.getLine(start);
    const previous = buffer.getLine(start - 1);
    if (!line || !previous || (!line.isWrapped && hardWrapIndent(previous, line) === null)) break;
    start--;
  }
  let end = row + 1;
  while (end - start < MAX_ROWS) {
    const line = buffer.getLine(end);
    const previous = buffer.getLine(end - 1);
    if (!line || !previous || (!line.isWrapped && hardWrapIndent(previous, line) === null)) break;
    end++;
  }
  const line = readLines(buffer, start, end)[0] ?? null;
  if (frame) for (let i = start; i < end; i++) frame.set(i, line);
  return line;
}

/** 선택에 걸친 구간은 수명 확인에만 쓰고 후보 입력에는 완전한 구간만 전달한다. */
export function pathLinkForegroundRanges(
  lines: readonly PathLinkLine[],
  caret?: { lineIndex: number; index: number },
): PathLinkForegroundRange[] {
  const ranges: PathLinkForegroundRange[] = [];
  for (const [lineIndex, line] of lines.entries()) {
    if (caret && caret.lineIndex !== lineIndex) continue;
    for (const range of line.foregroundRanges ?? []) {
      if (range.startIndex < 0 || range.endIndex > line.text.length) continue;
      if (caret && (caret.index < range.startIndex || caret.index >= range.endIndex)) continue;
      if (!line.text.slice(range.startIndex, range.endIndex).includes(" ")) continue;
      if (ranges.length === PATH_LINK_MAX_STAT_BATCH) return ranges;
      ranges.push({ lineIndex, ...range });
    }
  }
  return ranges;
}

export function pathLinkLineSignature(line: PathLinkLine): string {
  return JSON.stringify([line.text, line.foregroundRanges ?? []]);
}

export function movePathLinkCapture<T extends { bufferLine: number; pathParts?: PathLinkPart[] }>(
  capture: T,
  bufferLine: number,
): T {
  const delta = bufferLine - capture.bufferLine;
  if (!delta) return capture;
  return {
    ...capture,
    bufferLine,
    pathParts: capture.pathParts?.map((part) => ({ ...part, bufferLine: part.bufferLine + delta })),
  };
}

function foregroundSignature(line: PathLinkLine, start: number, end: number): string {
  return (line.foregroundRanges ?? [])
    .filter(({ startIndex, endIndex }) => startIndex < end && endIndex > start)
    .map(({ startIndex, endIndex }) => `${startIndex - start}:${endIndex - start}`)
    .join(",");
}

/** 선택 원문과 대조해 끝점만으로 복원할 수 없는 직사각형 범위를 제외한다. */
export function readPathLinkSelection(
  buffer: PathLinkBuffer,
  position: SelectionPos,
  selection: string,
): PathLinkLine[] {
  const lines = readPathLinkLines(buffer, position.start.y, position.end.y + 1, position);
  // Column selections cannot be recovered from endpoints alone. Reject ranges
  // that include unselected text, allowing only layout whitespace differences.
  return lines
    .map((line) => line.text)
    .join("")
    .replace(/\s/g, "") === selection.replace(/\s/g, "")
    ? lines
    : [];
}

/** 후보 하나를 여러 물리 줄의 밑줄로 나누되, 모두 같은 파일을 가리킨다. */
export function mapPathLinkParts(
  line: PathLinkLine,
  candidate: Pick<PathSelectionCandidate, "text" | "startIndex" | "endIndex">,
): PathLinkPart[] {
  if (line.text.slice(candidate.startIndex, candidate.endIndex) !== candidate.text) return [];
  const parts: PathLinkPart[] = [];
  for (let offset = candidate.startIndex; offset < candidate.endIndex; offset++) {
    const p = line.points[offset];
    if (!p) return [];
    let part = parts.at(-1);
    if (!part || part.bufferLine !== p.row + 1) {
      part = {
        bufferLine: p.row + 1,
        startCol: p.col,
        endCol: p.endCol,
        token: "",
        rowWidth: p.width,
        isWrapped: p.wrapped,
      };
      parts.push(part);
    }
    part.endCol = p.endCol;
    part.token += line.text[offset];
  }
  if (parts.length && line.foregroundRanges) {
    parts[0].foreground = foregroundSignature(line, candidate.startIndex, candidate.endIndex);
  }
  return parts;
}

/** scrollback 마커 이동량을 모든 조각에 같이 적용해 링크 전체를 검사한다. */
export function pathLinkPartsCurrent(
  buffer: PathLinkBuffer,
  parts: PathLinkPart[],
  rowDelta = 0,
  frame?: PathLinkFrame,
): boolean {
  const first = parts[0];
  if (first?.foreground !== undefined) {
    const row = first.bufferLine - 1 + rowDelta;
    const line = readPathLinkLineAt(buffer, row, frame);
    const start =
      line?.points.findIndex((point) => point.row === row && point.col === first.startCol) ?? -1;
    const length = parts.reduce((sum, part) => sum + part.token.length, 0);
    if (
      !line ||
      start < 0 ||
      foregroundSignature(line, start, start + length) !== first.foreground
    ) {
      return false;
    }
  }
  return (
    parts.length > 0 &&
    parts.every((part, index) => {
      const line = buffer.getLine(part.bufferLine - 1 + rowDelta);
      if (!line || line.length !== part.rowWidth || Boolean(line.isWrapped) !== part.isWrapped)
        return false;
      if (index > 0 && !line.isWrapped) {
        const previous = buffer.getLine(part.bufferLine - 2 + rowDelta);
        if (
          parts[index - 1].bufferLine !== part.bufferLine - 1 ||
          !previous ||
          hardWrapIndent(previous, line) === null
        )
          return false;
      }
      const { text, columns, endColumns } = reconstructLine(readLineCells(line));
      const start = columns.indexOf(part.startCol);
      const end = start + part.token.length - 1;
      return (
        start >= 0 && endColumns[end] === part.endCol && text.slice(start, end + 1) === part.token
      );
    })
  );
}
