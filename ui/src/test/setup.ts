import "@testing-library/jest-dom/vitest";

// Polyfill ResizeObserver for jsdom — fires callback immediately with non-zero dimensions
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserver {
    private callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
    }
    observe(target: Element) {
      // Simulate a non-zero contentRect so xterm.js terminal.open() works in tests
      setTimeout(() => {
        this.callback(
          [{ target, contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry],
          this,
        );
      }, 0);
    }
    unobserve() {}
    disconnect() {}
  };
}
