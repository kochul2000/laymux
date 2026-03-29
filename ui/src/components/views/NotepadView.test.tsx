import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NotepadView } from "./NotepadView";

describe("NotepadView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders with data-testid and textarea", () => {
    render(<NotepadView />);
    expect(screen.getByTestId("notepad-view")).toBeInTheDocument();
    expect(screen.getByTestId("notepad-textarea")).toBeInTheDocument();
  });

  it("displays initial content from prop", () => {
    render(<NotepadView content="hello world" />);
    const textarea = screen.getByTestId("notepad-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("hello world");
  });

  it("defaults to empty string when no content prop", () => {
    render(<NotepadView />);
    const textarea = screen.getByTestId("notepad-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
  });

  it("fires onContentChange after debounce on typing", () => {
    const onChange = vi.fn();
    render(<NotepadView content="" onContentChange={onChange} />);

    const textarea = screen.getByTestId("notepad-textarea");
    fireEvent.change(textarea, { target: { value: "abc" } });

    // Not fired yet (within debounce window)
    expect(onChange).not.toHaveBeenCalled();

    // Advance past debounce
    act(() => {
      vi.advanceTimersByTime(400);
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("abc");
  });

  it("textarea fills full container", () => {
    render(<NotepadView />);
    const view = screen.getByTestId("notepad-view");
    expect(view.className).toContain("h-full");
  });

  it("syncs when content prop changes externally", () => {
    const { rerender } = render(<NotepadView content="initial" />);
    const textarea = screen.getByTestId("notepad-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("initial");

    rerender(<NotepadView content="updated externally" />);
    expect(textarea.value).toBe("updated externally");
  });

  it("flushes pending content on unmount", () => {
    const onChange = vi.fn();
    const { unmount } = render(<NotepadView content="" onContentChange={onChange} />);

    const textarea = screen.getByTestId("notepad-textarea");
    fireEvent.change(textarea, { target: { value: "pending" } });

    // Unmount before debounce fires
    unmount();

    expect(onChange).toHaveBeenCalledWith("pending");
  });
});
