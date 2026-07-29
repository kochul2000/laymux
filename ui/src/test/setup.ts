import "@testing-library/jest-dom/vitest";
import i18n from "@/i18n";
import { vi } from "vitest";

// Tests assert against English UI strings; pin the test locale to English so
// the default ("ko") fallback does not flip rendered labels.
void i18n.changeLanguage("en");

// jsdom reports every call to its unimplemented canvas API to stderr before
// returning null. Model the same unavailable-context result explicitly so
// tests that exercise xterm or font fallback paths do not invoke that stub.
Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  writable: true,
  value: vi.fn(() => null),
});

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
