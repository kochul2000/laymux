import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ExitFade } from "./ExitFade";

describe("ExitFade", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders children immediately (no fade-in delay) when shown", () => {
    render(
      <ExitFade show data-testid="fade">
        <span data-testid="child">hi</span>
      </ExitFade>,
    );
    const el = screen.getByTestId("fade");
    expect(screen.getByTestId("child")).toBeInTheDocument();
    expect(el.style.opacity).toBe("1");
  });

  it("renders nothing when show starts false", () => {
    render(
      <ExitFade show={false} data-testid="fade">
        <span>hi</span>
      </ExitFade>,
    );
    expect(screen.queryByTestId("fade")).not.toBeInTheDocument();
  });

  it("lingers with opacity 0 on exit, then unmounts after durationMs", () => {
    const { rerender } = render(
      <ExitFade show durationMs={200} data-testid="fade">
        <span data-testid="child">hi</span>
      </ExitFade>,
    );
    expect(screen.getByTestId("fade").style.opacity).toBe("1");

    // Hide: element stays mounted but fades to opacity 0.
    rerender(
      <ExitFade show={false} durationMs={200} data-testid="fade">
        <span data-testid="child">hi</span>
      </ExitFade>,
    );
    const el = screen.getByTestId("fade");
    expect(el).toBeInTheDocument();
    expect(el.style.opacity).toBe("0");
    expect(el.style.transition).toContain("opacity");

    // Before the duration elapses it is still mounted.
    act(() => {
      vi.advanceTimersByTime(150);
    });
    expect(screen.queryByTestId("fade")).toBeInTheDocument();

    // After the duration it unmounts.
    act(() => {
      vi.advanceTimersByTime(60);
    });
    expect(screen.queryByTestId("fade")).not.toBeInTheDocument();
  });

  it("freezes last visible children during the exit fade", () => {
    const { rerender } = render(
      <ExitFade show data-testid="fade">
        <span data-testid="content">5</span>
      </ExitFade>,
    );
    // Condition that drives both `show` and the content goes away at once:
    // the frozen snapshot should keep the last value visible while fading.
    rerender(
      <ExitFade show={false} data-testid="fade">
        {null}
      </ExitFade>,
    );
    expect(screen.getByTestId("content")).toHaveTextContent("5");
  });

  it("cancels a pending unmount if shown again mid-fade", () => {
    const { rerender } = render(
      <ExitFade show durationMs={200} data-testid="fade">
        <span>hi</span>
      </ExitFade>,
    );
    rerender(
      <ExitFade show={false} durationMs={200} data-testid="fade">
        <span>hi</span>
      </ExitFade>,
    );
    act(() => {
      vi.advanceTimersByTime(100);
    });
    // Re-show before unmount timer fires.
    rerender(
      <ExitFade show durationMs={200} data-testid="fade">
        <span>hi</span>
      </ExitFade>,
    );
    act(() => {
      vi.advanceTimersByTime(200);
    });
    const el = screen.getByTestId("fade");
    expect(el).toBeInTheDocument();
    expect(el.style.opacity).toBe("1");
  });
});
