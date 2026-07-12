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

      const matches = findPrTokens(bufLine.translateToString());
      if (matches.length === 0) {
        callback(undefined);
        return;
      }

      const links: ILink[] = matches.map((match) => ({
        range: {
          start: { x: match.startCol, y: bufferLineNumber },
          end: { x: match.endCol, y: bufferLineNumber },
        },
        text: `#${match.number}`,
        activate: () => onClickPr(match.number),
      }));

      callback(links);
    },
  };
}
