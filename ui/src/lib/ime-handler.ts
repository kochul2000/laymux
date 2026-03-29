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
 * 2. On compositionstart, moves the textarea to a visible position near the
 *    xterm cursor so the OS IME popup appears at the correct location
 * 3. On compositionend, restores the textarea to its original offscreen position
 */

/** Options for IME handler setup */
export interface ImeHandlerOptions {
  fontSize?: number;
  fontFamily?: string;
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
 * Set up IME composition handling for an xterm.js container.
 *
 * Call this after `terminal.open(container)` so that the xterm DOM structure
 * (including .xterm-helper-textarea) exists.
 *
 * @param container - The xterm.js container element (has class "xterm")
 * @param options - Optional font settings for the composition textarea
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
    // Position the textarea within the visible area so the OS IME popup
    // appears near the terminal cursor.
    const screen = container.querySelector<HTMLElement>(".xterm-screen");
    const cursorRow = container.querySelector<HTMLElement>(".xterm-cursor-layer");

    let left = 0;
    let top = 0;

    if (screen) {
      const screenRect = screen.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();

      // Try to find the cursor position from the cursor layer or active row
      if (cursorRow) {
        const cursorRect = cursorRow.getBoundingClientRect();
        left = cursorRect.left - containerRect.left;
        top = cursorRect.top - containerRect.top;
      } else {
        // Fallback: bottom-left of the screen area
        left = screenRect.left - containerRect.left;
        top = screenRect.bottom - containerRect.top - 20; // 20px above bottom
      }
    }

    // Move textarea into visible area for IME positioning
    textarea.style.left = `${Math.max(0, left)}px`;
    textarea.style.top = `${Math.max(0, top)}px`;
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
