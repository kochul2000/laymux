import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { setupImeHandler, disposeImeHandler, updateImeHandlerOptions } from "./ime-handler";

describe("ime-handler", () => {
  let container: HTMLDivElement;
  let textarea: HTMLTextAreaElement;
  let screenElement: HTMLDivElement;

  beforeEach(() => {
    // Build a minimal xterm-like DOM structure
    container = document.createElement("div");
    container.classList.add("xterm");

    // xterm-helper-textarea (hidden offscreen by default)
    const helpers = document.createElement("div");
    helpers.classList.add("xterm-helpers");
    textarea = document.createElement("textarea");
    textarea.classList.add("xterm-helper-textarea");
    textarea.style.position = "absolute";
    textarea.style.left = "-9999em";
    textarea.style.top = "0";
    helpers.appendChild(textarea);
    container.appendChild(helpers);

    // xterm-screen (canvas area)
    screenElement = document.createElement("div");
    screenElement.classList.add("xterm-screen");
    container.appendChild(screenElement);

    // composition-view
    const compositionView = document.createElement("div");
    compositionView.classList.add("composition-view");
    container.appendChild(compositionView);

    document.body.appendChild(container);
  });

  afterEach(() => {
    disposeImeHandler(container);
    document.body.removeChild(container);
  });

  it("finds and returns the textarea element from the xterm container", () => {
    const result = setupImeHandler(container);
    expect(result).toBe(true);
  });

  it("returns false when no textarea is found", () => {
    // Remove the textarea
    textarea.remove();
    const result = setupImeHandler(container);
    expect(result).toBe(false);
  });

  it("hides the composition-view via CSS to prevent duplicate display", () => {
    setupImeHandler(container);
    const compositionView = container.querySelector(".composition-view") as HTMLElement;
    // The composition-view should be hidden since we handle IME ourselves
    expect(compositionView.style.display).toBe("none");
  });

  it("moves textarea near cursor position on compositionstart", () => {
    setupImeHandler(container);

    // Mock getBoundingClientRect for screen element
    vi.spyOn(screenElement, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 50,
      right: 900,
      bottom: 450,
      width: 800,
      height: 400,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    });

    // Dispatch compositionstart on textarea
    const event = new Event("compositionstart", { bubbles: true });
    textarea.dispatchEvent(event);

    // Textarea should no longer be at -9999em
    expect(textarea.style.left).not.toBe("-9999em");
  });

  it("resets textarea position on compositionend", () => {
    setupImeHandler(container);

    // Trigger compositionstart first
    textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));

    // Then compositionend
    textarea.dispatchEvent(new Event("compositionend", { bubbles: true }));

    // Textarea should be moved back offscreen
    expect(textarea.style.left).toBe("-9999em");
  });

  it("makes textarea visible during composition for IME popup positioning", () => {
    setupImeHandler(container);

    textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));

    // During composition, textarea opacity should allow IME to position correctly
    // The textarea needs to be "visible" to the IME system (not opacity: 0)
    expect(textarea.style.zIndex).not.toBe("-5");
  });

  it("restores textarea styles after composition ends", () => {
    setupImeHandler(container);

    textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    textarea.dispatchEvent(new Event("compositionend", { bubbles: true }));

    // After composition, textarea should be hidden again
    expect(textarea.style.left).toBe("-9999em");
    expect(textarea.style.zIndex).toBe("-5");
  });

  it("cleans up event listeners on dispose", () => {
    setupImeHandler(container);

    const removeListenerSpy = vi.spyOn(textarea, "removeEventListener");
    disposeImeHandler(container);

    // Should have removed compositionstart and compositionend listeners
    expect(removeListenerSpy).toHaveBeenCalledWith("compositionstart", expect.any(Function));
    expect(removeListenerSpy).toHaveBeenCalledWith("compositionend", expect.any(Function));
  });

  it("positions textarea at bottom-left of screen element as fallback", () => {
    setupImeHandler(container);

    // Mock screen element bounding rect
    vi.spyOn(screenElement, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 50,
      right: 900,
      bottom: 450,
      width: 800,
      height: 400,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    });

    // Mock container bounding rect
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 50,
      right: 900,
      bottom: 450,
      width: 800,
      height: 400,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    });

    textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));

    // The textarea should be positioned within the container (not at -9999em)
    const left = parseInt(textarea.style.left, 10);
    expect(left).toBeGreaterThanOrEqual(0);
  });

  it("applies correct font styling to textarea during composition", () => {
    setupImeHandler(container, { fontSize: 16, fontFamily: "'Cascadia Mono', monospace" });

    textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));

    expect(textarea.style.fontSize).toBe("16px");
    // Browser DOM normalizes single quotes to double quotes in fontFamily
    expect(textarea.style.fontFamily).toContain("Cascadia Mono");
  });

  it("uses terminal buffer cursor position with render dimensions for exact positioning", () => {
    // Create a mock Terminal instance with buffer and render service
    const mockTerminal = {
      buffer: {
        active: { cursorX: 10, cursorY: 5 },
      },
      cols: 80,
      rows: 24,
      _core: {
        _renderService: {
          dimensions: {
            css: {
              cell: { width: 8.5, height: 17 },
            },
          },
        },
      },
    };

    setupImeHandler(container, {
      fontSize: 14,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      terminal: mockTerminal as any,
    });

    textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));

    // Expected: cursorX * cellWidth = 10 * 8.5 = 85
    // Expected: cursorY * cellHeight = 5 * 17 = 85
    expect(textarea.style.left).toBe("85px");
    expect(textarea.style.top).toBe("85px");
  });

  it("falls back to cols/rows estimation when render dimensions unavailable", () => {
    const mockTerminal = {
      buffer: {
        active: { cursorX: 5, cursorY: 2 },
      },
      cols: 80,
      rows: 24,
      _core: {},
    };

    // Mock screen and container bounding rects for fallback calculation
    vi.spyOn(screenElement, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 50,
      right: 900,
      bottom: 530,
      width: 800,
      height: 480,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    });
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({
      left: 100,
      top: 50,
      right: 900,
      bottom: 530,
      width: 800,
      height: 480,
      x: 100,
      y: 50,
      toJSON: () => ({}),
    });

    setupImeHandler(container, {
      fontSize: 14,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      terminal: mockTerminal as any,
    });

    textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));

    // cellWidth = 800/80 = 10, cellHeight = 480/24 = 20
    // left = 0 (screen offset) + 5*10 = 50, top = 0 + 2*20 = 40
    expect(textarea.style.left).toBe("50px");
    expect(textarea.style.top).toBe("40px");
  });

  it("does not dispose twice (idempotent)", () => {
    setupImeHandler(container);
    disposeImeHandler(container);
    // Second dispose should be a no-op (no error)
    disposeImeHandler(container);
  });

  // --- Issue #2: updateImeHandlerOptions for hot font reload ---

  it("updates font options without re-setup via updateImeHandlerOptions", () => {
    setupImeHandler(container, { fontSize: 14, fontFamily: "'Consolas', monospace" });

    // Update font options
    updateImeHandlerOptions(container, { fontSize: 20, fontFamily: "'JetBrains Mono', monospace" });

    // Trigger composition to verify new font is applied
    textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));

    expect(textarea.style.fontSize).toBe("20px");
    expect(textarea.style.fontFamily).toContain("JetBrains Mono");
  });

  it("updateImeHandlerOptions is a no-op if handler was not set up", () => {
    // Should not throw
    updateImeHandlerOptions(container, { fontSize: 20 });
  });

  // --- Issue #4: compositionupdate repositions textarea ---

  it("repositions textarea on compositionupdate when cursor moves", () => {
    const mockTerminal = {
      buffer: {
        active: { cursorX: 10, cursorY: 5 },
      },
      cols: 80,
      rows: 24,
      _core: {
        _renderService: {
          dimensions: {
            css: {
              cell: { width: 8.5, height: 17 },
            },
          },
        },
      },
    };

    setupImeHandler(container, {
      fontSize: 14,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      terminal: mockTerminal as any,
    });

    textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));

    // Cursor moved during composition
    mockTerminal.buffer.active.cursorX = 15;
    mockTerminal.buffer.active.cursorY = 6;

    textarea.dispatchEvent(new Event("compositionupdate", { bubbles: true }));

    // Expected: 15 * 8.5 = 127.5, 6 * 17 = 102
    expect(textarea.style.left).toBe("127.5px");
    expect(textarea.style.top).toBe("102px");
  });

  it("cleans up compositionupdate listener on dispose", () => {
    setupImeHandler(container);

    const removeListenerSpy = vi.spyOn(textarea, "removeEventListener");
    disposeImeHandler(container);

    expect(removeListenerSpy).toHaveBeenCalledWith("compositionupdate", expect.any(Function));
  });
});
