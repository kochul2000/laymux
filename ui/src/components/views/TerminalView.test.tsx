import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { TerminalView } from "./TerminalView";
import { useTerminalStore } from "@/stores/terminal-store";
import { useSettingsStore } from "@/stores/settings-store";

// Mock xterm since it requires a real DOM with canvas
const mockOnData = vi.fn();
const mockOnResize = vi.fn();
const mockOnTitleChange = vi.fn();
const mockFocus = vi.fn();
const mockBlur = vi.fn();
const mockPaste = vi.fn();
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
    attachCustomKeyEventHandler = mockAttachCustomKeyEventHandler;
    focus = mockFocus;
    blur = mockBlur;
    paste = mockPaste;
    dispose = vi.fn();
    loadAddon = vi.fn();
    cols = 80;
    rows = 24;
  },
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = vi.fn();
    dispose = vi.fn();
  },
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class MockWebLinksAddon {
    dispose = vi.fn();
  },
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

vi.mock("@/lib/tauri-api", () => ({
  createTerminalSession: (...args: unknown[]) => mockCreateTerminalSession(...args),
  writeToTerminal: (...args: unknown[]) => mockWriteToTerminal(...args),
  resizeTerminal: (...args: unknown[]) => mockResizeTerminal(...args),
  closeTerminalSession: (...args: unknown[]) => mockCloseTerminalSession(...args),
  onTerminalOutput: (...args: unknown[]) => mockOnTerminalOutput(...args),
  smartPaste: (...args: unknown[]) => mockSmartPaste(...args),
}));

describe("TerminalView", () => {
  beforeEach(() => {
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    capturedKeyHandler = null;
    vi.clearAllMocks();
  });

  it("renders terminal container", () => {
    render(
      <TerminalView
        instanceId="t1"
        profile="PowerShell"
        syncGroup="default"
      />,
    );
    expect(screen.getByTestId("terminal-view-t1")).toBeInTheDocument();
  });

  it("registers terminal instance in store on mount", () => {
    render(
      <TerminalView instanceId="t2" profile="WSL" syncGroup="project-a" />,
    );
    const instances = useTerminalStore.getState().instances;
    expect(instances).toHaveLength(1);
    expect(instances[0].id).toBe("t2");
    expect(instances[0].profile).toBe("WSL");
    expect(instances[0].syncGroup).toBe("project-a");
  });

  it("unregisters terminal instance on unmount", () => {
    const { unmount } = render(
      <TerminalView instanceId="t3" profile="WSL" syncGroup="" />,
    );
    expect(useTerminalStore.getState().instances).toHaveLength(1);

    unmount();
    expect(useTerminalStore.getState().instances).toHaveLength(0);
  });

  it("calls createTerminalSession on mount", async () => {
    render(
      <TerminalView instanceId="t4" profile="PowerShell" syncGroup="grp" />,
    );

    // createTerminalSession is called asynchronously in useEffect
    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalledWith(
        "t4",
        "PowerShell",
        80,
        24,
        "grp",
      );
    });
  });

  it("registers onData handler to write to terminal", () => {
    render(
      <TerminalView instanceId="t5" profile="PowerShell" syncGroup="" />,
    );

    // onData should be registered
    expect(mockOnData).toHaveBeenCalled();
  });

  it("listens for terminal output events", async () => {
    render(
      <TerminalView instanceId="t6" profile="PowerShell" syncGroup="" />,
    );

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalledWith(
        "t6",
        expect.any(Function),
      );
    });
  });

  it("calls closeTerminalSession on unmount", async () => {
    const { unmount } = render(
      <TerminalView instanceId="t7" profile="PowerShell" syncGroup="" />,
    );

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

    rerender(
      <TerminalView instanceId="t8" profile="PowerShell" syncGroup="" isFocused={true} />,
    );

    expect(mockFocus).toHaveBeenCalled();
  });

  it("calls terminal.focus() when mounted with isFocused=true (focus after open)", async () => {
    render(
      <TerminalView instanceId="t9" profile="PowerShell" syncGroup="" isFocused={true} />,
    );

    // ResizeObserver fires → terminal.open() → should auto-focus
    await vi.waitFor(() => {
      expect(mockFocus).toHaveBeenCalled();
    });
  });

  it("does not call terminal.focus() when isFocused is false", async () => {
    render(
      <TerminalView instanceId="t10" profile="PowerShell" syncGroup="" isFocused={false} />,
    );

    // Wait for open
    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
    });

    mockFocus.mockClear();

    // No rerender with isFocused=true
    expect(mockFocus).not.toHaveBeenCalled();
  });

  // -- Smart Paste --

  it("intercepts Ctrl+V and calls smartPaste when enabled", async () => {
    mockSmartPaste.mockResolvedValue({ pasteType: "path", content: "C:\\test\\file.png" });

    render(
      <TerminalView instanceId="t-paste1" profile="PowerShell" syncGroup="" />,
    );

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

    render(
      <TerminalView instanceId="t-paste2" profile="PowerShell" syncGroup="" />,
    );

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
      convenience: { smartPaste: false, pasteImageDir: "", hoverIdleSeconds: 2, notificationDismiss: "workspace" as const },
    });

    render(
      <TerminalView instanceId="t-paste3" profile="PowerShell" syncGroup="" />,
    );

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
    render(
      <TerminalView instanceId="t-paste4" profile="PowerShell" syncGroup="" />,
    );

    await vi.waitFor(() => {
      expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
    });

    // Regular key should pass through
    const event = new KeyboardEvent("keydown", { key: "a" });
    const result = capturedKeyHandler!(event);
    expect(result).toBe(true);
    expect(mockSmartPaste).not.toHaveBeenCalled();
  });
});
