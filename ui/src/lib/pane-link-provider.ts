import type { IBuffer, IBufferRange, ILink, ILinkProvider, Terminal } from "@xterm/xterm";
import { readLineCells, reconstructLine } from "./terminal-cell-map";
import { findPaneTokens, type PaneLinkTarget } from "./pane-link";

export interface PaneLinkDependencies {
  enabled: () => boolean;
  workspaceNames?: () => readonly string[];
  resolve: (text: string) => PaneLinkTarget | null;
  navigate: (target: PaneLinkTarget, text: string, isCurrent: () => boolean) => void;
}
export interface PaneLinkMatch {
  text: string;
  range: IBufferRange;
}

const MAX_ROWS = 16;
const MAX_TEXT = 8192;

/** 실제 개행은 넘지 않고 xterm의 자동 wrap만 연결한다. OSC 8 셀은 기존 링크 소유다. */
export function findPaneLinks(
  terminal: Terminal,
  bufferLine: number,
  deps: PaneLinkDependencies,
): PaneLinkMatch[] {
  if (!deps.enabled()) return [];
  const buffer = terminal.buffer.active;
  let start = bufferLine - 1;
  if (!buffer.getLine(start)) return [];
  while (buffer.getLine(start)?.isWrapped) {
    if (--start < 0 || bufferLine - 1 - start >= MAX_ROWS) return [];
  }
  let text = "";
  const points: { x: number; endX: number; y: number; linked: boolean }[] = [];
  for (let row = start; row < start + MAX_ROWS; row++) {
    const line = buffer.getLine(row);
    if (!line) return [];
    const mapped = reconstructLine(readLineCells(line));
    text += mapped.text;
    for (let offset = 0; offset < mapped.text.length; offset++) {
      const x = mapped.columns[offset];
      const cell = line.getCell(x - 1) as { extended?: { urlId?: number } } | undefined;
      points.push({
        x,
        endX: mapped.endColumns[offset],
        y: row + 1,
        linked: Boolean(cell?.extended?.urlId),
      });
    }
    if (text.length > MAX_TEXT) return [];
    if (buffer.getLine(row + 1)?.isWrapped) continue;
    return findPaneTokens(
      text,
      text.includes("lx:pane:") ? deps.workspaceNames?.() : undefined,
    ).flatMap((token) => {
      if (!deps.resolve(token.text) || points.slice(token.start, token.end).some((p) => p.linked))
        return [];
      const first = points[token.start];
      const last = points[token.end - 1];
      if (!first || !last) return [];
      return [
        {
          text: token.text,
          range: { start: { x: first.x, y: first.y }, end: { x: last.endX, y: last.y } },
        },
      ];
    });
  }
  return [];
}

export function paneLinkAtCell(
  terminal: Terminal,
  row: number,
  col: number,
  deps: PaneLinkDependencies,
) {
  return findPaneLinks(terminal, row, deps).find(
    ({ range: { start, end } }) =>
      (row > start.y || (row === start.y && col >= start.x)) &&
      (row < end.y || (row === end.y && col <= end.x)),
  );
}

export function createPaneLinkProvider(
  terminal: Terminal,
  deps: PaneLinkDependencies,
): ILinkProvider {
  return {
    provideLinks(row, callback) {
      const buffer = terminal.buffer.active;
      const cols = terminal.cols;
      const links: ILink[] = findPaneLinks(terminal, row, deps).map((match) => ({
        ...match,
        // 밑줄은 viewport decoration만 소유해 설정을 끌 때 hover 캐시에 남지 않는다.
        decorations: { underline: false, pointerCursor: true },
        activate: () => {
          const isCurrent = () => {
            if (buffer !== terminal.buffer.active || cols !== terminal.cols) return;
            const current = findPaneLinks(terminal, row, deps).find(
              (candidate) =>
                candidate.text === match.text &&
                candidate.range.start.x === match.range.start.x &&
                candidate.range.start.y === match.range.start.y &&
                candidate.range.end.x === match.range.end.x &&
                candidate.range.end.y === match.range.end.y,
            );
            return Boolean(current);
          };
          const target = isCurrent() && deps.resolve(match.text);
          if (target) deps.navigate(target, match.text, () => Boolean(isCurrent()));
        },
      }));
      callback(links.length ? links : undefined);
    },
  };
}

/** 터치에도 링크를 발견할 수 있게 viewport에만 상시 밑줄을 그린다. */
export function installPaneLinkUnderlines(terminal: Terminal, deps: PaneLinkDependencies) {
  type Underline = {
    marker: NonNullable<ReturnType<Terminal["registerMarker"]>>;
    decoration: NonNullable<ReturnType<Terminal["registerDecoration"]>>;
    buffer: IBuffer;
    x: number;
    width: number;
  };
  let underlines: Underline[] = [];
  let frame = 0;
  let disposed = false;
  const refresh = () => {
    frame = 0;
    if (disposed) return;
    const previous = underlines;
    underlines = [];
    const buffer = terminal.buffer.active;
    if (!terminal.element?.getClientRects().length) {
      for (const item of previous) {
        item.decoration.dispose();
        item.marker.dispose();
      }
      return;
    }
    const seen = new Set<string>();
    for (let row = buffer.viewportY + 1; row <= buffer.viewportY + terminal.rows; row++) {
      for (const match of findPaneLinks(terminal, row, deps)) {
        const { start, end } = match.range;
        const key = `${start.y}:${start.x}:${end.y}:${end.x}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (
          let y = Math.max(start.y, buffer.viewportY + 1);
          y <= Math.min(end.y, buffer.viewportY + terminal.rows);
          y++
        ) {
          const x = y === start.y ? start.x - 1 : 0;
          const width = (y === end.y ? end.x : terminal.cols) - x;
          const index = previous.findIndex(
            (item) =>
              item.buffer === buffer &&
              !item.marker.isDisposed &&
              !item.decoration.isDisposed &&
              item.marker.line === y - 1 &&
              item.x === x &&
              item.width === width,
          );
          if (index >= 0) {
            underlines.push(previous.splice(index, 1)[0]);
            continue;
          }
          const marker = terminal.registerMarker(y - 1 - (buffer.baseY + buffer.cursorY));
          if (!marker) continue;
          const decoration = terminal.registerDecoration({ marker, x, width });
          if (!decoration) {
            marker.dispose();
            continue;
          }
          decoration.onRender((element) => element.classList.add("pane-link-decoration"));
          underlines.push({ marker, decoration, buffer, x, width });
        }
      }
    }
    for (const item of previous) {
      item.decoration.dispose();
      item.marker.dispose();
    }
  };
  const schedule = () => {
    if (!disposed && !frame) frame = requestAnimationFrame(refresh);
  };
  const subscriptions = [
    terminal.onWriteParsed(schedule),
    terminal.onScroll(schedule),
    terminal.onResize(schedule),
    terminal.buffer.onBufferChange(schedule),
  ];
  schedule();
  return {
    refresh: schedule,
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      subscriptions.forEach((subscription) => subscription.dispose());
      underlines.forEach((item) => {
        item.decoration.dispose();
        item.marker.dispose();
      });
      underlines = [];
    },
  };
}
