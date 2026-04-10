# Terminal Docs

Reference notes for terminal behavior live here.

Current references:

- `fix-flicker.md`: entry point for cursor/flicker/shadow-cursor changes.
- `xterm-shadow-cursor-architecture.md`: detailed research write-up (4-layer shadow cursor strategy).
- `xterm-cursor-repaint-analysis.md`: deep analysis of why cursorX/Y drifts to footer during TUI repaints (DECSET 2026, CSI s/u, overlay sync).
