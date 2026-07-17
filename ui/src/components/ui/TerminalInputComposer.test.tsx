import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TerminalInputComposer, type TerminalInputComposerLabels } from "./TerminalInputComposer";
import type { InputMode } from "@/lib/terminal-input-composer-state";

const labels: TerminalInputComposerLabels = {
  inputMode: "Input mode",
  direct: "Direct",
  composer: "Composer",
  editor: "Terminal input",
  placeholder: "Type before sending",
  send: "Send",
};

function renderComposer(
  overrides: Partial<React.ComponentProps<typeof TerminalInputComposer>> = {},
) {
  const props: React.ComponentProps<typeof TerminalInputComposer> = {
    mode: "composer",
    text: "draft",
    labels,
    onModeChange: vi.fn(),
    onTextChange: vi.fn(),
    onSend: vi.fn(),
    testId: "composer",
    ...overrides,
  };
  render(<TerminalInputComposer {...props} />);
  return props;
}

describe("TerminalInputComposer", () => {
  it("renders an accessible two-mode toggle and reports changes", async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();
    renderComposer({ mode: "direct", onModeChange });

    expect(screen.getByRole("group", { name: "Input mode" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Direct" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Composer" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByRole("textbox", { name: "Terminal input" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Composer" }));
    expect(onModeChange).toHaveBeenCalledWith("composer");
  });

  it("renders the controlled draft and exposes one Send action", async () => {
    const user = userEvent.setup();
    const onTextChange = vi.fn();
    const onSend = vi.fn();
    renderComposer({ onTextChange, onSend });

    const textarea = screen.getByRole("textbox", { name: "Terminal input" });
    expect(textarea).toHaveValue("draft");
    expect(textarea).toHaveAttribute("placeholder", "Type before sending");

    await user.type(textarea, "!");
    expect(onTextChange).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Insert" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send" }));
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

    function Harness() {
      const [mode, setMode] = useState<InputMode>("composer");
      return (
        <TerminalInputComposer
          mode={mode}
          text="draft"
          labels={labels}
          onModeChange={setMode}
          onTextChange={vi.fn()}
          onSend={onSend}
        />
      );
    }

    render(<Harness />);
    const composingEditor = screen.getByRole("textbox", { name: "Terminal input" });
    fireEvent.compositionStart(composingEditor, { data: "한" });

    // Removing a focused textarea does not guarantee compositionend/blur in
    // every WebView. Returning to Composer must not inherit that stale gate.
    fireEvent.click(screen.getByRole("button", { name: "Direct" }));
    expect(screen.queryByRole("textbox", { name: "Terminal input" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Composer" }));

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

  it("keeps textarea editing enabled but disables Send while in flight", async () => {
    const user = userEvent.setup();
    const onTextChange = vi.fn();
    const onSend = vi.fn();
    renderComposer({ inFlight: true, onTextChange, onSend });

    const textarea = screen.getByRole("textbox", { name: "Terminal input" });
    expect(textarea).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByTestId("composer")).toHaveAttribute("aria-busy", "true");

    await user.type(textarea, " more");
    expect(onTextChange).toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables every interactive control when externally disabled", () => {
    renderComposer({ disabled: true });

    expect(screen.getByRole("button", { name: "Direct" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Composer" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "Terminal input" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("keeps mode and draft editing available while commit readiness is disabled", () => {
    renderComposer({ commitDisabled: true });

    expect(screen.getByRole("button", { name: "Direct" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Composer" })).toBeEnabled();
    expect(screen.getByRole("textbox", { name: "Terminal input" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("supports controlled mode and draft state without coupling them", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [mode, setMode] = useState<InputMode>("direct");
      const [text, setText] = useState("kept");
      return (
        <TerminalInputComposer
          mode={mode}
          text={text}
          labels={labels}
          onModeChange={setMode}
          onTextChange={setText}
          onSend={vi.fn()}
          testId="composer"
        />
      );
    }

    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Composer" }));
    expect(screen.getByRole("textbox", { name: "Terminal input" })).toHaveValue("kept");
    await user.click(screen.getByRole("button", { name: "Direct" }));
    expect(screen.queryByRole("textbox", { name: "Terminal input" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Composer" }));
    expect(screen.getByRole("textbox", { name: "Terminal input" })).toHaveValue("kept");
  });
});
