import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoView } from "./MemoView";
import { loadMemo, saveMemo } from "@/lib/tauri-api";
import { useSettingsStore } from "@/stores/settings-store";

// Mock clipboard API
Object.assign(navigator, {
  clipboard: {
    writeText: vi.fn().mockResolvedValue(undefined),
  },
});

vi.mock("@/lib/tauri-api", () => ({
  loadMemo: vi.fn().mockResolvedValue(""),
  saveMemo: vi.fn().mockResolvedValue(undefined),
  saveSettings: vi.fn().mockResolvedValue(undefined),
}));

describe("MemoView", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(loadMemo).mockClear().mockResolvedValue("");
    vi.mocked(saveMemo).mockClear().mockResolvedValue(undefined);
    useSettingsStore.setState(useSettingsStore.getInitialState());
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders with data-testid and textarea", () => {
    render(<MemoView memoKey="pane-1" />);
    expect(screen.getByTestId("memo-view")).toBeInTheDocument();
    expect(screen.getByTestId("memo-textarea")).toBeInTheDocument();
  });

  it("loads content from memo.json by key on mount", async () => {
    vi.mocked(loadMemo).mockResolvedValue("saved text");
    render(<MemoView memoKey="pane-42" />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const textarea = screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("saved text");
    expect(loadMemo).toHaveBeenCalledWith("pane-42");
  });

  it("defaults to empty string when key has no content", async () => {
    render(<MemoView memoKey="pane-1" />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
    const textarea = screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
  });

  it("saves content to memo.json with key after debounce", async () => {
    render(<MemoView memoKey="pane-7" />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const textarea = screen.getByTestId("memo-textarea");
    fireEvent.change(textarea, { target: { value: "abc" } });

    expect(saveMemo).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(400);
    });

    expect(saveMemo).toHaveBeenCalledTimes(1);
    expect(saveMemo).toHaveBeenCalledWith("pane-7", "abc");
  });

  it("textarea fills full container", () => {
    render(<MemoView memoKey="pane-1" />);
    const view = screen.getByTestId("memo-view");
    expect(view.className).toContain("h-full");
  });

  it("flushes pending content to file on unmount", async () => {
    const { unmount } = render(<MemoView memoKey="pane-3" />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const textarea = screen.getByTestId("memo-textarea");
    fireEvent.change(textarea, { target: { value: "pending" } });

    unmount();

    expect(saveMemo).toHaveBeenCalledWith("pane-3", "pending");
  });

  it("applies memo padding from settings", () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      memo: {
        paddingTop: 20,
        paddingRight: 10,
        paddingBottom: 5,
        paddingLeft: 15,
        paragraphCopy: { enabled: true, minBlankLines: 2 },
        copyOnSelect: false,
      },
    });

    render(<MemoView memoKey="pane-pad" />);
    const textarea = screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
    expect(textarea.style.padding).toBe("20px 10px 5px 15px");
  });

  it("uses default padding (8px) when no memo settings customized", () => {
    render(<MemoView memoKey="pane-default-pad" />);
    const textarea = screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
    expect(textarea.style.padding).toBe("8px");
  });

  it("renders empty when loadMemo fails", async () => {
    vi.mocked(loadMemo).mockRejectedValue(new Error("disk error"));
    render(<MemoView memoKey="pane-1" />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const textarea = screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
    expect(textarea.value).toBe("");
  });

  describe("paragraph copy feature", () => {
    it("renders paragraph copy buttons when enabled and text has paragraphs", async () => {
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        memo: {
          ...useSettingsStore.getState().memo,
          paragraphCopy: { enabled: true, minBlankLines: 2 },
        },
      });
      vi.mocked(loadMemo).mockResolvedValue("abc\n\n\ndef");
      render(<MemoView memoKey="pane-para" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Should render paragraph overlay container
      const overlay = screen.getByTestId("paragraph-overlay");
      expect(overlay).toBeInTheDocument();

      // Should have 2 paragraph regions
      const regions = screen.getAllByTestId(/^paragraph-region-/);
      expect(regions).toHaveLength(2);
    });

    it("does not render paragraph overlay when feature is disabled", async () => {
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        memo: {
          ...useSettingsStore.getState().memo,
          paragraphCopy: { enabled: false, minBlankLines: 2 },
        },
      });
      vi.mocked(loadMemo).mockResolvedValue("abc\n\n\ndef");
      render(<MemoView memoKey="pane-disabled" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(screen.queryByTestId("paragraph-overlay")).not.toBeInTheDocument();
    });

    it("does not render paragraph overlay when only one paragraph exists", async () => {
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        memo: {
          ...useSettingsStore.getState().memo,
          paragraphCopy: { enabled: true, minBlankLines: 2 },
        },
      });
      vi.mocked(loadMemo).mockResolvedValue("abc\ndef");
      render(<MemoView memoKey="pane-single" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      expect(screen.queryByTestId("paragraph-overlay")).not.toBeInTheDocument();
    });
  });

  describe("copyOnSelect feature", () => {
    it("copies selected text on mouseup when enabled", async () => {
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        memo: {
          ...useSettingsStore.getState().memo,
          copyOnSelect: true,
        },
      });
      vi.mocked(loadMemo).mockResolvedValue("hello world");
      render(<MemoView memoKey="pane-cos" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Simulate text selection
      const selection = {
        toString: () => "hello",
        removeAllRanges: vi.fn(),
      };
      vi.spyOn(window, "getSelection").mockReturnValue(selection as unknown as Selection);

      const textarea = screen.getByTestId("memo-textarea");
      fireEvent.mouseUp(textarea);

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello");
    });

    it("does not copy on mouseup when copyOnSelect is disabled", async () => {
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        memo: {
          ...useSettingsStore.getState().memo,
          copyOnSelect: false,
        },
      });
      vi.mocked(loadMemo).mockResolvedValue("hello world");
      render(<MemoView memoKey="pane-cos-off" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const selection = {
        toString: () => "hello",
        removeAllRanges: vi.fn(),
      };
      vi.spyOn(window, "getSelection").mockReturnValue(selection as unknown as Selection);

      vi.mocked(navigator.clipboard.writeText).mockClear();
      const textarea = screen.getByTestId("memo-textarea");
      fireEvent.mouseUp(textarea);

      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    });

    it("does not copy when no text is selected", async () => {
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        memo: {
          ...useSettingsStore.getState().memo,
          copyOnSelect: true,
        },
      });
      vi.mocked(loadMemo).mockResolvedValue("hello world");
      render(<MemoView memoKey="pane-cos-empty" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const selection = {
        toString: () => "",
        removeAllRanges: vi.fn(),
      };
      vi.spyOn(window, "getSelection").mockReturnValue(selection as unknown as Selection);

      vi.mocked(navigator.clipboard.writeText).mockClear();
      const textarea = screen.getByTestId("memo-textarea");
      fireEvent.mouseUp(textarea);

      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    });
  });
});
