import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TerminalInputComposer, type TerminalInputComposerLabels } from "./TerminalInputComposer";
import type { InputMode } from "@/lib/terminal-input-composer-state";

const labels: TerminalInputComposerLabels = {
  editor: "Terminal input",
  placeholder: "Type before sending",
  resize: "Resize input area",
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
