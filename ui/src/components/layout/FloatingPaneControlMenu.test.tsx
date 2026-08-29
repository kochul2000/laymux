import { act, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FloatingPaneControlMenu } from "./FloatingPaneControlMenu";

function rect({
  top,
  right,
  bottom,
  left,
}: {
  top: number;
  right: number;
  bottom: number;
  left: number;
}): DOMRect {
  return {
    top,
    right,
    bottom,
    left,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function Harness() {
  const paneRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <div ref={paneRef} data-testid="owner-pane">
      <button ref={triggerRef} data-testid="owner-trigger">
        controls
      </button>
      <FloatingPaneControlMenu
        openReason="manual"
        ownerHovered={true}
        onRequestClose={vi.fn()}
        triggerRef={triggerRef}
        paneRef={paneRef}
      >
        <button>first action</button>
        <button>second action</button>
      </FloatingPaneControlMenu>
    </div>
  );
}

describe("FloatingPaneControlMenu", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps a height-constrained placement stable across repeated observer frames", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    const observers: Array<{ callback: ResizeObserverCallback; instance: ResizeObserver }> = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
          observers.push({ callback, instance: this as unknown as ResizeObserver });
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(900);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      if (this.dataset.testid === "owner-pane") {
        return rect({ top: 220, right: 520, bottom: 300, left: 200 });
      }
      if (this.dataset.testid === "owner-trigger") {
        return rect({ top: 240, right: 500, bottom: 262, left: 478 });
      }
      if (this.dataset.testid === "pane-control-floating-menu") {
        const height = this.style.maxHeight ? Number.parseFloat(this.style.maxHeight) : 232;
        return rect({ top: 0, right: 300, bottom: height, left: 0 });
      }
      return rect({ top: 0, right: 0, bottom: 0, left: 0 });
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function () {
      return this.dataset.testid === "pane-control-floating-menu" ? 300 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function () {
      return this.dataset.testid === "pane-control-floating-menu" ? 230 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function () {
      if (this.dataset.testid !== "pane-control-floating-menu") return 0;
      return this.style.maxHeight ? Number.parseFloat(this.style.maxHeight) : 232;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function () {
      if (this.dataset.testid !== "pane-control-floating-menu") return 0;
      return this.style.maxHeight ? Number.parseFloat(this.style.maxHeight) - 2 : 230;
    });

    render(<Harness />);
    const flushFrames = () => {
      const pending = frames.splice(0);
      for (const callback of pending) callback(0);
    };
    act(flushFrames);

    const menu = screen.getByTestId("pane-control-floating-menu");
    await waitFor(() => expect(menu).toHaveAttribute("data-constrained", "true"));
    expect(menu.style.maxHeight).toBe("230px");

    // Model ResizeObserver seeing the already-constrained 230px border box.
    // scrollHeight is also 230px because it excludes the border, while the
    // intrinsic outer box is 232px. The placement must not oscillate.
    for (let pass = 0; pass < 2; pass += 1) {
      act(() => {
        const observer = observers[0];
        observer.callback(
          [
            {
              target: menu,
              contentRect: { width: 300, height: 230 },
            } as unknown as ResizeObserverEntry,
          ],
          observer.instance,
        );
        flushFrames();
      });
      expect(menu).toHaveAttribute("data-constrained", "true");
      expect(menu.style.maxHeight).toBe("230px");
    }
  });

  it("uses the whole positive viewport instead of creating a zero-sized tiny fallback", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(_callback: ResizeObserverCallback) {}
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(16);
    vi.spyOn(window, "innerHeight", "get").mockReturnValue(16);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function () {
      if (this.dataset.testid === "owner-pane" || this.dataset.testid === "owner-trigger") {
        return rect({ top: -10, right: 16, bottom: 26, left: 0 });
      }
      if (this.dataset.testid === "pane-control-floating-menu") {
        const width = Number.parseFloat(this.style.width || "100");
        const height = Number.parseFloat(this.style.maxHeight || "100");
        return rect({ top: 0, right: width, bottom: height, left: 0 });
      }
      return rect({ top: 0, right: 0, bottom: 0, left: 0 });
    });
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function () {
      return this.dataset.testid === "pane-control-floating-menu" ? 100 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function () {
      return this.dataset.testid === "pane-control-floating-menu" ? 100 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockImplementation(function () {
      return this.dataset.testid === "pane-control-floating-menu" ? 100 : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function () {
      return this.dataset.testid === "pane-control-floating-menu" ? 98 : 0;
    });

    render(<Harness />);
    act(() => {
      for (const callback of frames.splice(0)) callback(0);
    });

    const menu = screen.getByTestId("pane-control-floating-menu");
    await waitFor(() => expect(menu).toHaveAttribute("data-constrained", "true"));
    expect(menu.style.width).toBe("16px");
    expect(menu.style.maxWidth).toBe("16px");
    expect(menu.style.maxHeight).toBe("16px");
  });
});
