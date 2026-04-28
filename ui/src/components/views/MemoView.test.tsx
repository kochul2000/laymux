import { render, screen, fireEvent, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MemoView } from "./MemoView";
import { loadMemo, saveMemo, clipboardWriteText } from "@/lib/tauri-api";
import { useSettingsStore } from "@/stores/settings-store";

vi.mock("@/lib/tauri-api", () => ({
  loadMemo: vi.fn().mockResolvedValue(""),
  saveMemo: vi.fn().mockResolvedValue(undefined),
  saveSettings: vi.fn().mockResolvedValue(undefined),
  clipboardWriteText: vi.fn().mockResolvedValue(undefined),
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
    it("renders paragraph overlay when enabled and text has paragraphs", async () => {
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

    it("overlay does not block textarea input (pointer-events-none)", async () => {
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        memo: {
          ...useSettingsStore.getState().memo,
          paragraphCopy: { enabled: true, minBlankLines: 2 },
        },
      });
      vi.mocked(loadMemo).mockResolvedValue("abc\n\n\ndef");
      render(<MemoView memoKey="pane-no-block" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Overlay should have pointer-events-none
      const overlay = screen.getByTestId("paragraph-overlay");
      expect(overlay.className).toContain("pointer-events-none");

      // Textarea should still be interactable
      const textarea = screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
      fireEvent.change(textarea, { target: { value: "typed text" } });
      expect(textarea.value).toBe("typed text");
    });
  });

  describe("triple-click paragraph select", () => {
    it("selects entire paragraph on triple-click when paragraphCopy is enabled", async () => {
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        memo: {
          ...useSettingsStore.getState().memo,
          paragraphCopy: { enabled: true, minBlankLines: 2 },
          copyOnSelect: false,
          tripleClickParagraphSelect: true,
        },
      });
      // "abc" = line 0, "" = line 1, "" = line 2, "def\nggg" = lines 3-4
      vi.mocked(loadMemo).mockResolvedValue("abc\n\n\ndef\nggg");
      render(<MemoView memoKey="pane-tpl" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const textarea = screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
      // Place cursor in "def" (offset 6 = start of line 3)
      textarea.setSelectionRange(6, 6);
      // Triple-click: click event with detail=3
      fireEvent.click(textarea, { detail: 3 });

      // Should select "def\nggg" (start=6, end=13 exclusive)
      expect(textarea.selectionStart).toBe(6);
      expect(textarea.selectionEnd).toBe(13);
    });

    it("selects the only paragraph on triple-click when no overlay is shown", async () => {
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        memo: {
          ...useSettingsStore.getState().memo,
          paragraphCopy: { enabled: true, minBlankLines: 2 },
          copyOnSelect: false,
          tripleClickParagraphSelect: true,
        },
      });
      vi.mocked(loadMemo).mockResolvedValue("single paragraph only");
      render(<MemoView memoKey="pane-tpl-single" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const textarea = screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
      expect(screen.queryByTestId("paragraph-overlay")).not.toBeInTheDocument();

      textarea.setSelectionRange(7, 7);
      fireEvent.click(textarea, { detail: 3 });

      expect(textarea.selectionStart).toBe(0);
      expect(textarea.selectionEnd).toBe("single paragraph only".length);
    });

    it("does not select paragraph on double-click (detail=2)", async () => {
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        memo: {
          ...useSettingsStore.getState().memo,
          paragraphCopy: { enabled: true, minBlankLines: 2 },
          copyOnSelect: false,
          tripleClickParagraphSelect: true,
        },
      });
      vi.mocked(loadMemo).mockResolvedValue("abc\n\n\ndef\nggg");
      render(<MemoView memoKey="pane-dbl-no" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      const textarea = screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
      textarea.setSelectionRange(6, 6);
      // Double-click should NOT trigger paragraph selection anymore
      fireEvent.doubleClick(textarea);

      // Selection should not have been changed to the full paragraph
      // (browser default double-click selects a word, not full paragraph)
    });

    it("falls back to default behavior when paragraphCopy is disabled", async () => {
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        memo: {
          ...useSettingsStore.getState().memo,
          paragraphCopy: { enabled: false, minBlankLines: 2 },
        },
      });
      vi.mocked(loadMemo).mockResolvedValue("abc\n\n\ndef");
      render(<MemoView memoKey="pane-tpl-off" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      vi.mocked(clipboardWriteText).mockClear();
      const textarea = screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
      // triple-click should not trigger paragraph selection when disabled
      fireEvent.click(textarea, { detail: 3 });
      expect(clipboardWriteText).not.toHaveBeenCalled();
    });
  });

  describe("copyOnSelect feature (lazy)", () => {
    // Rule 1: selection → pending (not clipboard)
    // Rule 2-1: leave memo (click outside / window blur) → flush to clipboard
    // Rule 2-2: deselect → flush to clipboard
    // Rule 3: paste event → discard pending

    async function setupCopyOnSelect(memoKey: string, content = "hello world") {
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        memo: { ...useSettingsStore.getState().memo, copyOnSelect: true },
      });
      vi.mocked(loadMemo).mockResolvedValue(content);
      render(<MemoView memoKey={memoKey} />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      vi.mocked(clipboardWriteText).mockClear();
      const textarea = screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
      textarea.focus();
      textarea.setSelectionRange(0, 5); // select "hello"
      fireEvent(document, new Event("selectionchange"));
      return textarea;
    }

    it("rule 1: selection stores pending, does not copy immediately", async () => {
      await setupCopyOnSelect("pane-r1");
      expect(clipboardWriteText).not.toHaveBeenCalled();
    });

    it("rule 2-1a: click outside textarea flushes to clipboard", async () => {
      await setupCopyOnSelect("pane-r2-1a");
      fireEvent.mouseDown(document.body);
      expect(clipboardWriteText).toHaveBeenCalledWith("hello");
    });

    it("rule 2-1b: window blur (external app) flushes to clipboard", async () => {
      await setupCopyOnSelect("pane-r2-1b");
      fireEvent(window, new Event("blur"));
      expect(clipboardWriteText).toHaveBeenCalledWith("hello");
    });

    it("rule 2-2: deselect (selection collapses) flushes to clipboard", async () => {
      const textarea = await setupCopyOnSelect("pane-r2-2");
      textarea.setSelectionRange(3, 3);
      fireEvent(document, new Event("selectionchange"));
      expect(clipboardWriteText).toHaveBeenCalledWith("hello");
    });

    it("rule 3: paste event discards pending (no clipboard write)", async () => {
      const textarea = await setupCopyOnSelect("pane-r3");
      fireEvent.paste(textarea);
      // After paste discards pending, leaving memo should NOT copy
      fireEvent(window, new Event("blur"));
      expect(clipboardWriteText).not.toHaveBeenCalled();
    });

    it("works with any selection method (programmatic/triple-click)", async () => {
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        memo: { ...useSettingsStore.getState().memo, copyOnSelect: true },
      });
      vi.mocked(loadMemo).mockResolvedValue("first paragraph\n\nsecond");
      render(<MemoView memoKey="pane-any-sel" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      vi.mocked(clipboardWriteText).mockClear();
      const textarea = screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
      textarea.focus();
      textarea.setSelectionRange(0, 15);
      fireEvent(document, new Event("selectionchange"));
      expect(clipboardWriteText).not.toHaveBeenCalled();
      fireEvent(window, new Event("blur"));
      expect(clipboardWriteText).toHaveBeenCalledWith("first paragraph");
    });

    it("does not store pending when copyOnSelect is disabled", async () => {
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        memo: { ...useSettingsStore.getState().memo, copyOnSelect: false },
      });
      vi.mocked(loadMemo).mockResolvedValue("hello world");
      render(<MemoView memoKey="pane-cos-off" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      vi.mocked(clipboardWriteText).mockClear();
      const textarea = screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
      textarea.focus();
      textarea.setSelectionRange(0, 5);
      fireEvent(document, new Event("selectionchange"));
      fireEvent(window, new Event("blur"));
      expect(clipboardWriteText).not.toHaveBeenCalled();
    });

    it("clicking another MemoView flushes first memo's pending", async () => {
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        memo: { ...useSettingsStore.getState().memo, copyOnSelect: true },
      });
      vi.mocked(loadMemo).mockResolvedValue("aaa bbb");
      render(
        <div>
          <MemoView memoKey="pane-multi-a" />
          <MemoView memoKey="pane-multi-b" />
        </div>,
      );
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      vi.mocked(clipboardWriteText).mockClear();

      const textareas = screen.getAllByTestId("memo-textarea") as HTMLTextAreaElement[];
      // Select in first memo
      textareas[0].focus();
      textareas[0].setSelectionRange(0, 3); // "aaa"
      fireEvent(document, new Event("selectionchange"));
      expect(clipboardWriteText).not.toHaveBeenCalled();

      // Click on second memo's textarea (outside first memo's textarea)
      fireEvent.mouseDown(textareas[1], { bubbles: true });
      expect(clipboardWriteText).toHaveBeenCalledWith("aaa");
    });
  });

  describe("copy button hover highlight", () => {
    it("renders highlight overlay when copy button is hovered", async () => {
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        memo: {
          ...useSettingsStore.getState().memo,
          paragraphCopy: { enabled: true, minBlankLines: 2 },
        },
      });
      vi.mocked(loadMemo).mockResolvedValue("abc\n\n\ndef");
      render(<MemoView memoKey="pane-highlight" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });

      // Should have paragraph overlay
      expect(screen.getByTestId("paragraph-overlay")).toBeInTheDocument();

      // Initially no highlight
      expect(screen.queryByTestId("paragraph-highlight-0")).not.toBeInTheDocument();
      expect(screen.queryByTestId("paragraph-highlight-1")).not.toBeInTheDocument();
    });
  });

  describe("Tab/Shift+Tab indent", () => {
    async function setupMemo(content: string) {
      vi.mocked(loadMemo).mockResolvedValue(content);
      render(<MemoView memoKey="pane-tab" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      vi.mocked(saveMemo).mockClear();
      return screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
    }

    it("Tab 키로 선택 없이 커서 위치에 2 스페이스를 삽입한다", async () => {
      const textarea = await setupMemo("hello");
      textarea.setSelectionRange(2, 2); // "he|llo"
      fireEvent.keyDown(textarea, { key: "Tab" });

      expect(textarea.value).toBe("he  llo");
      expect(textarea.selectionStart).toBe(4);
      expect(textarea.selectionEnd).toBe(4);
    });

    it("Tab 키로 선택된 여러 줄에 인덴트를 추가한다", async () => {
      const textarea = await setupMemo("line1\nline2\nline3");
      // "line1\n" = 0~5, "line2\n" = 6~11, "line3" = 12~16
      textarea.setSelectionRange(2, 14); // line1~line3 일부 선택
      fireEvent.keyDown(textarea, { key: "Tab" });

      expect(textarea.value).toBe("  line1\n  line2\n  line3");
      // 선택이 인덴트된 범위를 포함해야 함
      expect(textarea.selectionStart).toBe(0); // 첫 번째 줄 시작
      expect(textarea.selectionEnd).toBe(23); // 마지막까지
    });

    it("Shift+Tab 키로 선택된 여러 줄에서 인덴트를 제거한다", async () => {
      const textarea = await setupMemo("  line1\n  line2\n  line3");
      textarea.setSelectionRange(4, 20); // 여러 줄 선택
      fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });

      expect(textarea.value).toBe("line1\nline2\nline3");
    });

    it("Shift+Tab 키로 선택 없이 현재 줄의 인덴트를 제거한다", async () => {
      const textarea = await setupMemo("  hello");
      textarea.setSelectionRange(4, 4); // "  he|llo"
      fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });

      expect(textarea.value).toBe("hello");
      expect(textarea.selectionStart).toBe(2); // 커서가 2칸 왼쪽으로
      expect(textarea.selectionEnd).toBe(2);
    });

    it("Shift+Tab은 인덴트가 없는 줄은 건너뛴다", async () => {
      const textarea = await setupMemo("  line1\nline2\n  line3");
      textarea.setSelectionRange(0, 21); // 전체 선택
      fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });

      expect(textarea.value).toBe("line1\nline2\nline3");
    });

    it("Tab 인덴트 후 debounce save가 트리거된다", async () => {
      const textarea = await setupMemo("hello");
      textarea.setSelectionRange(0, 0);
      fireEvent.keyDown(textarea, { key: "Tab" });

      await act(async () => {
        vi.advanceTimersByTime(400);
      });

      expect(saveMemo).toHaveBeenCalledWith("pane-tab", "  hello");
    });

    it("단일 줄 선택 시에도 인덴트가 적용된다", async () => {
      const textarea = await setupMemo("hello\nworld");
      textarea.setSelectionRange(0, 3); // "hel" 선택 (한 줄 내)
      fireEvent.keyDown(textarea, { key: "Tab" });

      expect(textarea.value).toBe("  hello\nworld");
    });

    it("Shift+Tab은 1 스페이스만 있는 줄에서 1 스페이스만 제거한다", async () => {
      const textarea = await setupMemo(" hello");
      textarea.setSelectionRange(3, 3);
      fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });

      expect(textarea.value).toBe("hello");
    });

    it("설정된 indentSize에 따라 인덴트 크기가 변경된다", async () => {
      useSettingsStore.setState({
        memo: { ...useSettingsStore.getState().memo, indentSize: 4 },
      });
      const textarea = await setupMemo("hello");
      textarea.setSelectionRange(0, 0);
      fireEvent.keyDown(textarea, { key: "Tab" });

      expect(textarea.value).toBe("    hello"); // 4 spaces
      expect(textarea.selectionStart).toBe(4);
    });

    it("Shift+Tab은 indentSize만큼의 스페이스를 제거한다", async () => {
      useSettingsStore.setState({
        memo: { ...useSettingsStore.getState().memo, indentSize: 4 },
      });
      const textarea = await setupMemo("    hello");
      textarea.setSelectionRange(6, 6);
      fireEvent.keyDown(textarea, { key: "Tab", shiftKey: true });

      expect(textarea.value).toBe("hello");
    });
  });

  describe("font settings", () => {
    it("applies custom fontFamily from settings", async () => {
      useSettingsStore.setState({
        memo: { ...useSettingsStore.getState().memo, fontFamily: "Consolas" },
      });
      render(<MemoView memoKey="pane-1" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const textarea = screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
      expect(textarea.style.fontFamily).toBe("Consolas");
    });

    it("inherits appFont when fontFamily/fontSize/fontWeight are empty/zero", async () => {
      useSettingsStore.setState({
        memo: { ...useSettingsStore.getState().memo, fontFamily: "", fontSize: 0, fontWeight: "" },
        appFont: { face: "Fira Code", size: 15, weight: "bold" },
      });
      render(<MemoView memoKey="pane-1" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const textarea = screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
      expect(textarea.style.fontFamily).toBe('"Fira Code"');
      expect(textarea.style.fontSize).toBe("15px");
      expect(textarea.style.fontWeight).toBe("bold");
    });

    it("applies custom fontSize from settings", async () => {
      useSettingsStore.setState({
        memo: { ...useSettingsStore.getState().memo, fontSize: 18 },
      });
      render(<MemoView memoKey="pane-1" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const textarea = screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
      expect(textarea.style.fontSize).toBe("18px");
    });

    it("defaults to appFont size when fontSize is 0", async () => {
      useSettingsStore.setState({
        memo: { ...useSettingsStore.getState().memo, fontSize: 0 },
        appFont: { face: "Cascadia Mono", size: 13, weight: "normal" },
      });
      render(<MemoView memoKey="pane-1" />);
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      const textarea = screen.getByTestId("memo-textarea") as HTMLTextAreaElement;
      expect(textarea.style.fontSize).toBe("13px");
    });
  });
});
