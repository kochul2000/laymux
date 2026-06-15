import "@testing-library/jest-dom/vitest";
import i18n from "@/i18n";

// Tests assert against English UI strings; pin the test locale to English so
// the default ("ko") fallback does not flip rendered labels.
void i18n.changeLanguage("en");

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
