import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { TerminalView } from "./TerminalView";
import { useTerminalStore } from "@/stores/terminal-store";
import { useSettingsStore } from "@/stores/settings-store";

// Mock xterm since it requires a real DOM with canvas
const mockOnData = vi.fn();
const mockOnResize = vi.fn();
const mockOnTitleChange = vi.fn();
const mockOnSelectionChange = vi.fn();
const mockOnKey = vi.fn();
const mockFocus = vi.fn();
const mockBlur = vi.fn();
const mockPaste = vi.fn();
const mockHasSelection = vi.fn().mockReturnValue(false);
const mockGetSelection = vi.fn().mockReturnValue("");
const mockClearSelection = vi.fn();
let capturedKeyHandler: ((e: KeyboardEvent) => boolean) | null = null;
const mockAttachCustomKeyEventHandler = vi.fn((handler: (e: KeyboardEvent) => boolean) => {
  capturedKeyHandler = handler;
});
vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    open = vi.fn();
    write = vi.fn();
    onData = mockOnData;
    onResize = mockOnResize;
    onTitleChange = mockOnTitleChange;
    onSelectionChange = mockOnSelectionChange;
    onKey = mockOnKey;
    attachCustomKeyEventHandler = mockAttachCustomKeyEventHandler;
    focus = mockFocus;
    blur = mockBlur;
    paste = mockPaste;
    hasSelection = mockHasSelection;
    getSelection = mockGetSelection;
    clearSelection = mockClearSelection;
    dispose = vi.fn();
    loadAddon = vi.fn();
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
  },
}));

const mockFit = vi.fn();
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = mockFit;
    dispose = vi.fn();
  },
}));

let capturedLinkHandler: ((event: MouseEvent, uri: string) => void) | null = null;
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class MockWebLinksAddon {
    constructor(handler?: (event: MouseEvent, uri: string) => void) {
      if (handler) capturedLinkHandler = handler;
    }
    dispose = vi.fn();
  },
}));

const mockSerialize = vi.fn().mockReturnValue("serialized-data");
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class MockSerializeAddon {
    serialize = mockSerialize;
    dispose = vi.fn();
  },
}));

const mockRegisterTerminalSerializer = vi.fn();
const mockUnregisterTerminalSerializer = vi.fn();
vi.mock("@/lib/terminal-serialize-registry", () => ({
  registerTerminalSerializer: (...args: unknown[]) => mockRegisterTerminalSerializer(...args),
  unregisterTerminalSerializer: (...args: unknown[]) => mockUnregisterTerminalSerializer(...args),
}));

// Mock IME handler
const mockSetupImeHandler = vi.fn().mockReturnValue(true);
const mockDisposeImeHandler = vi.fn();
vi.mock("@/lib/ime-handler", () => ({
  setupImeHandler: (...args: unknown[]) => mockSetupImeHandler(...args),
  disposeImeHandler: (...args: unknown[]) => mockDisposeImeHandler(...args),
}));

// Mock tauri API
const mockCreateTerminalSession = vi.fn().mockResolvedValue({
  id: "t1",
  title: "Terminal",
  config: { profile: "PowerShell", cols: 80, rows: 24, sync_group: "", env: [] },
});
const mockWriteToTerminal = vi.fn().mockResolvedValue(undefined);
const mockResizeTerminal = vi.fn().mockResolvedValue(undefined);
const mockCloseTerminalSession = vi.fn().mockResolvedValue(undefined);
const mockOnTerminalOutput = vi.fn().mockResolvedValue(vi.fn());
const mockSmartPaste = vi.fn().mockResolvedValue({ pasteType: "none", content: "" });
const mockClipboardWriteText = vi.fn().mockResolvedValue(undefined);
const mockSetTerminalCwdReceive = vi.fn().mockResolvedValue(undefined);
const mockOpenExternal = vi.fn().mockResolvedValue(undefined);
const mockLoadTerminalOutputCache = vi
  .fn()
  .mockRejectedValue(new Error("Failed to read cache: not found"));

vi.mock("@/lib/tauri-api", () => ({
  createTerminalSession: (...args: unknown[]) => mockCreateTerminalSession(...args),
  writeToTerminal: (...args: unknown[]) => mockWriteToTerminal(...args),
  resizeTerminal: (...args: unknown[]) => mockResizeTerminal(...args),
  closeTerminalSession: (...args: unknown[]) => mockCloseTerminalSession(...args),
  onTerminalOutput: (...args: unknown[]) => mockOnTerminalOutput(...args),
  smartPaste: (...args: unknown[]) => mockSmartPaste(...args),
  clipboardWriteText: (...args: unknown[]) => mockClipboardWriteText(...args),
  setTerminalCwdReceive: (...args: unknown[]) => mockSetTerminalCwdReceive(...args),
  updateTerminalSyncGroup: vi.fn().mockResolvedValue(undefined),
  openExternal: (...args: unknown[]) => mockOpenExternal(...args),
  loadTerminalOutputCache: (...args: unknown[]) => mockLoadTerminalOutputCache(...args),
}));

describe("TerminalView", () => {
  beforeEach(() => {
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    capturedKeyHandler = null;
    capturedLinkHandler = null;
    vi.clearAllMocks();
  });

  it("renders terminal container", () => {
    render(<TerminalView instanceId="t1" profile="PowerShell" syncGroup="default" />);
    expect(screen.getByTestId("terminal-view-t1")).toBeInTheDocument();
  });

  it("registers terminal instance in store on mount", () => {
    render(<TerminalView instanceId="t2" profile="WSL" syncGroup="project-a" />);
    const instances = useTerminalStore.getState().instances;
    expect(instances).toHaveLength(1);
    expect(instances[0].id).toBe("t2");
    expect(instances[0].profile).toBe("WSL");
    expect(instances[0].syncGroup).toBe("project-a");
  });

  it("unregisters terminal instance on unmount", () => {
    const { unmount } = render(<TerminalView instanceId="t3" profile="WSL" syncGroup="" />);
    expect(useTerminalStore.getState().instances).toHaveLength(1);

    unmount();
    expect(useTerminalStore.getState().instances).toHaveLength(0);
  });

  it("calls createTerminalSession on mount", async () => {
    render(<TerminalView instanceId="t4" profile="PowerShell" syncGroup="grp" />);

    // createTerminalSession is called asynchronously in useEffect
    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalledWith(
        "t4",
        "PowerShell",
        80,
        24,
        "grp",
        true,
        undefined,
      );
    });
  });

  it("registers onData handler to write to terminal", () => {
    render(<TerminalView instanceId="t5" profile="PowerShell" syncGroup="" />);

    // onData should be registered
    expect(mockOnData).toHaveBeenCalled();
  });

  it("listens for terminal output events", async () => {
    render(<TerminalView instanceId="t6" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalledWith("t6", expect.any(Function));
    });
  });

  it("calls closeTerminalSession on unmount", async () => {
    const { unmount } = render(<TerminalView instanceId="t7" profile="PowerShell" syncGroup="" />);

    unmount();

    // closeTerminalSession is called during cleanup
    expect(mockCloseTerminalSession).toHaveBeenCalledWith("t7");
  });

  it("calls terminal.focus() when isFocused becomes true after open", async () => {
    const { rerender } = render(
      <TerminalView instanceId="t8" profile="PowerShell" syncGroup="" isFocused={false} />,
    );

    // Wait for ResizeObserver to fire (setTimeout(0)) and terminal.open()
    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
    });

    mockFocus.mockClear();

    rerender(<TerminalView instanceId="t8" profile="PowerShell" syncGroup="" isFocused={true} />);

    expect(mockFocus).toHaveBeenCalled();
  });

  it("calls terminal.focus() when mounted with isFocused=true (focus after open)", async () => {
    render(<TerminalView instanceId="t9" profile="PowerShell" syncGroup="" isFocused={true} />);

    // ResizeObserver fires → terminal.open() → should auto-focus
    await vi.waitFor(() => {
      expect(mockFocus).toHaveBeenCalled();
    });
  });

  it("calls terminal.blur() when isFocused becomes false", async () => {
    const { rerender } = render(
      <TerminalView instanceId="t-blur" profile="PowerShell" syncGroup="" isFocused={true} />,
    );

    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
    });

    mockBlur.mockClear();

    rerender(
      <TerminalView instanceId="t-blur" profile="PowerShell" syncGroup="" isFocused={false} />,
    );

    expect(mockBlur).toHaveBeenCalled();
  });

  it("does not call terminal.focus() when isFocused is false", async () => {
    render(<TerminalView instanceId="t10" profile="PowerShell" syncGroup="" isFocused={false} />);

    // Wait for open
    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
    });

    mockFocus.mockClear();

    // No rerender with isFocused=true
    expect(mockFocus).not.toHaveBeenCalled();
  });

  // -- syncGroup change (workspace rename) should NOT recreate terminal --

  it("does not destroy and recreate terminal when syncGroup changes", async () => {
    const { rerender } = render(
      <TerminalView instanceId="t-sg1" profile="PowerShell" syncGroup="OldName" />,
    );

    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalledTimes(1);
    });
    expect(mockCloseTerminalSession).not.toHaveBeenCalled();

    mockCreateTerminalSession.mockClear();
    mockCloseTerminalSession.mockClear();

    // Rerender with a new syncGroup (simulates workspace rename)
    rerender(<TerminalView instanceId="t-sg1" profile="PowerShell" syncGroup="NewName" />);

    // Terminal must NOT be destroyed or recreated
    expect(mockCloseTerminalSession).not.toHaveBeenCalled();
    expect(mockCreateTerminalSession).not.toHaveBeenCalled();
  });

  it("updates terminal store syncGroup when prop changes without remount", async () => {
    const { rerender } = render(
      <TerminalView instanceId="t-sg2" profile="PowerShell" syncGroup="GroupA" />,
    );

    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalledTimes(1);
    });

    expect(useTerminalStore.getState().instances[0].syncGroup).toBe("GroupA");

    rerender(<TerminalView instanceId="t-sg2" profile="PowerShell" syncGroup="GroupB" />);

    // Store should reflect the new syncGroup
    expect(useTerminalStore.getState().instances[0].syncGroup).toBe("GroupB");
    // But terminal should NOT have been recreated
    expect(mockCloseTerminalSession).not.toHaveBeenCalled();
  });

  // -- Smart Paste --

  it("intercepts Ctrl+V and calls smartPaste when enabled", async () => {
    mockSmartPaste.mockResolvedValue({ pasteType: "path", content: "C:\\test\\file.png" });

    render(<TerminalView instanceId="t-paste1" profile="PowerShell" syncGroup="" />);

    // Wait for terminal to initialize and capture the key handler
    await vi.waitFor(() => {
      expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
    });
    expect(capturedKeyHandler).not.toBeNull();

    // Simulate Ctrl+V keydown
    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    const result = capturedKeyHandler!(event);

    expect(result).toBe(false); // Should block xterm
    expect(event.preventDefault).toHaveBeenCalled();

    await vi.waitFor(() => {
      expect(mockSmartPaste).toHaveBeenCalledWith("", "PowerShell");
    });

    await vi.waitFor(() => {
      expect(mockPaste).toHaveBeenCalledWith("C:\\test\\file.png");
    });
  });

  it("writes text when smartPaste returns text type", async () => {
    mockSmartPaste.mockResolvedValue({ pasteType: "text", content: "hello world" });

    render(<TerminalView instanceId="t-paste2" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
    });

    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    capturedKeyHandler!(event);

    await vi.waitFor(() => {
      expect(mockSmartPaste).toHaveBeenCalled();
    });

    await vi.waitFor(() => {
      expect(mockPaste).toHaveBeenCalledWith("hello world");
    });
  });

  it("does not intercept Ctrl+V when smart paste disabled", async () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      convenience: {
        smartPaste: false,
        pasteImageDir: "",
        hoverIdleSeconds: 2,
        notificationDismiss: "workspace" as const,
        copyOnSelect: false,
      },
    });

    render(<TerminalView instanceId="t-paste3" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
    });

    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true });
    const result = capturedKeyHandler!(event);

    // Should return true (let xterm handle normally)
    expect(result).toBe(true);
    expect(mockSmartPaste).not.toHaveBeenCalled();
  });

  it("lets normal keys pass through when smart paste enabled", async () => {
    render(<TerminalView instanceId="t-paste4" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
    });

    // Regular key should pass through
    const event = new KeyboardEvent("keydown", { key: "a" });
    const result = capturedKeyHandler!(event);
    expect(result).toBe(true);
    expect(mockSmartPaste).not.toHaveBeenCalled();
  });

  // -- Right-click behavior --

  it("right-click pastes when no text is selected", async () => {
    mockSmartPaste.mockResolvedValue({ pasteType: "text", content: "pasted text" });
    mockHasSelection.mockReturnValue(false);

    render(<TerminalView instanceId="t-rc1" profile="PowerShell" syncGroup="" />);

    const container = screen.getByTestId("terminal-view-t-rc1");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    container.dispatchEvent(event);

    await vi.waitFor(() => {
      expect(mockSmartPaste).toHaveBeenCalledWith("", "PowerShell");
    });

    // Right-click paste writes directly to PTY (no bracketed paste block)
    await vi.waitFor(() => {
      expect(mockWriteToTerminal).toHaveBeenCalledWith("t-rc1", "pasted text");
    });
  });

  it("right-click copies selection when text is selected", async () => {
    mockHasSelection.mockReturnValue(true);
    mockGetSelection.mockReturnValue("selected text");

    render(<TerminalView instanceId="t-rc2" profile="PowerShell" syncGroup="" />);

    const container = screen.getByTestId("terminal-view-t-rc2");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    container.dispatchEvent(event);

    await vi.waitFor(() => {
      expect(mockClipboardWriteText).toHaveBeenCalledWith("selected text");
    });

    // Should NOT paste when there is a selection
    expect(mockSmartPaste).not.toHaveBeenCalled();
    // Should clear selection after copy
    expect(mockClearSelection).toHaveBeenCalled();
  });

  it("right-click prevents default context menu", async () => {
    mockHasSelection.mockReturnValue(false);
    mockSmartPaste.mockResolvedValue({ pasteType: "none", content: "" });

    render(<TerminalView instanceId="t-rc3" profile="PowerShell" syncGroup="" />);

    const container = screen.getByTestId("terminal-view-t-rc3");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    container.dispatchEvent(event);

    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  // -- copyOnSelect --

  it("auto-copies selection when copyOnSelect is enabled", async () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      convenience: { ...useSettingsStore.getState().convenience, copyOnSelect: true },
    });

    mockHasSelection.mockReturnValue(true);
    mockGetSelection.mockReturnValue("auto-copied text");

    render(<TerminalView instanceId="t-cos1" profile="PowerShell" syncGroup="" />);

    // onSelectionChange should have been registered
    expect(mockOnSelectionChange).toHaveBeenCalled();

    // Invoke the captured selection change callback
    const selectionCallback = mockOnSelectionChange.mock.calls[0][0];
    selectionCallback();

    await vi.waitFor(() => {
      expect(mockClipboardWriteText).toHaveBeenCalledWith("auto-copied text");
    });
  });

  it("does not auto-copy when copyOnSelect is disabled", async () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      convenience: { ...useSettingsStore.getState().convenience, copyOnSelect: false },
    });

    mockHasSelection.mockReturnValue(true);
    mockGetSelection.mockReturnValue("some text");

    render(<TerminalView instanceId="t-cos2" profile="PowerShell" syncGroup="" />);

    // onSelectionChange should have been registered
    expect(mockOnSelectionChange).toHaveBeenCalled();

    // Invoke the selection change callback
    const selectionCallback = mockOnSelectionChange.mock.calls[0][0];
    selectionCallback();

    // Should NOT copy — copyOnSelect is disabled
    expect(mockClipboardWriteText).not.toHaveBeenCalled();
  });

  it("does not auto-copy when selection is empty (copyOnSelect enabled)", async () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      convenience: { ...useSettingsStore.getState().convenience, copyOnSelect: true },
    });

    mockHasSelection.mockReturnValue(false);

    render(<TerminalView instanceId="t-cos3" profile="PowerShell" syncGroup="" />);

    const selectionCallback = mockOnSelectionChange.mock.calls[0][0];
    selectionCallback();

    expect(mockClipboardWriteText).not.toHaveBeenCalled();
  });

  // -- Ctrl+Wheel Zoom --

  it("increases font size on Ctrl+Wheel scroll up", async () => {
    // Font is now resolved from profile -> profileDefaults
    render(<TerminalView instanceId="t-zoom1" profile="PowerShell" syncGroup="" />);

    const container = screen.getByTestId("terminal-view-t-zoom1");
    const event = new WheelEvent("wheel", {
      deltaY: -100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    container.dispatchEvent(event);

    // Ctrl+Wheel sets font override on the profile
    expect(useSettingsStore.getState().profiles[0].font?.size).toBe(15);
  });

  it("decreases font size on Ctrl+Wheel scroll down", async () => {
    render(<TerminalView instanceId="t-zoom2" profile="PowerShell" syncGroup="" />);

    const container = screen.getByTestId("terminal-view-t-zoom2");
    const event = new WheelEvent("wheel", {
      deltaY: 100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    container.dispatchEvent(event);

    expect(useSettingsStore.getState().profiles[0].font?.size).toBe(13);
  });

  it("does not change font size on wheel without Ctrl", async () => {
    render(<TerminalView instanceId="t-zoom3" profile="PowerShell" syncGroup="" />);

    const container = screen.getByTestId("terminal-view-t-zoom3");
    const event = new WheelEvent("wheel", { deltaY: -100, ctrlKey: false, bubbles: true });
    container.dispatchEvent(event);

    // No font override should be set
    expect(useSettingsStore.getState().profiles[0].font).toBeUndefined();
  });

  it("clamps font size to minimum 6", async () => {
    // Set profile font override to minimum
    useSettingsStore
      .getState()
      .updateProfile(0, { font: { face: "Cascadia Mono", size: 6, weight: "normal" } });

    render(<TerminalView instanceId="t-zoom4" profile="PowerShell" syncGroup="" />);

    const container = screen.getByTestId("terminal-view-t-zoom4");
    const event = new WheelEvent("wheel", {
      deltaY: 100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    container.dispatchEvent(event);

    expect(useSettingsStore.getState().profiles[0].font?.size).toBe(6);
  });

  // -- Scrollbar style --

  it("applies scrollbar-overlay class by default", () => {
    render(<TerminalView instanceId="t-sb1" profile="PowerShell" syncGroup="" />);
    const container = screen.getByTestId("terminal-view-t-sb1");
    expect(container.classList.contains("scrollbar-overlay")).toBe(true);
    expect(container.classList.contains("scrollbar-separate")).toBe(false);
  });

  it("applies scrollbar-separate class when setting is separate", () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      convenience: {
        ...useSettingsStore.getState().convenience,
        scrollbarStyle: "separate" as const,
      },
    });

    render(<TerminalView instanceId="t-sb2" profile="PowerShell" syncGroup="" />);
    const container = screen.getByTestId("terminal-view-t-sb2");
    expect(container.classList.contains("scrollbar-separate")).toBe(true);
    expect(container.classList.contains("scrollbar-overlay")).toBe(false);
  });

  it("updates xterm overviewRuler and re-fits when scrollbarStyle changes dynamically", async () => {
    render(<TerminalView instanceId="t-sb-dyn" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
    });

    mockFit.mockClear();

    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      convenience: {
        ...useSettingsStore.getState().convenience,
        scrollbarStyle: "separate" as const,
      },
    });

    await vi.waitFor(() => {
      const container = screen.getByTestId("terminal-view-t-sb-dyn");
      expect(container.classList.contains("scrollbar-separate")).toBe(true);
    });

    await vi.waitFor(() => {
      expect(mockFit).toHaveBeenCalled();
    });
  });

  it("updates xterm overviewRuler when scrollbarStyle changes from separate to overlay", async () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      convenience: {
        ...useSettingsStore.getState().convenience,
        scrollbarStyle: "separate" as const,
      },
    });

    render(<TerminalView instanceId="t-sb-rev" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
    });

    mockFit.mockClear();

    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      convenience: {
        ...useSettingsStore.getState().convenience,
        scrollbarStyle: "overlay" as const,
      },
    });

    await vi.waitFor(() => {
      const container = screen.getByTestId("terminal-view-t-sb-rev");
      expect(container.classList.contains("scrollbar-overlay")).toBe(true);
    });

    await vi.waitFor(() => {
      expect(mockFit).toHaveBeenCalled();
    });
  });

  it("clamps font size to maximum 72", async () => {
    useSettingsStore
      .getState()
      .updateProfile(0, { font: { face: "Cascadia Mono", size: 72, weight: "normal" } });

    render(<TerminalView instanceId="t-zoom5" profile="PowerShell" syncGroup="" />);

    const container = screen.getByTestId("terminal-view-t-zoom5");
    const event = new WheelEvent("wheel", {
      deltaY: -100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    container.dispatchEvent(event);

    expect(useSettingsStore.getState().profiles[0].font?.size).toBe(72);
  });

  it("prevents default browser zoom on Ctrl+Wheel", async () => {
    render(<TerminalView instanceId="t-zoom6" profile="PowerShell" syncGroup="" />);

    const container = screen.getByTestId("terminal-view-t-zoom6");
    const event = new WheelEvent("wheel", {
      deltaY: -100,
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(event, "preventDefault");
    container.dispatchEvent(event);

    expect(preventDefaultSpy).toHaveBeenCalled();
  });

  // -- URL link click (issue #29) --

  describe("URL link click", () => {
    it("passes a custom handler to WebLinksAddon that calls openExternal", async () => {
      render(<TerminalView instanceId="t-link1" profile="PowerShell" syncGroup="" />);

      // WebLinksAddon should have been constructed with a handler
      expect(capturedLinkHandler).not.toBeNull();

      // Simulate clicking a link
      const fakeEvent = new MouseEvent("click");
      capturedLinkHandler!(fakeEvent, "https://example.com");

      await vi.waitFor(() => {
        expect(mockOpenExternal).toHaveBeenCalledWith("https://example.com");
      });
    });

    it("handles openExternal failure gracefully (does not throw)", async () => {
      mockOpenExternal.mockRejectedValueOnce(new Error("shell open failed"));

      render(<TerminalView instanceId="t-link2" profile="PowerShell" syncGroup="" />);

      expect(capturedLinkHandler).not.toBeNull();

      // Should not throw even when openExternal fails
      const fakeEvent = new MouseEvent("click");
      expect(() => capturedLinkHandler!(fakeEvent, "https://example.com")).not.toThrow();

      await vi.waitFor(() => {
        expect(mockOpenExternal).toHaveBeenCalledWith("https://example.com");
      });
    });
  });

  // -- session restore --

  describe("session restore", () => {
    it("restores cached output when paneId is provided and restoreOutput is true", async () => {
      mockLoadTerminalOutputCache.mockResolvedValueOnce("cached-terminal-output");

      render(
        <TerminalView
          instanceId="t-restore1"
          paneId="pane-abc"
          profile="PowerShell"
          syncGroup="default"
        />,
      );

      await vi.waitFor(() => {
        expect(mockLoadTerminalOutputCache).toHaveBeenCalledWith("pane-abc");
      });
    });

    it("does not load cache when paneId is not provided", async () => {
      render(<TerminalView instanceId="t-restore2" profile="PowerShell" syncGroup="default" />);

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
      });
      expect(mockLoadTerminalOutputCache).not.toHaveBeenCalled();
    });

    it("does not load cache when restoreOutput is false in profile", async () => {
      useSettingsStore.getState().updateProfile(0, { restoreOutput: false });

      render(
        <TerminalView
          instanceId="t-restore3"
          paneId="pane-noout"
          profile="PowerShell"
          syncGroup="default"
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
      });
      expect(mockLoadTerminalOutputCache).not.toHaveBeenCalled();
    });

    it("passes lastCwd to createTerminalSession when restoreCwd is true", async () => {
      render(
        <TerminalView
          instanceId="t-restore4"
          paneId="pane-cwd"
          profile="PowerShell"
          syncGroup="default"
          lastCwd="/home/user/project"
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-restore4",
          "PowerShell",
          80,
          24,
          "default",
          true,
          "/home/user/project",
        );
      });
    });

    it("does not pass lastCwd when restoreCwd is false in profile", async () => {
      useSettingsStore.getState().updateProfile(0, { restoreCwd: false });

      render(
        <TerminalView
          instanceId="t-restore5"
          paneId="pane-nocwd"
          profile="PowerShell"
          syncGroup="default"
          lastCwd="/home/user/project"
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-restore5",
          "PowerShell",
          80,
          24,
          "default",
          true,
          undefined,
        );
      });
    });

    it("still creates session when cache load fails", async () => {
      mockLoadTerminalOutputCache.mockRejectedValueOnce(new Error("Failed to read cache: missing"));

      render(
        <TerminalView
          instanceId="t-restore6"
          paneId="pane-fail"
          profile="PowerShell"
          syncGroup="default"
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-restore6",
          "PowerShell",
          80,
          24,
          "default",
          true,
          undefined,
        );
      });
    });

    it("registers serializer on mount and unregisters on unmount", async () => {
      const { unmount } = render(
        <TerminalView
          instanceId="t-ser1"
          paneId="pane-ser"
          profile="PowerShell"
          syncGroup="default"
        />,
      );

      await vi.waitFor(() => {
        expect(mockRegisterTerminalSerializer).toHaveBeenCalledWith(
          "pane-ser",
          expect.any(Function),
        );
      });

      unmount();
      expect(mockUnregisterTerminalSerializer).toHaveBeenCalledWith("pane-ser");
    });
  });

  // -- cwdReceive sync (issue #24) --

  describe("cwdReceive sync", () => {
    it("passes cwdReceive=false atomically to createTerminalSession (no race condition)", async () => {
      render(
        <TerminalView
          instanceId="t-cwd1"
          profile="PowerShell"
          syncGroup="default"
          cwdReceive={false}
        />,
      );

      await vi.waitFor(() => {
        // cwdReceive is passed directly to createTerminalSession — no separate call needed
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-cwd1",
          "PowerShell",
          80,
          24,
          "default",
          false,
          undefined,
        );
      });
    });

    it("passes cwdReceive=true (default) atomically to createTerminalSession", async () => {
      render(
        <TerminalView
          instanceId="t-cwd2"
          profile="PowerShell"
          syncGroup="default"
          cwdReceive={true}
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-cwd2",
          "PowerShell",
          80,
          24,
          "default",
          true,
          undefined,
        );
      });
    });

    it("updates cwdReceive when prop changes after session exists", async () => {
      const { rerender } = render(
        <TerminalView
          instanceId="t-cwd3"
          profile="PowerShell"
          syncGroup="default"
          cwdReceive={true}
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
      });

      mockSetTerminalCwdReceive.mockClear();

      rerender(
        <TerminalView
          instanceId="t-cwd3"
          profile="PowerShell"
          syncGroup="default"
          cwdReceive={false}
        />,
      );

      await vi.waitFor(() => {
        expect(mockSetTerminalCwdReceive).toHaveBeenCalledWith("t-cwd3", false);
      });
    });
  });
});
