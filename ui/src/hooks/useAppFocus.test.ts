import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { act } from "@testing-library/react";
import { useUiStore } from "@/stores/ui-store";
import { useAppFocus } from "./useAppFocus";

describe("useAppFocus", () => {
  beforeEach(() => {
    useUiStore.setState(useUiStore.getInitialState());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sets isAppFocused to false on window blur", () => {
    renderHook(() => useAppFocus());

    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(useUiStore.getState().isAppFocused).toBe(false);
  });

  it("sets isAppFocused to true on window focus", () => {
    useUiStore.setState({ isAppFocused: false });
    renderHook(() => useAppFocus());

    act(() => {
      window.dispatchEvent(new Event("focus"));
    });

    expect(useUiStore.getState().isAppFocused).toBe(true);
  });

  it("cleans up event listeners on unmount", () => {
    const removeSpy = vi.spyOn(window, "removeEventListener");
    const { unmount } = renderHook(() => useAppFocus());

    unmount();

    const removedEvents = removeSpy.mock.calls.map((call) => call[0]);
    expect(removedEvents).toContain("focus");
    expect(removedEvents).toContain("blur");
  });
});
