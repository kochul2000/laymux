import { useState } from "react";
import { cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TerminalInputComposer, type TerminalInputComposerLabels } from "./TerminalInputComposer";
import type { InputMode } from "@/lib/terminal-input-composer-state";

const labels: TerminalInputComposerLabels = {
  editor: "Terminal input",
  placeholder: "Type before sending",
  resize: "Resize input area",
  history: "Recent inputs",
  autocomplete: "Input suggestions",
};

function renderComposer(
  overrides: Partial<React.ComponentProps<typeof TerminalInputComposer>> = {},
) {
  const props: React.ComponentProps<typeof TerminalInputComposer> = {
    mode: "composer",
    text: "draft",
    labels,
    onTextChange: vi.fn(),
    onSend: vi.fn(),
    testId: "composer",
    ...overrides,
  };
  render(<TerminalInputComposer {...props} />);
  return props;
}

describe("TerminalInputComposer", () => {
  it("renders nothing but an inert host in Direct mode", () => {
    renderComposer({ mode: "direct" });

    const host = screen.getByTestId("composer");
    expect(host).toHaveAttribute("data-mode", "direct");
    expect(host).toHaveAttribute("hidden");
    expect(screen.queryByRole("textbox", { name: "Terminal input" })).not.toBeInTheDocument();
  });

  it("renders the controlled draft and submits on plain Enter (no Send button)", async () => {
    const user = userEvent.setup();
    const onTextChange = vi.fn();
    const onSend = vi.fn();
    renderComposer({ onTextChange, onSend });

    const textarea = screen.getByRole("textbox", { name: "Terminal input" });
    expect(textarea).toHaveValue("draft");
    expect(textarea).toHaveAttribute("placeholder", "Type before sending");
    // The editor is the whole surface — no separate action button steals space.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByTestId("composer")).toHaveAttribute("data-can-send", "true");

    await user.type(textarea, "!");
    expect(onTextChange).toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("treats plain Enter as Send and leaves Shift+Enter to the textarea", () => {
    const onSend = vi.fn();
    renderComposer({ onSend });
    const textarea = screen.getByRole("textbox", { name: "Terminal input" });

    const sendEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(sendEvent);
    expect(sendEvent.defaultPrevented).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);

    const newlineEvent = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(newlineEvent);
    expect(newlineEvent.defaultPrevented).toBe(false);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("does not submit Enter while IME composition is active", () => {
    const onSend = vi.fn();
    renderComposer({ onSend });
    const textarea = screen.getByRole("textbox", { name: "Terminal input" });

    fireEvent.compositionStart(textarea, { data: "ㅎ" });
    const composingEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(composingEnter);
    expect(composingEnter.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.compositionEnd(textarea, { data: "한" });
    const legacyImeEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(legacyImeEnter, "keyCode", { value: 229 });
    textarea.dispatchEvent(legacyImeEnter);
    expect(legacyImeEnter.defaultPrevented).toBe(false);
    expect(onSend).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("recovers plain Enter after leaving Composer during IME composition", () => {
    const onSend = vi.fn();

    // The mode toggle now lives outside the composer (pane control bar); the test
    // drives it through a parent-controlled button just like the real toolbar.
    function Harness() {
      const [mode, setMode] = useState<InputMode>("composer");
      return (
        <>
          <button
            type="button"
            onClick={() => setMode((m) => (m === "composer" ? "direct" : "composer"))}
          >
            toggle-mode
          </button>
          <TerminalInputComposer
            mode={mode}
            text="draft"
            labels={labels}
            onTextChange={vi.fn()}
            onSend={onSend}
          />
        </>
      );
    }

    render(<Harness />);
    const composingEditor = screen.getByRole("textbox", { name: "Terminal input" });
    fireEvent.compositionStart(composingEditor, { data: "한" });

    // Removing a focused textarea does not guarantee compositionend/blur in
    // every WebView. Returning to Composer must not inherit that stale gate.
    fireEvent.click(screen.getByRole("button", { name: "toggle-mode" }));
    expect(screen.queryByRole("textbox", { name: "Terminal input" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "toggle-mode" }));

    const restoredEditor = screen.getByRole("textbox", { name: "Terminal input" });
    const enter = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    restoredEditor.dispatchEvent(enter);

    expect(enter.defaultPrevented).toBe(true);
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("keeps editing enabled but refuses Enter submit while in flight", async () => {
    const user = userEvent.setup();
    const onTextChange = vi.fn();
    const onSend = vi.fn();
    renderComposer({ inFlight: true, onTextChange, onSend });

    const textarea = screen.getByRole("textbox", { name: "Terminal input" });
    expect(textarea).toBeEnabled();
    const host = screen.getByTestId("composer");
    expect(host).toHaveAttribute("aria-busy", "true");
    expect(host).toHaveAttribute("data-can-send", "false");

    await user.type(textarea, " more");
    expect(onTextChange).toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables the editor and blocks Enter when externally disabled", () => {
    const onSend = vi.fn();
    renderComposer({ disabled: true, onSend });

    const textarea = screen.getByRole("textbox", { name: "Terminal input" });
    expect(textarea).toBeDisabled();
    expect(screen.getByTestId("composer")).toHaveAttribute("data-can-send", "false");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps draft editing available but blocks Enter while commit readiness is disabled", () => {
    const onSend = vi.fn();
    renderComposer({ commitDisabled: true, onSend });

    const textarea = screen.getByRole("textbox", { name: "Terminal input" });
    expect(textarea).toBeEnabled();
    expect(screen.getByTestId("composer")).toHaveAttribute("data-can-send", "false");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("resizes by dragging the top edge upward and has no textarea corner grip", () => {
    localStorage.clear();
    renderComposer();

    const host = screen.getByTestId("composer");
    const handle = screen.getByTestId("composer-resize");
    expect(handle).toHaveAttribute("role", "separator");
    // No resize-y on the editor — the corner grip is gone.
    expect(screen.getByRole("textbox", { name: "Terminal input" }).className).not.toMatch(
      /resize-y/,
    );

    const before = parseInt(host.style.height, 10);
    fireEvent.pointerDown(handle, { clientY: 200, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientY: 150, pointerId: 1 }); // drag up 50px
    expect(parseInt(host.style.height, 10)).toBe(before + 50);

    fireEvent.pointerUp(handle, { clientY: 150, pointerId: 1 });
    expect(localStorage.getItem("laymux.desktop.composerHeight")).toBe(String(before + 50));
  });

  it("keeps Shift+Enter as the newline gesture even on an empty draft", () => {
    const onKeyPassthrough = vi.fn().mockReturnValue(true);
    const onSend = vi.fn();
    renderComposer({ text: "", onKeyPassthrough, onSend });
    const textarea = screen.getByRole("textbox", { name: "Terminal input" });

    const shiftEnter = new KeyboardEvent("keydown", {
      key: "Enter",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(shiftEnter);

    // Starting a multiline draft must win over forwarding \r to the terminal.
    expect(onKeyPassthrough).not.toHaveBeenCalled();
    expect(onSend).not.toHaveBeenCalled();
    expect(shiftEnter.defaultPrevented).toBe(false);
  });

  it("at the prompt, edge ↑/↓ recall history; while a program runs they pass through", () => {
    const onHistory = vi.fn().mockReturnValue(true);
    const onKeyPassthrough = vi.fn().mockReturnValue(true);

    // Prompt + empty draft: caret is at both edges → ↑/↓ recall history, no passthrough.
    const prompt = renderComposer({
      text: "",
      atShellPrompt: true,
      onHistory,
      onKeyPassthrough,
    });
    const textarea = screen.getByRole("textbox", { name: "Terminal input" });
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(onHistory).toHaveBeenNthCalledWith(1, "prev");
    expect(onHistory).toHaveBeenNthCalledWith(2, "next");
    expect(prompt.onKeyPassthrough).not.toHaveBeenCalled();

    cleanup();
    onHistory.mockClear();
    onKeyPassthrough.mockClear();

    // Program running: ↑ is not history — it passes through to the program.
    renderComposer({ text: "", atShellPrompt: false, onHistory, onKeyPassthrough });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Terminal input" }), { key: "ArrowUp" });
    expect(onHistory).not.toHaveBeenCalled();
    expect(onKeyPassthrough).toHaveBeenCalled();
  });

  describe("Tab history popup (issue #504)", () => {
    const history = ["first", "second", "third"];

    it("opens a newest-first list on Tab when the empty draft has history", () => {
      const onKeyPassthrough = vi.fn().mockReturnValue(true);
      renderComposer({
        text: "",
        historyPopupEnabled: true,
        history,
        onKeyPassthrough,
      });
      const textarea = screen.getByRole("textbox", { name: "Terminal input" });

      expect(screen.queryByTestId("composer-history")).not.toBeInTheDocument();
      const tab = createEvent.keyDown(textarea, { key: "Tab" });
      fireEvent(textarea, tab);

      expect(tab.defaultPrevented).toBe(true);
      // Tab opens the recall list instead of leaking \t to the terminal.
      expect(onKeyPassthrough).not.toHaveBeenCalled();
      const list = screen.getByTestId("composer-history");
      expect(list).toHaveAttribute("role", "listbox");
      const options = screen.getAllByRole("option");
      expect(options.map((o) => o.textContent)).toEqual(["third", "second", "first"]);
    });

    it("passes Tab through when the popup is disabled", () => {
      const onKeyPassthrough = vi.fn().mockReturnValue(true);
      renderComposer({ text: "", historyPopupEnabled: false, history, onKeyPassthrough });
      const textarea = screen.getByRole("textbox", { name: "Terminal input" });

      fireEvent.keyDown(textarea, { key: "Tab" });
      expect(onKeyPassthrough).toHaveBeenCalled();
      expect(screen.queryByTestId("composer-history")).not.toBeInTheDocument();
    });

    it("does not open on a non-empty draft or with empty history", () => {
      const { rerender } = render(
        <TerminalInputComposer
          mode="composer"
          text="typed"
          labels={labels}
          historyPopupEnabled
          history={history}
          onTextChange={vi.fn()}
          onSend={vi.fn()}
          testId="composer"
        />,
      );
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Terminal input" }), { key: "Tab" });
      expect(screen.queryByTestId("composer-history")).not.toBeInTheDocument();

      rerender(
        <TerminalInputComposer
          mode="composer"
          text=""
          labels={labels}
          historyPopupEnabled
          history={[]}
          onTextChange={vi.fn()}
          onSend={vi.fn()}
          testId="composer"
        />,
      );
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Terminal input" }), { key: "Tab" });
      expect(screen.queryByTestId("composer-history")).not.toBeInTheDocument();
    });

    it("navigates with arrows and fills the draft on Enter", () => {
      const onTextChange = vi.fn();
      const onSend = vi.fn();
      renderComposer({ text: "", historyPopupEnabled: true, history, onTextChange, onSend });
      const textarea = screen.getByRole("textbox", { name: "Terminal input" });

      fireEvent.keyDown(textarea, { key: "Tab" });
      fireEvent.keyDown(textarea, { key: "ArrowDown" }); // third -> second
      fireEvent.keyDown(textarea, { key: "Enter" });

      expect(onTextChange).toHaveBeenCalledWith("second");
      // Enter chose an entry — it must not also submit the draft.
      expect(onSend).not.toHaveBeenCalled();
      expect(screen.queryByTestId("composer-history")).not.toBeInTheDocument();
    });

    it("fills the draft when an entry is clicked", () => {
      const onTextChange = vi.fn();
      renderComposer({ text: "", historyPopupEnabled: true, history, onTextChange });
      const textarea = screen.getByRole("textbox", { name: "Terminal input" });

      fireEvent.keyDown(textarea, { key: "Tab" });
      fireEvent.mouseDown(screen.getByText("first"));

      expect(onTextChange).toHaveBeenCalledWith("first");
      expect(screen.queryByTestId("composer-history")).not.toBeInTheDocument();
    });

    it("closes on Escape without touching the draft", () => {
      const onTextChange = vi.fn();
      renderComposer({ text: "", historyPopupEnabled: true, history, onTextChange });
      const textarea = screen.getByRole("textbox", { name: "Terminal input" });

      fireEvent.keyDown(textarea, { key: "Tab" });
      expect(screen.getByTestId("composer-history")).toBeInTheDocument();
      const escape = createEvent.keyDown(textarea, { key: "Escape" });
      fireEvent(textarea, escape);

      expect(escape.defaultPrevented).toBe(true);
      expect(onTextChange).not.toHaveBeenCalled();
      expect(screen.queryByTestId("composer-history")).not.toBeInTheDocument();
    });

    it("does not recall edge history via ArrowUp while the popup is open", () => {
      const onHistory = vi.fn().mockReturnValue(true);
      renderComposer({
        text: "",
        atShellPrompt: true,
        historyPopupEnabled: true,
        history,
        onHistory,
      });
      const textarea = screen.getByRole("textbox", { name: "Terminal input" });

      fireEvent.keyDown(textarea, { key: "Tab" });
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      // ArrowUp moves the popup selection; it must not trigger edge history recall.
      expect(onHistory).not.toHaveBeenCalled();
    });
  });

  describe("typing autocomplete (issue #505)", () => {
    // Newest-first prefix matches for "git": ["git push", "git checkout", "git commit"].
    const history = ["git commit", "git checkout", "git push"];

    it("shows newest-first prefix matches while typing when enabled", () => {
      renderComposer({ text: "git", autocompleteEnabled: true, history });

      const list = screen.getByTestId("composer-autocomplete");
      expect(list).toHaveAttribute("role", "listbox");
      expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual([
        "git push",
        "git checkout",
        "git commit",
      ]);
    });

    it("shows nothing when disabled, on an empty draft, or with no prefix match", () => {
      const { rerender } = render(
        <TerminalInputComposer
          mode="composer"
          text="git"
          labels={labels}
          autocompleteEnabled={false}
          history={history}
          onTextChange={vi.fn()}
          onSend={vi.fn()}
          testId="composer"
        />,
      );
      expect(screen.queryByTestId("composer-autocomplete")).not.toBeInTheDocument();

      // Empty draft belongs to the Tab history popup, not autocomplete.
      rerender(
        <TerminalInputComposer
          mode="composer"
          text=""
          labels={labels}
          autocompleteEnabled
          history={history}
          onTextChange={vi.fn()}
          onSend={vi.fn()}
          testId="composer"
        />,
      );
      expect(screen.queryByTestId("composer-autocomplete")).not.toBeInTheDocument();

      rerender(
        <TerminalInputComposer
          mode="composer"
          text="docker"
          labels={labels}
          autocompleteEnabled
          history={history}
          onTextChange={vi.fn()}
          onSend={vi.fn()}
          testId="composer"
        />,
      );
      expect(screen.queryByTestId("composer-autocomplete")).not.toBeInTheDocument();
    });

    it("does not hijack plain Enter when no suggestion is active (Enter still sends)", () => {
      const onSend = vi.fn();
      const onTextChange = vi.fn();
      renderComposer({ text: "git", autocompleteEnabled: true, history, onSend, onTextChange });
      const textarea = screen.getByRole("textbox", { name: "Terminal input" });

      fireEvent.keyDown(textarea, { key: "Enter" });
      expect(onSend).toHaveBeenCalledTimes(1);
      expect(onTextChange).not.toHaveBeenCalled();
    });

    it("fills the draft on Enter once a suggestion is navigated to (no send)", () => {
      const onSend = vi.fn();
      const onTextChange = vi.fn();
      renderComposer({ text: "git", autocompleteEnabled: true, history, onSend, onTextChange });
      const textarea = screen.getByRole("textbox", { name: "Terminal input" });

      fireEvent.keyDown(textarea, { key: "ArrowDown" }); // select "git push"
      fireEvent.keyDown(textarea, { key: "Enter" });

      expect(onTextChange).toHaveBeenCalledWith("git push");
      expect(onSend).not.toHaveBeenCalled();
      expect(screen.queryByTestId("composer-autocomplete")).not.toBeInTheDocument();
    });

    it("accepts the top suggestion on Tab without navigating first", () => {
      const onTextChange = vi.fn();
      renderComposer({ text: "git", autocompleteEnabled: true, history, onTextChange });
      const textarea = screen.getByRole("textbox", { name: "Terminal input" });

      const tab = createEvent.keyDown(textarea, { key: "Tab" });
      fireEvent(textarea, tab);

      expect(tab.defaultPrevented).toBe(true);
      expect(onTextChange).toHaveBeenCalledWith("git push");
    });

    it("dismisses on Escape without touching the draft", () => {
      const onTextChange = vi.fn();
      renderComposer({ text: "git", autocompleteEnabled: true, history, onTextChange });
      const textarea = screen.getByRole("textbox", { name: "Terminal input" });

      expect(screen.getByTestId("composer-autocomplete")).toBeInTheDocument();
      const escape = createEvent.keyDown(textarea, { key: "Escape" });
      fireEvent(textarea, escape);

      expect(escape.defaultPrevented).toBe(true);
      expect(onTextChange).not.toHaveBeenCalled();
      expect(screen.queryByTestId("composer-autocomplete")).not.toBeInTheDocument();
    });

    it("fills the draft when a suggestion is clicked", () => {
      const onTextChange = vi.fn();
      renderComposer({ text: "git", autocompleteEnabled: true, history, onTextChange });

      fireEvent.mouseDown(screen.getByText("git checkout"));
      expect(onTextChange).toHaveBeenCalledWith("git checkout");
      expect(screen.queryByTestId("composer-autocomplete")).not.toBeInTheDocument();
    });

    it("lets ArrowUp fall through to edge history recall when no suggestion is active", () => {
      const onHistory = vi.fn().mockReturnValue(true);
      renderComposer({
        text: "git",
        atShellPrompt: true,
        autocompleteEnabled: true,
        history,
        onHistory,
      });
      const textarea = screen.getByRole("textbox", { name: "Terminal input" });
      // Cursor at the very start so edge ArrowUp recall is eligible.
      const ta = textarea as HTMLTextAreaElement;
      ta.setSelectionRange(0, 0);

      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      // No suggestion selected yet, so ArrowUp is not consumed by autocomplete.
      expect(onHistory).toHaveBeenCalledWith("prev");
    });

    it("keeps the Tab history popup and typing autocomplete mutually exclusive", () => {
      const { rerender } = render(
        <TerminalInputComposer
          mode="composer"
          text=""
          labels={labels}
          historyPopupEnabled
          autocompleteEnabled
          history={history}
          onTextChange={vi.fn()}
          onSend={vi.fn()}
          testId="composer"
        />,
      );
      // Empty draft: Tab opens the history popup, autocomplete stays hidden.
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Terminal input" }), { key: "Tab" });
      expect(screen.getByTestId("composer-history")).toBeInTheDocument();
      expect(screen.queryByTestId("composer-autocomplete")).not.toBeInTheDocument();

      // Typed draft: autocomplete shows, the history popup stays hidden.
      rerender(
        <TerminalInputComposer
          mode="composer"
          text="git"
          labels={labels}
          historyPopupEnabled
          autocompleteEnabled
          history={history}
          onTextChange={vi.fn()}
          onSend={vi.fn()}
          testId="composer"
        />,
      );
      expect(screen.getByTestId("composer-autocomplete")).toBeInTheDocument();
      expect(screen.queryByTestId("composer-history")).not.toBeInTheDocument();
    });
  });

  it("preserves the draft across mode switches without coupling them", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [mode, setMode] = useState<InputMode>("direct");
      const [text, setText] = useState("kept");
      return (
        <>
          <button
            type="button"
            onClick={() => setMode((m) => (m === "composer" ? "direct" : "composer"))}
          >
            toggle-mode
          </button>
          <TerminalInputComposer
            mode={mode}
            text={text}
            labels={labels}
            onTextChange={setText}
            onSend={vi.fn()}
            testId="composer"
          />
        </>
      );
    }

    render(<Harness />);
    expect(screen.queryByRole("textbox", { name: "Terminal input" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "toggle-mode" }));
    expect(screen.getByRole("textbox", { name: "Terminal input" })).toHaveValue("kept");
    await user.click(screen.getByRole("button", { name: "toggle-mode" }));
    expect(screen.queryByRole("textbox", { name: "Terminal input" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "toggle-mode" }));
    expect(screen.getByRole("textbox", { name: "Terminal input" })).toHaveValue("kept");
  });
});
