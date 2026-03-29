/**
 * IME Composition Handler for xterm.js
 *
 * Fixes Korean (and other CJK) IME composition text position in xterm.js.
 * By default, xterm.js places its helper textarea at left: -9999em (offscreen),
 * which causes the OS IME composition window to appear at the wrong location
 * (typically near the last updated text instead of the cursor position).
 *
 * This handler:
 * 1. Hides xterm's built-in composition-view (which has positioning bugs)
 * 2. On compositionstart, moves the textarea to the exact cursor cell position
 *    so the OS IME popup appears at the correct location
 * 3. On compositionend, restores the textarea to its original offscreen position
 */

import type { Terminal } from "@xterm/xterm";

/** Options for IME handler setup */
export interface ImeHandlerOptions {
  fontSize?: number;
  fontFamily?: string;
  /** xterm.js Terminal instance — used to read cursor position from buffer */
  terminal?: Terminal;
}

/** Internal state stored per container for cleanup */
interface ImeState {
  textarea: HTMLTextAreaElement;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
}

/** WeakMap to track handler state per container (allows GC when container is removed) */
const handlerMap = new WeakMap<HTMLElement, ImeState>();

/**
 * Compute the pixel position of the terminal cursor within the container.
 *
 * Uses xterm.js internal render dimensions when the Terminal instance is
 * provided. Falls back to measuring character dimensions via a temporary span
 * when internal APIs are unavailable (e.g., before first render or in tests).
 */
function getCursorPixelPosition(
  container: HTMLElement,
  terminal?: Terminal,
): { left: number; top: number } {
  if (terminal) {
    const cursorX = terminal.buffer.active.cursorX;
    const cursorY = terminal.buffer.active.cursorY;

    // Try to read cell dimensions from xterm.js internal render service.
    // This is the most accurate source, reflecting current font and DPI.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const core = (terminal as any)._core;
    const dims = core?._renderService?.dimensions;
    if (dims) {
      const cellWidth = dims.css.cell.width;
      const cellHeight = dims.css.cell.height;
      return {
        left: cursorX * cellWidth,
        top: cursorY * cellHeight,
      };
    }

    // Fallback: measure character size from the xterm-screen element
    const screen = container.querySelector<HTMLElement>(".xterm-screen");
    if (screen) {
      const screenRect = screen.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const offsetX = screenRect.left - containerRect.left;
      const offsetY = screenRect.top - containerRect.top;

      // Estimate cell size from screen dimensions and terminal cols/rows
      const cols = terminal.cols;
      const rows = terminal.rows;
      if (cols > 0 && rows > 0) {
        const cellWidth = screenRect.width / cols;
        const cellHeight = screenRect.height / rows;
        return {
          left: offsetX + cursorX * cellWidth,
          top: offsetY + cursorY * cellHeight,
        };
      }
    }
  }

  // Ultimate fallback: bottom-left of the screen area
  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (screen) {
    const screenRect = screen.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    return {
      left: screenRect.left - containerRect.left,
      top: screenRect.bottom - containerRect.top - 20,
    };
  }

  return { left: 0, top: 0 };
}

/**
 * Set up IME composition handling for an xterm.js container.
 *
 * Call this after `terminal.open(container)` so that the xterm DOM structure
 * (including .xterm-helper-textarea) exists.
 *
 * @param container - The xterm.js container element (has class "xterm")
 * @param options - Optional font settings and Terminal instance for cursor tracking
 * @returns true if setup succeeded, false if textarea was not found
 */
export function setupImeHandler(
  container: HTMLElement,
  options?: ImeHandlerOptions,
): boolean {
  const textarea = container.querySelector<HTMLTextAreaElement>(
    ".xterm-helper-textarea",
  );
  if (!textarea) return false;

  // Hide xterm's built-in composition-view — we rely on the OS IME popup
  // positioned via the textarea instead. The built-in composition-view has
  // known positioning bugs (the TODO in xterm.css says as much).
  const compositionView = container.querySelector<HTMLElement>(".composition-view");
  if (compositionView) {
    compositionView.style.display = "none";
  }

  const onCompositionStart = () => {
    const pos = getCursorPixelPosition(container, options?.terminal);

    // Move textarea into visible area for IME positioning
    textarea.style.left = `${Math.max(0, pos.left)}px`;
    textarea.style.top = `${Math.max(0, pos.top)}px`;
    textarea.style.zIndex = "10";
    textarea.style.width = "1px";
    textarea.style.height = "1em";

    // Apply font settings so IME popup matches terminal text
    if (options?.fontSize) {
      textarea.style.fontSize = `${options.fontSize}px`;
    }
    if (options?.fontFamily) {
      textarea.style.fontFamily = options.fontFamily;
    }
  };

  const onCompositionEnd = () => {
    // Restore textarea to offscreen position
    textarea.style.left = "-9999em";
    textarea.style.top = "0";
    textarea.style.zIndex = "-5";
    textarea.style.width = "0";
    textarea.style.height = "0";
    textarea.style.fontSize = "";
    textarea.style.fontFamily = "";
  };

  textarea.addEventListener("compositionstart", onCompositionStart);
  textarea.addEventListener("compositionend", onCompositionEnd);

  handlerMap.set(container, { textarea, onCompositionStart, onCompositionEnd });

  return true;
}

/**
 * Remove IME composition event listeners from an xterm.js container.
 *
 * Call this during terminal cleanup/dispose.
 *
 * @param container - The xterm.js container element
 */
export function disposeImeHandler(container: HTMLElement): void {
  const state = handlerMap.get(container);
  if (!state) return;

  state.textarea.removeEventListener("compositionstart", state.onCompositionStart);
  state.textarea.removeEventListener("compositionend", state.onCompositionEnd);

  handlerMap.delete(container);
}
