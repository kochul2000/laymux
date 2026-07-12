/**
 * Custom xterm.js link provider that turns bare `#123` issue/PR references
 * into clickable links.
 *
 * Codex CLI emits `#123` wrapped in OSC 8 hyperlinks, so xterm makes them
 * clickable natively. Claude Code prints `#123` as *plain text*, so there is
 * no link to click. This provider detects the `#number` pattern in terminal
 * output and, when the pane's git remote resolves to a GitHub repository,
 * opens `{repoBase}/issues/{number}` in the browser. GitHub redirects the
 * `/issues/{n}` URL to `/pull/{n}` automatically, so both issues and PRs work.
 *
 * Only registered as an *additional* provider — plain URLs (WebLinksAddon),
 * OSC 8 links, indented hard-wrapped URLs, and path links keep working. When
 * the pane is not a GitHub repository, `getRepoBase()` returns null and no
 * link is produced. (Issue #439)
 */

import type { Terminal, ILinkProvider, ILink } from "@xterm/xterm";

/** A matched `#number` token on a single line (columns are 1-based, inclusive). */
export interface PrMatch {
  number: number;
  startCol: number;
  endCol: number;
}

/**
 * Minimal xterm cell shape needed for offset→column mapping (subset of
 * `IBufferCell`): `chars` = `getCell().getChars()`, `width` =
 * `getCell().getWidth()` (0 = trailing half of a wide char, 1 = normal,
 * 2 = leading half of a wide char).
 */
export interface CellInfo {
  chars: string;
  width: number;
}

/**
 * Reconstruct a terminal line's string together with a UTF-16-offset →
 * 1-based-cell-column map from its cells.
 *
 * `findPrTokens` returns UTF-16 string offsets, but `ILink.range.x` is an
 * xterm *cell* column. A wide char (CJK/emoji) occupies 2 cells while
 * contributing only 1–2 UTF-16 code units, so string offset and cell column
 * diverge whenever a wide char precedes a token. Building the string and the
 * column map in the same pass guarantees they stay consistent (issue #441).
 *
 * `columns[o]` is the 1-based cell column of the character at string offset
 * `o`. Empty/unset cells emit a single space (matching `translateToString`),
 * and width-0 trailing cells are skipped (their char lives in the lead cell).
 */
export function reconstructLine(cells: CellInfo[]): { text: string; columns: number[] } {
  let text = "";
  const columns: number[] = [];
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    if (cell.width === 0) continue; // trailing half of a wide char — not emitted
    const emitted = cell.chars.length > 0 ? cell.chars : " ";
    text += emitted;
    for (let k = 0; k < emitted.length; k++) columns.push(i + 1); // 1-based column
  }
  return { text, columns };
}

// `#` must not be preceded by a word char (avoids `abc#12`, `v1.2#3`), must be
// followed by one or more digits, and the digit run must end on a word
// boundary (avoids `#1a2b3c` hex-ish tokens; `#fff` fails the `\d` requirement).
const PR_TOKEN_RE = /(?<!\w)#(\d+)\b/g;

/**
 * Find every `#number` token in a single line of terminal text.
 *
 * Pure function — no terminal/DOM access — so the matching and column math can
 * be unit-tested directly (see indented-link-provider for the same split).
 */
export function findPrTokens(text: string): PrMatch[] {
  const matches: PrMatch[] = [];
  // Reset lastIndex: the regex is module-level and stateful with the /g flag.
  PR_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PR_TOKEN_RE.exec(text)) !== null) {
    const number = Number.parseInt(m[1], 10);
    if (!Number.isSafeInteger(number)) continue;
    const startCol = m.index + 1; // 1-based column of `#`
    const endCol = m.index + m[0].length; // 1-based, inclusive (covers last digit)
    matches.push({ number, startCol, endCol });
  }
  return matches;
}

/** xterm buffer line — the subset used here (getCell/length). */
interface BufferLineLike {
  length: number;
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
}

/**
 * Snapshot a buffer line's cells into plain `CellInfo[]`. xterm may reuse the
 * cell object across `getCell` calls, so chars/width are read eagerly.
 */
function readLineCells(line: BufferLineLike): CellInfo[] {
  const cells: CellInfo[] = [];
  for (let i = 0; i < line.length; i++) {
    const cell = line.getCell(i);
    if (!cell) {
      cells.push({ chars: " ", width: 1 });
      continue;
    }
    cells.push({ chars: cell.getChars(), width: cell.getWidth() });
  }
  return cells;
}

/**
 * Create an ILinkProvider for bare `#number` issue/PR references.
 *
 * @param getRepoBase - Returns the pane's GitHub base URL
 *   (`https://github.com/{owner}/{repo}`) or null when the pane is not a
 *   GitHub repo. Read synchronously on each provideLinks call so the provider
 *   tracks CWD changes without re-registration.
 * @param onClickPr - Invoked with the matched number when a link is activated.
 */
export function createPrLinkProvider(
  terminal: Terminal,
  onClickPr: (prNumber: number) => void,
  getRepoBase: () => string | null,
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      // No GitHub remote → no links (natural off-switch for non-GitHub repos).
      const repoBase = getRepoBase();
      if (!repoBase) {
        callback(undefined);
        return;
      }

      const bufLine = terminal.buffer.active.getLine(bufferLineNumber - 1); // 0-based
      if (!bufLine) {
        callback(undefined);
        return;
      }

      // Reconstruct text + offset→cell-column map in one pass so wide chars
      // (CJK/emoji) don't shift the underline/hit area (#441).
      const { text, columns } = reconstructLine(readLineCells(bufLine));
      const matches = findPrTokens(text);
      if (matches.length === 0) {
        callback(undefined);
        return;
      }

      const links: ILink[] = [];
      for (const match of matches) {
        // token cols are 1-based string offsets; map to cell columns.
        const startX = columns[match.startCol - 1];
        const endX = columns[match.endCol - 1];
        if (startX === undefined || endX === undefined) continue; // out-of-range guard
        links.push({
          range: {
            start: { x: startX, y: bufferLineNumber },
            end: { x: endX, y: bufferLineNumber },
          },
          text: `#${match.number}`,
          activate: () => onClickPr(match.number),
        });
      }

      callback(links.length > 0 ? links : undefined);
    },
  };
}
