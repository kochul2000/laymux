/** Parsed file entry from ls output. */
export interface FileEntry {
  /** File/directory name (without trailing indicator). */
  name: string;
  /** Whether this entry is a directory. */
  isDirectory: boolean;
  /** Whether this entry is a symbolic link. */
  isSymlink: boolean;
  /** Whether this entry is executable. */
  isExecutable: boolean;
  /** Raw ls output line for display. */
  rawLine: string;
}

/** Strip ANSI escape sequences from text. */
export function stripAnsi(text: string): string {
   
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
}

/**
 * Parse ls -F style output into FileEntry array.
 * Each non-empty line becomes one entry.
 * Trailing `/` = directory, `@` = symlink, `*` = executable.
 */
export function parseLsOutput(output: string): FileEntry[] {
  const lines = output.split("\n");
  const entries: FileEntry[] = [];

  for (const rawLine of lines) {
    const stripped = stripAnsi(rawLine).trim();
    if (!stripped) continue;
    // Skip header lines from ls -l (starts with "total")
    if (stripped.startsWith("total ")) continue;

    let name = stripped;
    let isDirectory = false;
    let isSymlink = false;
    let isExecutable = false;

    // ls -F indicators: / = dir, @ = symlink, * = executable, | = FIFO, = = socket
    const lastChar = name[name.length - 1];
    if (lastChar === "/") {
      isDirectory = true;
      name = name.slice(0, -1);
    } else if (lastChar === "@") {
      isSymlink = true;
      name = name.slice(0, -1);
    } else if (lastChar === "*") {
      isExecutable = true;
      name = name.slice(0, -1);
    } else if (lastChar === "|" || lastChar === "=") {
      name = name.slice(0, -1);
    }

    if (name) {
      entries.push({ name, isDirectory, isSymlink, isExecutable, rawLine: stripped });
    }
  }

  return entries;
}
