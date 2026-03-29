import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDraft } from "./useDraft";

describe("useDraft", () => {
  it("initializes draft from storeValue", () => {
    const { result } = renderHook(() => useDraft("hello"));
    expect(result.current.draft).toBe("hello");
    expect(result.current.dirty).toBe(false);
  });

  it("setDraft updates draft and sets dirty to true", () => {
    const { result } = renderHook(() => useDraft("hello"));
    act(() => {
      result.current.setDraft("world");
    });
    expect(result.current.draft).toBe("world");
    expect(result.current.dirty).toBe(true);
  });

  it("resets draft when storeValue changes externally", () => {
    let storeValue = "initial";
    const { result, rerender } = renderHook(() => useDraft(storeValue));

    // User edits draft
    act(() => {
      result.current.setDraft("user edit");
    });
    expect(result.current.draft).toBe("user edit");
    expect(result.current.dirty).toBe(true);

    // External change: storeValue updates
    storeValue = "external update";
    rerender();

    // Draft should be reset to new storeValue (Windows Terminal behavior)
    expect(result.current.draft).toBe("external update");
    expect(result.current.dirty).toBe(false);
  });

  it("resets dirty to false when storeValue changes", () => {
    let storeValue = "a";
    const { result, rerender } = renderHook(() => useDraft(storeValue));

    act(() => {
      result.current.setDraft("modified");
    });
    expect(result.current.dirty).toBe(true);

    storeValue = "b";
    rerender();

    expect(result.current.dirty).toBe(false);
  });

  it("works with object storeValue (by reference)", () => {
    const obj1 = { name: "Alice", age: 30 };
    const obj2 = { name: "Bob", age: 25 };

    let storeValue = obj1;
    const { result, rerender } = renderHook(() => useDraft(storeValue));

    expect(result.current.draft).toBe(obj1);
    expect(result.current.dirty).toBe(false);

    // User edits
    act(() => {
      result.current.setDraft({ name: "Alice edited", age: 31 });
    });
    expect(result.current.dirty).toBe(true);

    // External change
    storeValue = obj2;
    rerender();

    expect(result.current.draft).toBe(obj2);
    expect(result.current.dirty).toBe(false);
  });

  it("does not reset draft when storeValue stays the same", () => {
    const storeValue = "stable";
    const { result, rerender } = renderHook(() => useDraft(storeValue));

    act(() => {
      result.current.setDraft("user edit");
    });
    expect(result.current.draft).toBe("user edit");
    expect(result.current.dirty).toBe(true);

    // Rerender with same storeValue
    rerender();

    // Draft should NOT be reset since storeValue didn't change
    expect(result.current.draft).toBe("user edit");
    expect(result.current.dirty).toBe(true);
  });

  it("resetDraft manually resets to current storeValue", () => {
    const { result } = renderHook(() => useDraft("original"));

    act(() => {
      result.current.setDraft("modified");
    });
    expect(result.current.dirty).toBe(true);

    act(() => {
      result.current.resetDraft();
    });

    expect(result.current.draft).toBe("original");
    expect(result.current.dirty).toBe(false);
  });

  it("works with array storeValue", () => {
    const arr1 = [1, 2, 3];
    const arr2 = [4, 5, 6];

    let storeValue = arr1;
    const { result, rerender } = renderHook(() => useDraft(storeValue));

    expect(result.current.draft).toBe(arr1);

    storeValue = arr2;
    rerender();

    expect(result.current.draft).toBe(arr2);
    expect(result.current.dirty).toBe(false);
  });
});
