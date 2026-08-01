/**
 * Unified/git diff parser for the file-viewer preview. Pure data in, pure data
 * out — no DOM — so the side-by-side renderer stays a dumb projection of this
 * structure and the tricky parsing rules can be unit-tested on their own.
 */

export type DiffLineType = "add" | "del" | "context" | "meta";

export interface DiffLine {
  type: DiffLineType;
  /** Line number in the old file; absent for additions and meta lines. */
  oldNumber?: number;
  /** Line number in the new file; absent for deletions and meta lines. */
  newNumber?: number;
  /** Content with the leading +/-/space marker removed. */
  text: string;
}

export interface DiffHunk {
  /** The raw `@@ ... @@` line, section heading included. */
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  oldPath: string;
  newPath: string;
  /** True when the diff records "Binary files ... differ" instead of hunks. */
  binary: boolean;
  /** Set when the git header declared the file added, deleted, or renamed. */
  status: "added" | "deleted" | "renamed" | "modified";
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

export interface DiffResult {
  files: DiffFile[];
  truncated: boolean;
  /** Total diff body lines in the source, even when the cap dropped some. */
  totalLines: number;
}

export const MAX_DIFF_LINES = 5_000;

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const BINARY_FILES = /^Binary files (.+) and (.+) differ$/;
const GIT_BINARY_PATCH = "GIT binary patch";
const DEV_NULL = "/dev/null";

interface HunkRange {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

export function parseUnifiedDiff(text: string, options?: { maxLines?: number }): DiffResult {
  const maxLines = options?.maxLines ?? MAX_DIFF_LINES;
  const files: DiffFile[] = [];
  const lines = splitLines(text);

  let current: DiffFile | null = null;
  // A plain diff has no `diff --git`, so `---` is the only file boundary there.
  // Remember whether the current file already consumed one.
  let sawOldMarker = false;
  let totalLines = 0;
  let emitted = 0;
  let index = 0;

  // Assignment to `current` stays at the call sites: a helper that reassigns it
  // would defeat TypeScript's narrowing of the `DiffFile | null` union below.
  const openFile = (oldPath: string, newPath: string): DiffFile => {
    const file: DiffFile = {
      oldPath,
      newPath,
      binary: false,
      status: "modified",
      hunks: [],
      additions: 0,
      deletions: 0,
    };
    files.push(file);
    sawOldMarker = false;
    return file;
  };

  while (index < lines.length) {
    const line = lines[index];

    if (line.startsWith("diff --git ")) {
      const paths = parseGitHeaderPaths(line.slice("diff --git ".length));
      current = openFile(paths.oldPath, paths.newPath);
      index++;
      continue;
    }

    if (line.startsWith("--- ")) {
      // `---` opens a file only when the previous one is finished; inside a git
      // header it just restates the path that `diff --git` already gave us.
      if (!current || sawOldMarker || current.hunks.length > 0 || current.binary) {
        current = openFile("", "");
      }
      current.oldPath = stripPathPrefix(line.slice(4), "a/");
      if (current.oldPath === DEV_NULL) current.status = "added";
      sawOldMarker = true;
      index++;
      continue;
    }

    if (line.startsWith("+++ ")) {
      const file = (current ??= openFile("", ""));
      file.newPath = stripPathPrefix(line.slice(4), "b/");
      if (file.newPath === DEV_NULL) file.status = "deleted";
      index++;
      continue;
    }

    if (current && line.startsWith("new file mode ")) {
      current.status = "added";
      index++;
      continue;
    }

    if (current && line.startsWith("deleted file mode ")) {
      current.status = "deleted";
      index++;
      continue;
    }

    if (current && line.startsWith("rename from ")) {
      current.oldPath = line.slice("rename from ".length);
      current.status = "renamed";
      index++;
      continue;
    }

    if (current && line.startsWith("rename to ")) {
      current.newPath = line.slice("rename to ".length);
      current.status = "renamed";
      index++;
      continue;
    }

    const binary = BINARY_FILES.exec(line);
    if (binary) {
      const file = (current ??= openFile(
        stripPathPrefix(binary[1], "a/"),
        stripPathPrefix(binary[2], "b/"),
      ));
      file.binary = true;
      index++;
      continue;
    }

    if (line === GIT_BINARY_PATCH) {
      const file = (current ??= openFile("", ""));
      file.binary = true;
      // The base85 payload that follows can look like anything, so skip to the
      // next file header rather than trying to interpret it.
      index++;
      while (index < lines.length && !lines[index].startsWith("diff --git ")) index++;
      continue;
    }

    const range = parseHunkRange(line);
    if (range) {
      const file = (current ??= openFile("", ""));
      const hunk: DiffHunk = { header: line, lines: [] };
      file.hunks.push(hunk);

      let oldNumber = range.oldStart;
      let newNumber = range.newStart;
      let oldRemaining = range.oldCount;
      let newRemaining = range.newCount;

      const emit = (diffLine: DiffLine): void => {
        totalLines++;
        if (emitted < maxLines) {
          hunk.lines.push(diffLine);
          emitted++;
        }
      };

      index++;
      // The declared counts — not a pattern match on the content — decide where
      // the hunk ends. Body lines may themselves start with `---`, `+++`, `@@`,
      // or `diff --git`, and pattern matching would cut the hunk short there.
      while (index < lines.length) {
        const body = lines[index];

        if (body.startsWith("\\")) {
          // "\ No newline at end of file" annotates the line above and consumes
          // no line number, so it can also appear after the counts run out.
          emit({ type: "meta", text: body });
          index++;
          continue;
        }

        if (oldRemaining <= 0 && newRemaining <= 0) break;

        const marker = body.charAt(0);
        if (marker === "+") {
          emit({ type: "add", newNumber: newNumber++, text: body.slice(1) });
          file.additions++;
          newRemaining--;
        } else if (marker === "-") {
          emit({ type: "del", oldNumber: oldNumber++, text: body.slice(1) });
          file.deletions++;
          oldRemaining--;
        } else if (marker === " " || body.length === 0) {
          // Some producers drop the trailing space on an empty context line.
          emit({
            type: "context",
            oldNumber: oldNumber++,
            newNumber: newNumber++,
            text: body.slice(1),
          });
          oldRemaining--;
          newRemaining--;
        } else {
          break; // Truncated or malformed hunk — hand the line back to the outer loop.
        }

        index++;
      }
      continue;
    }

    // Anything else (commit message, diffstat, `index`/mode lines) is metadata.
    index++;
  }

  return { files, truncated: totalLines > maxLines, totalLines };
}

function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  // A trailing newline terminates the last line rather than starting a new one.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function parseHunkRange(line: string): HunkRange | null {
  const match = HUNK_HEADER.exec(line);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    // An omitted count means exactly one line.
    oldCount: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? 1 : Number(match[4]),
  };
}

function parseGitHeaderPaths(rest: string): { oldPath: string; newPath: string } {
  // `diff --git` repeats the same path twice and paths may contain spaces, so
  // anchor on the ` b/` separator instead of splitting on whitespace.
  const separator = rest.lastIndexOf(" b/");
  if (rest.startsWith("a/") && separator > 0) {
    return { oldPath: rest.slice(2, separator), newPath: rest.slice(separator + 3) };
  }
  const space = rest.indexOf(" ");
  if (space < 0) return { oldPath: rest, newPath: rest };
  return { oldPath: rest.slice(0, space), newPath: rest.slice(space + 1) };
}

function stripPathPrefix(raw: string, prefix: string): string {
  // GNU diff appends a tab plus the file mtime after the path.
  const value = raw.split("\t")[0].trimEnd();
  if (value === DEV_NULL) return value;
  return value.startsWith(prefix) ? value.slice(prefix.length) : value;
}
