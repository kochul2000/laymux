# Cursor Flicker Reference

This file is the canonical in-repo entry point for terminal cursor and flicker work.

Before changing any of the following, read this document first:

- shadow cursor behavior
- overlay caret behavior
- IME/composition handling
- synchronized output (`DECSET 2026`) interaction
- `OSC 133` / `OSC 633` prompt boundary handling
- repaint/save-restore cursor handling

Current source note:

- The detailed research write-up lives at `xterm-shadow-cursor-architecture.md` in this directory.
- Treat `xterm-shadow-cursor-architecture.md` as the research truth and this file as a pointer to it.

Required workflow:

1. Read `xterm-shadow-cursor-architecture.md` before editing cursor code.
2. Keep implementation aligned with the documented model:
   - `OSC 133/633` prompt boundaries are the strongest signal.
   - `DEC 2026` and save/restore handling are supporting signals.
   - `onWriteParsed` is the authoritative buffer-sync point.
   - `onCursorMove` must not become the primary source of truth for cursor position during repaint-heavy flows.
3. Do not edit the research document during routine implementation work unless the user explicitly asks for a docs revision.
