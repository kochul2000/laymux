# Docs

This directory is the Git-tracked home for reference documents that should guide implementation work.

Rules:

- If a behavior has a reference doc here, read it before editing the corresponding code.
- Do not rewrite research reference docs during normal implementation work unless the user explicitly asks for a docs update.
- Prefer adding new implementation reference notes under a topical subdirectory instead of leaving them only at repo root.

Current references:

- `docs/terminal/fix-flicker.md`: canonical entry point for terminal cursor, shadow cursor, IME/composition, and flicker-related work.
- `docs/terminal/xterm-shadow-cursor-architecture.md`: detailed 4-layer shadow cursor research.
- `docs/terminal/xterm-cursor-repaint-analysis.md`: deep analysis of cursorX/Y drift during TUI repaints.
