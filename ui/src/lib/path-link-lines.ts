import { readLineCells, reconstructLine, type BufferLineLike } from "./terminal-cell-map";
import type { PathSelectionCandidate, SelectionPos } from "./path-link-detect";

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
}

export interface PathLinkLine {
  text: string;
  points: Array<{ row: number; col: number; endCol: number; width: number; wrapped: boolean }>;
}

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
  if (/^[A-Za-z]:|^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(continuation)) return null;
  if (/\.[A-Za-z][A-Za-z0-9_-]{0,15}$/.test(token)) return null;
  if (!/^[^\s]*[\\/.]/.test(continuation)) return null;
  return nextIndent;
}

/** 읽은 문자열과 셀 좌표는 항상 함께 이동한다. endRow는 exclusive다. */
export function readPathLinkLines(
  buffer: PathLinkBuffer,
  startRow: number,
  endRow: number,
  selection?: SelectionPos,
): PathLinkLine[] {
  const result: PathLinkLine[] = [];
  const start = Math.max(0, startRow);
  const end = Math.min(endRow, start + MAX_ROWS);
  let current: PathLinkLine | undefined;
  let clipped = false;
  let chars = 0;
  for (let row = start; row < end; row++) {
    const line = buffer.getLine(row);
    if (!line) {
      current = undefined;
      continue;
    }
    const previous = row > 0 ? buffer.getLine(row - 1) : undefined;
    const hardIndent = previous ? hardWrapIndent(previous, line) : null;
    const joined = Boolean(line.isWrapped) || hardIndent !== null;
    if (!joined || !current) {
      current = { text: "", points: [] };
      clipped = !selection && joined && row === start;
      result.push(current);
    }
    if (joined && !line.isWrapped && row > start) {
      current.text = current.text.trimEnd();
      current.points.length = current.text.length;
    }
    const cells = readLineCells(line);
    // Null padding is not text. Preserve actual spaces, including wrap-boundary
    // spaces in filenames; also remove the null slot before a wrapped wide cell.
    while (cells.length && cells.at(-1)!.chars === "" && cells.at(-1)!.width !== 0) cells.pop();
    const { text, columns, endColumns } = reconstructLine(cells);
    const fromCol = selection && row === selection.start.y ? selection.start.x + 1 : 1;
    const toCol = selection && row === selection.end.y ? selection.end.x : line.length;
    const indent = joined && !line.isWrapped && row > start ? (hardIndent ?? 0) : 0;
    for (let offset = indent; offset < text.length; offset++) {
      if (endColumns[offset] < fromCol || columns[offset] > toCol) continue;
      chars++;
      if (chars > MAX_CHARS) {
        clipped = true;
        break;
      }
      current.text += text[offset];
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
    }
    if (chars > MAX_CHARS) break;
  }
  return result;
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
  return parts;
}

/** scrollback 마커 이동량을 모든 조각에 같이 적용해 링크 전체를 검사한다. */
export function pathLinkPartsCurrent(
  buffer: PathLinkBuffer,
  parts: PathLinkPart[],
  rowDelta = 0,
): boolean {
  return (
    parts.length > 0 &&
    parts.every((part) => {
      const line = buffer.getLine(part.bufferLine - 1 + rowDelta);
      if (!line || line.length !== part.rowWidth || Boolean(line.isWrapped) !== part.isWrapped)
        return false;
      const { text, columns, endColumns } = reconstructLine(readLineCells(line));
      const start = columns.indexOf(part.startCol);
      const end = start + part.token.length - 1;
      return (
        start >= 0 && endColumns[end] === part.endCol && text.slice(start, end + 1) === part.token
      );
    })
  );
}
