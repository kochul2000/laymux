import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { TerminalView, _resetWebglStagger, shouldEnableTerminalWebgl } from "./TerminalView";
import { WebglAddon } from "@xterm/addon-webgl";
import { useTerminalStore } from "@/stores/terminal-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useOverridesStore } from "@/stores/overrides-store";
import { useNotificationStore } from "@/stores/notification-store";
import { CODEX_INPUT_PENDING_MARKER } from "@/lib/activity-detection";

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
const mockOnCursorMove = vi.fn().mockReturnValue({ dispose: vi.fn() });
const mockOnWriteParsed = vi.fn().mockReturnValue({ dispose: vi.fn() });
const mockOnRender = vi.fn().mockReturnValue({ dispose: vi.fn() });
const createdTerminals: Array<{ options: Record<string, unknown> }> = [];
const mockModes = { synchronizedOutputMode: false };
let capturedKeyHandler: ((e: KeyboardEvent) => boolean) | null = null;
const mockAttachCustomKeyEventHandler = vi.fn((handler: (e: KeyboardEvent) => boolean) => {
  capturedKeyHandler = handler;
});
const mockWrite = vi.fn((_: string | Uint8Array, callback?: () => void) => {
  callback?.();
});
const mockRefresh = vi.fn();
const mockClearTextureAtlas = vi.fn();
const mockRegisterCsiHandler = vi.fn();
const mockRegisterOscHandler = vi.fn();
const mockRegisterEscHandler = vi.fn();
const csiHandlers = new Map<
  string,
  (params: readonly (number | number[])[]) => boolean | Promise<boolean>
>();
const oscHandlers = new Map<string, (data: string) => boolean | Promise<boolean>>();
const escHandlers = new Map<string, () => boolean | Promise<boolean>>();
const mockRequestAnimationFrame = vi.fn((callback: FrameRequestCallback) =>
  window.setTimeout(() => callback(performance.now()), 0),
);
const mockCancelAnimationFrame = vi.fn((handle: number) => window.clearTimeout(handle));
vi.stubGlobal("requestAnimationFrame", mockRequestAnimationFrame);
vi.stubGlobal("cancelAnimationFrame", mockCancelAnimationFrame);

// jsdom doesn't expose navigator.clipboard; stub a minimal readText/writeText
// so the plain-paste fallback in runTerminalPaste doesn't throw.
const mockClipboardReadText = vi.fn().mockResolvedValue("");
Object.defineProperty(globalThis.navigator, "clipboard", {
  value: { readText: mockClipboardReadText, writeText: vi.fn().mockResolvedValue(undefined) },
  configurable: true,
});
vi.mock("@xterm/xterm", () => ({
  Terminal: class MockTerminal {
    constructor(options: Record<string, unknown> = {}) {
      this.options = { ...options };
      createdTerminals.push(this);
    }
    open = vi.fn();
    write = mockWrite;
    onData = mockOnData;
    onResize = mockOnResize;
    onTitleChange = mockOnTitleChange;
    onSelectionChange = mockOnSelectionChange;
    onKey = mockOnKey;
    onCursorMove = mockOnCursorMove;
    onWriteParsed = mockOnWriteParsed;
    onRender = mockOnRender;
    attachCustomKeyEventHandler = mockAttachCustomKeyEventHandler;
    focus = mockFocus;
    blur = mockBlur;
    paste = mockPaste;
    hasSelection = mockHasSelection;
    getSelection = mockGetSelection;
    clearSelection = mockClearSelection;
    refresh = mockRefresh;
    clearTextureAtlas = mockClearTextureAtlas;
    dispose = vi.fn();
    loadAddon = vi.fn();
    registerLinkProvider = vi.fn().mockReturnValue({ dispose: vi.fn() });
    element = document.createElement("div");
    buffer = { active: { cursorX: 0, cursorY: 0 } };
    modes = mockModes;
    parser = {
      registerOscHandler: mockRegisterOscHandler.mockImplementation(
        (ident: number, callback: (data: string) => boolean | Promise<boolean>) => {
          oscHandlers.set(String(ident), callback);
          return { dispose: vi.fn() };
        },
      ),
      registerEscHandler: mockRegisterEscHandler.mockImplementation(
        (id: { final: string }, callback: () => boolean | Promise<boolean>) => {
          escHandlers.set(id.final, callback);
          return { dispose: vi.fn() };
        },
      ),
      registerCsiHandler: mockRegisterCsiHandler.mockImplementation(
        (
          id: { prefix?: string; final: string },
          callback: (params: readonly (number | number[])[]) => boolean | Promise<boolean>,
        ) => {
          csiHandlers.set(`${id.prefix ?? ""}:${id.final}`, callback);
          return { dispose: vi.fn() };
        },
      ),
    };
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
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

let capturedIndentedLinkHandler: ((uri: string) => void) | null = null;
vi.mock("@/lib/indented-link-provider", () => ({
  createIndentedLinkProvider: (_terminal: unknown, onClickLink: (uri: string) => void) => {
    capturedIndentedLinkHandler = onClickLink;
    return { provideLinks: vi.fn() };
  },
}));

vi.mock("@xterm/addon-webgl", () => {
  const WebglAddon = vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
    onContextLoss: vi.fn(),
  }));
  return { WebglAddon: WebglAddon };
});

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
const mockSetTerminalCwdSend = vi.fn().mockResolvedValue(undefined);
const mockSetTerminalCwdReceive = vi.fn().mockResolvedValue(undefined);
const mockOpenExternal = vi.fn().mockResolvedValue(undefined);
const mockMarkClaudeTerminal = vi.fn().mockResolvedValue(true);
const mockMarkCodexTerminal = vi.fn().mockResolvedValue(true);
const mockLoadTerminalOutputCache = vi
  .fn()
  .mockRejectedValue(new Error("Cache not found: /fake/path.dat"));

vi.mock("@/lib/tauri-api", () => ({
  createTerminalSession: (...args: unknown[]) => mockCreateTerminalSession(...args),
  writeToTerminal: (...args: unknown[]) => mockWriteToTerminal(...args),
  resizeTerminal: (...args: unknown[]) => mockResizeTerminal(...args),
  closeTerminalSession: (...args: unknown[]) => mockCloseTerminalSession(...args),
  onTerminalOutput: (...args: unknown[]) => mockOnTerminalOutput(...args),
  smartPaste: (...args: unknown[]) => mockSmartPaste(...args),
  clipboardWriteText: (...args: unknown[]) => mockClipboardWriteText(...args),
  setTerminalCwdSend: (...args: unknown[]) => mockSetTerminalCwdSend(...args),
  setTerminalCwdReceive: (...args: unknown[]) => mockSetTerminalCwdReceive(...args),
  updateTerminalSyncGroup: vi.fn().mockResolvedValue(undefined),
  openExternal: (...args: unknown[]) => mockOpenExternal(...args),
  loadTerminalOutputCache: (...args: unknown[]) => mockLoadTerminalOutputCache(...args),
  markClaudeTerminal: (...args: unknown[]) => mockMarkClaudeTerminal(...args),
  markCodexTerminal: (...args: unknown[]) => mockMarkCodexTerminal(...args),
}));

describe("TerminalView", () => {
  beforeEach(() => {
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useOverridesStore.setState({ paneOverrides: {}, viewOverrides: {} });
    useNotificationStore.setState({ notifications: [] });
    localStorage.clear();
    capturedKeyHandler = null;
    capturedLinkHandler = null;
    capturedIndentedLinkHandler = null;
    createdTerminals.length = 0;
    csiHandlers.clear();
    oscHandlers.clear();
    escHandlers.clear();
    mockModes.synchronizedOutputMode = false;
    _resetWebglStagger();
    vi.clearAllMocks();
  });

  it("renders terminal container", () => {
    render(<TerminalView instanceId="t1" profile="PowerShell" syncGroup="default" />);
    expect(screen.getByTestId("terminal-view-t1")).toBeInTheDocument();
  });

  it("shows a loading overlay until the first render event arrives", async () => {
    render(<TerminalView instanceId="t-loading" profile="PowerShell" syncGroup="" />);

    // Wait for ResizeObserver → terminal.open() → onRender subscription.
    await vi.waitFor(() => {
      expect(mockOnRender).toHaveBeenCalled();
    });

    const overlay = screen.getByTestId("terminal-loading-t-loading");
    expect(overlay).toHaveClass("visible");

    const renderHandler = mockOnRender.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    await act(async () => {
      renderHandler?.();
    });

    expect(overlay).not.toHaveClass("visible");
  });

  it("keeps the loading overlay visible when toggling back to a previously ready profile", async () => {
    const { rerender } = render(
      <TerminalView instanceId="t-toggle" profile="PowerShell" syncGroup="" />,
    );

    await vi.waitFor(() => {
      expect(mockOnRender).toHaveBeenCalled();
    });

    // First PowerShell terminal becomes ready.
    const firstHandler = mockOnRender.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    await act(async () => {
      firstHandler?.();
    });
    expect(screen.getByTestId("terminal-loading-t-toggle")).not.toHaveClass("visible");

    // Switch to WSL — overlay reappears for the new terminal.
    await act(async () => {
      rerender(<TerminalView instanceId="t-toggle" profile="WSL" syncGroup="" />);
    });
    expect(screen.getByTestId("terminal-loading-t-toggle")).toHaveClass("visible");

    // Switch back to PowerShell BEFORE WSL ever fires onRender. The new PS
    // xterm has not painted yet, so the overlay must remain visible —
    // a string-key cache would incorrectly mark it ready here.
    const callsBeforeFinalSwitch = mockOnRender.mock.calls.length;
    await act(async () => {
      rerender(<TerminalView instanceId="t-toggle" profile="PowerShell" syncGroup="" />);
    });
    expect(screen.getByTestId("terminal-loading-t-toggle")).toHaveClass("visible");

    // The newly recreated PS terminal eventually fires its own onRender.
    await vi.waitFor(() => {
      expect(mockOnRender.mock.calls.length).toBeGreaterThan(callsBeforeFinalSwitch);
    });
    const newHandler = mockOnRender.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    await act(async () => {
      newHandler?.();
    });
    expect(screen.getByTestId("terminal-loading-t-toggle")).not.toHaveClass("visible");
  });

  it("re-shows the loading overlay when the underlying terminal is recreated", async () => {
    const { rerender } = render(
      <TerminalView instanceId="t-recreate" profile="PowerShell" syncGroup="" />,
    );

    await vi.waitFor(() => {
      expect(mockOnRender).toHaveBeenCalled();
    });

    const firstHandler = mockOnRender.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    await act(async () => {
      firstHandler?.();
    });
    expect(screen.getByTestId("terminal-loading-t-recreate")).not.toHaveClass("visible");

    // Profile change rebuilds xterm. Overlay must reappear before the next paint.
    const callsBeforeRebuild = mockOnRender.mock.calls.length;
    await act(async () => {
      rerender(<TerminalView instanceId="t-recreate" profile="WSL" syncGroup="" />);
    });

    expect(screen.getByTestId("terminal-loading-t-recreate")).toHaveClass("visible");

    await vi.waitFor(() => {
      expect(mockOnRender.mock.calls.length).toBeGreaterThan(callsBeforeRebuild);
    });
    const secondHandler = mockOnRender.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    await act(async () => {
      secondHandler?.();
    });
    expect(screen.getByTestId("terminal-loading-t-recreate")).not.toHaveClass("visible");
  });

  it("applies cursor shape and blink from profile settings", () => {
    useSettingsStore.getState().updateProfile(0, {
      cursorShape: "underscore",
      cursorBlink: false,
    });

    render(<TerminalView instanceId="t-cursor-settings" profile="PowerShell" syncGroup="" />);

    expect(createdTerminals).toHaveLength(1);
    expect(createdTerminals[0].options.cursorStyle).toBe("underline");
    expect(createdTerminals[0].options.cursorBlink).toBe(false);
  });

  it("clears cursorWidth when switching away from bar cursor", async () => {
    render(<TerminalView instanceId="t-cursor-width" profile="PowerShell" syncGroup="" />);

    expect(createdTerminals).toHaveLength(1);
    expect(createdTerminals[0].options.cursorStyle).toBe("bar");
    expect(createdTerminals[0].options.cursorWidth).toBe(1);

    act(() => {
      useSettingsStore.getState().updateProfile(0, { cursorShape: "underscore" });
    });

    await vi.waitFor(() => {
      expect(createdTerminals[0].options.cursorStyle).toBe("underline");
      expect("cursorWidth" in createdTerminals[0].options).toBe(false);
    });
  });

  it("updates terminal options on cursor settings change without re-fitting", async () => {
    // xterm applies option changes (cursor style/blink) on the next paint
    // automatically — there is no need to call fit() or refresh(). Coupling
    // those calls to cursor-setting changes turned activity transitions
    // (Codex start/exit) into atlas-rebuild bursts that race with TUI exit
    // sequences.
    render(<TerminalView instanceId="t-settings-refresh" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
    });

    mockFit.mockClear();
    mockRefresh.mockClear();

    act(() => {
      useSettingsStore.getState().updateProfile(0, {
        cursorShape: "underscore",
        cursorBlink: false,
      });
    });

    await vi.waitFor(() => {
      expect(createdTerminals[0].options.cursorStyle).toBe("underline");
      expect(createdTerminals[0].options.cursorBlink).toBe(false);
    });
    expect(mockFit).not.toHaveBeenCalled();
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("updates an existing terminal when profile defaults change", async () => {
    render(<TerminalView instanceId="t-defaults-refresh" profile="PowerShell" syncGroup="" />);

    expect(createdTerminals[0].options.cursorBlink).toBe(true);
    expect(createdTerminals[0].options.cursorStyle).toBe("bar");

    act(() => {
      useSettingsStore.getState().setProfileDefaults({
        cursorBlink: false,
        cursorShape: "filledBox",
      });
    });

    await vi.waitFor(() => {
      expect(createdTerminals[0].options.cursorBlink).toBe(false);
      expect(createdTerminals[0].options.cursorStyle).toBe("block");
    });
  });

  it("disables cursor blink while Codex is active when codex override is enabled", async () => {
    render(<TerminalView instanceId="t-codex-blink" profile="PowerShell" syncGroup="" />);

    expect(createdTerminals).toHaveLength(1);
    expect(createdTerminals[0].options.cursorBlink).toBe(true);

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-codex-blink", {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });

    await vi.waitFor(() => {
      expect(createdTerminals[0].options.cursorBlink).toBe(false);
    });
  });

  it("uses overlay caret mode for Codex but not Claude", async () => {
    const { rerender } = render(
      <TerminalView instanceId="t-overlay-mode" profile="PowerShell" syncGroup="" />,
    );

    const container = screen.getByTestId("terminal-view-t-overlay-mode");
    expect(container).not.toHaveClass("terminal-native-cursor-hidden");

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-overlay-mode", {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });

    await vi.waitFor(() => {
      expect(container).toHaveClass("terminal-native-cursor-hidden");
    });
    expect(createdTerminals[0].options.cursorStyle).toBe("bar");
    expect(createdTerminals[0].options.cursorWidth).toBe(1);
    expect(createdTerminals[0].options.cursorBlink).toBe(false);

    // Claude Code uses DEC 2026 synchronized output which keeps the native
    // cursor at the correct position — overlay is not applied.
    rerender(<TerminalView instanceId="t-overlay-mode" profile="PowerShell" syncGroup="" />);
    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-overlay-mode", {
        activity: { type: "interactiveApp", name: "Claude" },
      });
    });

    await vi.waitFor(() => {
      expect(container).not.toHaveClass("terminal-native-cursor-hidden");
    });
  });

  it("uses the configured cursor color for the overlay caret", async () => {
    useSettingsStore.getState().updateProfile(0, { colorScheme: "One Half Light" });

    render(<TerminalView instanceId="t-overlay-color" profile="PowerShell" syncGroup="" />);

    const container = screen.getByTestId("terminal-view-t-overlay-color");
    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-overlay-color", {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });

    await vi.waitFor(() => {
      expect(container).toHaveStyle({ "--terminal-overlay-caret-color": "#4F525D" });
    });
  });

  it("renders the overlay caret using the configured cursor shape", async () => {
    useSettingsStore.getState().updateProfile(0, { cursorShape: "underscore" });

    render(
      <TerminalView instanceId="t-overlay-shape" profile="PowerShell" syncGroup="" isFocused />,
    );

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-overlay-shape", {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });

    const container = screen.getByTestId("terminal-view-t-overlay-shape");
    const overlay = screen.getByTestId("terminal-overlay-caret-t-overlay-shape");
    const terminal = createdTerminals[0] as unknown as {
      element: HTMLDivElement;
      buffer: { active: { cursorX: number; cursorY: number; baseY?: number } };
    };
    const screenEl = document.createElement("div");
    screenEl.className = "xterm-screen";
    screenEl.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 800,
        height: 480,
        right: 800,
        bottom: 480,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    terminal.element.appendChild(screenEl);
    container.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 800,
        height: 480,
        right: 800,
        bottom: 480,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    terminal.buffer.active.baseY = 0;
    terminal.buffer.active.cursorX = 2;
    terminal.buffer.active.cursorY = 4;

    await act(async () => {
      await oscHandlers.get("133")?.("B");
    });

    await vi.waitFor(() => {
      expect(overlay.style.width).toBe("10px");
      expect(overlay.style.height).toBe("2px");
      expect(overlay.style.transform).toBe("translate(20px, 98px)");
    });

    act(() => {
      useSettingsStore.getState().updateProfile(0, { cursorShape: "filledBox" });
    });

    await vi.waitFor(() => {
      expect(overlay.style.width).toBe("10px");
      expect(overlay.style.height).toBe("20px");
      expect(overlay.style.transform).toBe("translate(20px, 80px)");
    });
  });

  it("keeps the overlay caret pinned to the input cursor during repaint save/restore", async () => {
    render(
      <TerminalView instanceId="t-shadow-cursor" profile="PowerShell" syncGroup="" isFocused />,
    );

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-shadow-cursor", {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });

    const container = screen.getByTestId("terminal-view-t-shadow-cursor");
    const overlay = screen.getByTestId("terminal-overlay-caret-t-shadow-cursor");
    const terminal = createdTerminals[0] as unknown as {
      element: HTMLDivElement;
      buffer: { active: { cursorX: number; cursorY: number; baseY?: number } };
    };
    const screenEl = document.createElement("div");
    screenEl.className = "xterm-screen";
    screenEl.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 800,
        height: 480,
        right: 800,
        bottom: 480,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    terminal.element.appendChild(screenEl);
    container.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 800,
        height: 480,
        right: 800,
        bottom: 480,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    terminal.buffer.active.baseY = 0;
    terminal.buffer.active.cursorX = 2;
    terminal.buffer.active.cursorY = 4;

    await act(async () => {
      await oscHandlers.get("133")?.("B");
    });

    await vi.waitFor(() => {
      expect(overlay.style.transform).toBe("translate(20px, 80px)");
      expect(overlay.style.opacity).toBe("1");
    });

    terminal.buffer.active.cursorX = 20;
    terminal.buffer.active.cursorY = 10;

    await act(async () => {
      await csiHandlers.get(":s")?.([]);
      const renderHandler = mockOnRender.mock.calls.at(-1)?.[0] as (() => void) | undefined;
      renderHandler?.();
    });

    await vi.waitFor(() => {
      expect(overlay.style.transform).toBe("translate(20px, 80px)");
    });

    await act(async () => {
      await csiHandlers.get(":u")?.([]);
    });

    await vi.waitFor(() => {
      expect(overlay.style.transform).toBe("translate(200px, 200px)");
    });
  });

  it("keeps the IME composition preview from covering text after a middle insert", async () => {
    render(<TerminalView instanceId="t-ime-middle" profile="PowerShell" syncGroup="" isFocused />);

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-ime-middle", {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });

    const container = screen.getByTestId("terminal-view-t-ime-middle");
    const preview = screen.getByTestId("terminal-composition-preview-t-ime-middle");
    const overlay = screen.getByTestId("terminal-overlay-caret-t-ime-middle");
    const terminal = createdTerminals[0] as unknown as {
      element: HTMLDivElement;
      buffer: { active: { cursorX: number; cursorY: number; baseY?: number } };
    };
    const screenEl = document.createElement("div");
    screenEl.className = "xterm-screen";
    screenEl.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 800,
        height: 480,
        right: 800,
        bottom: 480,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    terminal.element.appendChild(screenEl);
    terminal.element.appendChild(helper);
    container.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 800,
        height: 480,
        right: 800,
        bottom: 480,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect;

    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
    });

    terminal.buffer.active.baseY = 0;
    terminal.buffer.active.cursorX = 9;
    terminal.buffer.active.cursorY = 4;
    await act(async () => {
      await oscHandlers.get("133")?.("B");
    });

    helper.value = "\uAC00 \uB098\uB2E4\uB9C8";
    helper.selectionStart = 2;
    helper.selectionEnd = 2;
    helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    helper.value = "\uAC00 \u3139\uB098\uB2E4\uB9C8";
    helper.selectionStart = 3;
    helper.selectionEnd = 3;
    helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\u3139" }));
    helper.dispatchEvent(new Event("input"));

    await vi.waitFor(() => {
      expect(preview.textContent).toBe("\u3139");
      expect(preview.style.transform).toBe("translate(30px, 80px)");
      expect(preview.style.width).toBe("20px");
      expect(overlay.style.transform).toBe("translate(50px, 80px)");
    });
  });

  it("hides the xterm cursor only during synchronized output frames", async () => {
    render(<TerminalView instanceId="t-sync-cursor" profile="PowerShell" syncGroup="" />);

    const container = screen.getByTestId("terminal-view-t-sync-cursor");
    expect(container).not.toHaveClass("terminal-sync-output-active");

    await act(async () => {
      await csiHandlers.get("?:h")?.([2026]);
    });
    expect(container).toHaveClass("terminal-sync-output-active");

    await act(async () => {
      await csiHandlers.get("?:l")?.([2026]);
    });
    expect(container).not.toHaveClass("terminal-sync-output-active");
  });

  it("tracks xterm synchronizedOutputMode after terminal.write", async () => {
    render(<TerminalView instanceId="t-sync-write" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });

    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;
    expect(onOutput).toBeTypeOf("function");

    const container = screen.getByTestId("terminal-view-t-sync-write");
    mockModes.synchronizedOutputMode = true;

    act(() => {
      onOutput?.(new TextEncoder().encode("\x1b[?2026hframe"));
    });

    await vi.waitFor(() => {
      expect(container).toHaveClass("terminal-sync-output-active");
    });

    mockModes.synchronizedOutputMode = false;
    await vi.waitFor(() => {
      expect(container).not.toHaveClass("terminal-sync-output-active");
    });
    expect(mockRequestAnimationFrame).toHaveBeenCalled();
  });

  it("falls back to native xterm cursor when interactive cursor stability is disabled", async () => {
    useSettingsStore.getState().updateProfile(0, { stabilizeInteractiveCursor: false });

    render(<TerminalView instanceId="t-native-cursor-mode" profile="PowerShell" syncGroup="" />);

    const container = screen.getByTestId("terminal-view-t-native-cursor-mode");
    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-native-cursor-mode", {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });

    await vi.waitFor(() => {
      expect(container).not.toHaveClass("terminal-native-cursor-hidden");
    });
    // With stabilizeInteractiveCursor disabled, native cursor settings are preserved
    // (cursorBlink follows profile default, cursorStyle follows profile shape)
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
        true, // cwdSend
        true, // cwdReceive
        undefined,
        undefined,
      );
    });
  });

  it("detects Codex from banner output without command-status", async () => {
    render(<TerminalView instanceId="t-codex" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });

    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;
    expect(onOutput).toBeTypeOf("function");

    act(() => {
      onOutput?.(
        new TextEncoder().encode(
          ">- OpenAI Codex (v0.118.0)\r\nmodel: gpt-5.4 medium\r\ndirectory: C:\\Users\\kochul\r\n",
        ),
      );
    });

    await vi.waitFor(() => {
      const instance = useTerminalStore.getState().instances.find((i) => i.id === "t-codex");
      expect(instance?.activity).toEqual({ type: "interactiveApp", name: "Codex" });
    });
  });

  it("seeds backend Codex tracking when codex resume is detected from command text", async () => {
    render(<TerminalView instanceId="t-codex-resume" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });

    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;
    expect(onOutput).toBeTypeOf("function");

    act(() => {
      onOutput?.(
        new TextEncoder().encode("\x1b]133;E;codex resume 129381204f-81293801\x07\x1b[?1049h"),
      );
    });

    await vi.waitFor(() => {
      const instance = useTerminalStore.getState().instances.find((i) => i.id === "t-codex-resume");
      expect(instance?.activity).toEqual({ type: "interactiveApp", name: "Codex" });
      expect(mockMarkCodexTerminal).toHaveBeenCalledWith("t-codex-resume");
    });
  });

  it("marks Codex approval prompts as input pending", async () => {
    render(<TerminalView instanceId="t-codex-prompt" profile="PowerShell" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-codex-prompt", {
      activity: { type: "interactiveApp", name: "Codex" },
    });

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });

    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;
    expect(onOutput).toBeTypeOf("function");

    act(() => {
      onOutput?.(
        new TextEncoder().encode(
          "Would you like to run the following command?\r\nPress enter to confirm or esc to cancel\r\n",
        ),
      );
    });

    expect(
      useTerminalStore.getState().instances.find((i) => i.id === "t-codex-prompt")?.activityMessage,
    ).toBe(CODEX_INPUT_PENDING_MARKER);

    act(() => {
      onOutput?.(new TextEncoder().encode("• continuing after approval\r\n"));
    });

    expect(
      useTerminalStore.getState().instances.find((i) => i.id === "t-codex-prompt")?.activityMessage,
    ).toBe("continuing after approval");
  });

  it("turns a running Codex approval prompt into input pending and emits one notification", async () => {
    render(<TerminalView instanceId="t-codex-running-prompt" profile="PowerShell" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-codex-running-prompt", {
      activity: { type: "running" },
      lastCommand: "npm test",
    });

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });

    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;
    expect(onOutput).toBeTypeOf("function");

    act(() => {
      onOutput?.(
        new TextEncoder().encode(
          "Would you like to run the following command?\r\n" +
            "Reason: Vitest spawn EPERM\r\n" +
            "$ npm test -- src/lib/activity-detection.test.ts\r\n" +
            "1. Yes, proceed (y)\r\n" +
            "3. No, and tell Codex what to do differently (esc)\r\n",
        ),
      );
    });

    const instance = useTerminalStore
      .getState()
      .instances.find((i) => i.id === "t-codex-running-prompt");
    expect(instance?.activity).toEqual({ type: "interactiveApp", name: "Codex" });
    expect(instance?.activityMessage).toBe(CODEX_INPUT_PENDING_MARKER);

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      terminalId: "t-codex-running-prompt",
      message: "Codex is waiting for your input",
      level: "info",
    });

    act(() => {
      onOutput?.(new TextEncoder().encode("Would you like to run the following command?\r\n"));
    });

    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });

  it("does not turn ordinary running output into Codex input pending", async () => {
    render(<TerminalView instanceId="t-ordinary-output" profile="PowerShell" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-ordinary-output", {
      activity: { type: "running" },
      lastCommand: "npm test",
    });

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });

    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;
    expect(onOutput).toBeTypeOf("function");

    act(() => {
      onOutput?.(
        new TextEncoder().encode(
          "Reason: retry budget exceeded\r\nPress Ctrl+C to cancel the process\r\n",
        ),
      );
    });

    const instance = useTerminalStore
      .getState()
      .instances.find((i) => i.id === "t-ordinary-output");
    expect(instance?.activity).toEqual({ type: "running" });
    expect(instance?.activityMessage).toBeUndefined();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it("does not re-notify from a stale Codex prompt in the rolling output tail", async () => {
    render(<TerminalView instanceId="t-stale-codex-prompt" profile="PowerShell" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-stale-codex-prompt", {
      activity: { type: "running" },
      lastCommand: "npm test",
    });

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });

    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;
    expect(onOutput).toBeTypeOf("function");

    act(() => {
      onOutput?.(
        new TextEncoder().encode(
          "Would you like to run the following command?\r\n" +
            "Reason: Vitest spawn EPERM\r\n" +
            "1. Yes, proceed (y)\r\n",
        ),
      );
    });
    expect(useNotificationStore.getState().notifications).toHaveLength(1);

    useTerminalStore.getState().updateInstanceInfo("t-stale-codex-prompt", {
      activity: { type: "running" },
      activityMessage: undefined,
    });

    act(() => {
      onOutput?.(new TextEncoder().encode("later output after the prompt was answered\r\n"));
    });

    const instance = useTerminalStore
      .getState()
      .instances.find((i) => i.id === "t-stale-codex-prompt");
    expect(instance?.activity).toEqual({ type: "running" });
    expect(instance?.activityMessage).toBeUndefined();
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });

  it("detects Codex approval prompts split across output chunks", async () => {
    render(<TerminalView instanceId="t-codex-split" profile="PowerShell" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-codex-split", {
      activity: { type: "interactiveApp", name: "Codex" },
    });

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });

    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;
    expect(onOutput).toBeTypeOf("function");

    act(() => {
      onOutput?.(new TextEncoder().encode("Would you like to run the fol"));
      onOutput?.(new TextEncoder().encode("lowing command?\r\nPress enter to con"));
      onOutput?.(new TextEncoder().encode("firm or esc to cancel\r\n"));
    });

    expect(
      useTerminalStore.getState().instances.find((i) => i.id === "t-codex-split")?.activityMessage,
    ).toBe(CODEX_INPUT_PENDING_MARKER);
  });

  it("parses Codex footer status messages from output", async () => {
    render(<TerminalView instanceId="t-codex-footer" profile="PowerShell" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-codex-footer", {
      activity: { type: "interactiveApp", name: "Codex" },
    });

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });

    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;
    expect(onOutput).toBeTypeOf("function");

    act(() => {
      onOutput?.(new TextEncoder().encode("gpt-5.4 medium · 93% left · C:\\Users\r\n"));
    });

    expect(
      useTerminalStore.getState().instances.find((i) => i.id === "t-codex-footer")?.activityMessage,
    ).toBe("gpt-5.4 medium · 93% left · C:\\Users");
  });

  it("prefers Codex assistant replies over footer status lines", async () => {
    render(<TerminalView instanceId="t-codex-reply" profile="PowerShell" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-codex-reply", {
      activity: { type: "interactiveApp", name: "Codex" },
    });

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });

    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;
    expect(onOutput).toBeTypeOf("function");

    act(() => {
      onOutput?.(
        new TextEncoder().encode(
          "> hello\r\n• Hello.\r\n> Improve documentation in @filename\r\ngpt-5.4 medium · 93% left · C:\\Users\r\n",
        ),
      );
    });

    expect(
      useTerminalStore.getState().instances.find((i) => i.id === "t-codex-reply")?.activityMessage,
    ).toBe("Hello.");
  });

  it("does not let Codex footer overwrite the last assistant reply", async () => {
    render(<TerminalView instanceId="t-codex-sticky-reply" profile="PowerShell" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-codex-sticky-reply", {
      activity: { type: "interactiveApp", name: "Codex" },
    });

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });

    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;
    expect(onOutput).toBeTypeOf("function");

    act(() => {
      onOutput?.(new TextEncoder().encode("> hello\r\n• Hello.\r\n"));
    });

    expect(
      useTerminalStore.getState().instances.find((i) => i.id === "t-codex-sticky-reply")
        ?.activityMessage,
    ).toBe("Hello.");

    act(() => {
      onOutput?.(
        new TextEncoder().encode("> what did you say\r\ngpt-5.4 medium · 93% left · C:\\Users\r\n"),
      );
    });

    expect(
      useTerminalStore.getState().instances.find((i) => i.id === "t-codex-sticky-reply")
        ?.activityMessage,
    ).toBe("Hello.");
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

  it("preserves structured prose whitespace when smartPaste returns text type", async () => {
    const pasted =
      "  subject.dvs_group_through     applied DGT\n" +
      "                                source of truth for subject context\n" +
      "  crf_schema.dvs_group_through  default for newly created subjects";
    mockSmartPaste.mockResolvedValue({ pasteType: "text", content: pasted });

    render(<TerminalView instanceId="t-paste-structured" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
    });

    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    capturedKeyHandler!(event);

    await vi.waitFor(() => {
      expect(mockPaste).toHaveBeenCalledWith(pasted);
    });
  });

  it("skips the smart paste pipeline when smartPaste is disabled but still consumes the key", async () => {
    // Override bindings like Ctrl+Shift+V can't rely on the browser's native
    // paste event, so the keybinding handler must always consume the event.
    // When smartPaste is off we just skip the Rust clipboard pipeline and
    // fall back to plain navigator.clipboard in runTerminalPaste.
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      convenience: {
        ...useSettingsStore.getState().convenience,
        smartPaste: false,
      },
    });

    render(<TerminalView instanceId="t-paste3" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
    });

    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    const result = capturedKeyHandler!(event);

    // Handler intercepts: return false + preventDefault, but smartPaste is
    // bypassed — plain clipboard paste is used instead.
    expect(result).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
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

  // -- terminal.copy keybinding --

  it("Ctrl+C with selection copies via clipboardWriteText (smartRemoveIndent default on)", async () => {
    mockHasSelection.mockReturnValue(true);
    mockGetSelection.mockReturnValue("copied text");

    render(<TerminalView instanceId="t-copy1" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
    });

    const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    const result = capturedKeyHandler!(event);

    expect(result).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(mockClipboardWriteText).toHaveBeenCalledWith("copied text");
  });

  it("Ctrl+C with empty selection lets xterm handle (SIGINT path)", async () => {
    mockHasSelection.mockReturnValue(false);

    render(<TerminalView instanceId="t-copy2" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
    });

    const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true });
    const result = capturedKeyHandler!(event);

    expect(result).toBe(true);
    expect(mockClipboardWriteText).not.toHaveBeenCalled();
  });

  it("terminal.copy with all smart-copy toggles off copies raw getSelection (no trim)", async () => {
    // Regression guard for PR review point #2: prepareSelectionForCopy always
    // trims trailing whitespace regardless of which transforms are selected,
    // so we must bypass it when *all* smart toggles are off to preserve the
    // old native-Ctrl+C clipboard contents byte-for-byte.
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      convenience: {
        ...useSettingsStore.getState().convenience,
        smartRemoveIndent: false,
        smartRemoveLineBreak: false,
      },
    });
    mockHasSelection.mockReturnValue(true);
    // Selection with trailing whitespace + blank line that prepareSelectionForCopy
    // would strip. If the raw branch is taken, the trailing spaces survive.
    const raw = "line with trailing   \n\n";
    mockGetSelection.mockReturnValue(raw);

    render(<TerminalView instanceId="t-copy3" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
    });

    const event = new KeyboardEvent("keydown", { key: "c", ctrlKey: true });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    capturedKeyHandler!(event);

    expect(mockClipboardWriteText).toHaveBeenCalledWith(raw);
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

    // Right-click paste uses terminal.paste() for bracketed paste support (same as Ctrl+V)
    await vi.waitFor(() => {
      expect(mockPaste).toHaveBeenCalledWith("pasted text");
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

  it("copy-on-select with all smart-copy toggles off writes raw selection (shared runTerminalCopy path)", async () => {
    // Proves the three copy sites (Ctrl+C, right-click, copy-on-select)
    // share runTerminalCopy — raw-when-off semantics apply uniformly.
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      convenience: {
        ...useSettingsStore.getState().convenience,
        copyOnSelect: true,
        smartRemoveIndent: false,
        smartRemoveLineBreak: false,
      },
    });
    mockHasSelection.mockReturnValue(true);
    const raw = "trailing ws   \n\n";
    mockGetSelection.mockReturnValue(raw);

    render(<TerminalView instanceId="t-cos-raw" profile="PowerShell" syncGroup="" />);

    const selectionCallback = mockOnSelectionChange.mock.calls[0][0];
    selectionCallback();

    await vi.waitFor(() => {
      expect(mockClipboardWriteText).toHaveBeenCalledWith(raw);
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

  // -- Issue #230: drag ending outside the terminal still copies selection --

  it("auto-copies when drag starts in terminal and pointerup fires on window (outside)", async () => {
    // Reproduces #230: user drags inside the terminal, pointer leaves the
    // terminal DOM (or even the browser), and the drag ends outside. The
    // onSelectionChange path may miss the final confirmation, so a
    // pointerdown→window-pointerup watcher guarantees the copy happens.
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      convenience: { ...useSettingsStore.getState().convenience, copyOnSelect: true },
    });
    mockHasSelection.mockReturnValue(true);
    mockGetSelection.mockReturnValue("dragged outside text");

    render(<TerminalView instanceId="t-drag-outside" profile="PowerShell" syncGroup="" />);

    // Wait for terminal.open() → ResizeObserver path to settle. The test
    // harness resolves ResizeObserver asynchronously, but the pointerdown
    // listener is attached synchronously in the main effect, so we can
    // dispatch immediately on the outer container.
    const outer = screen.getByTestId("terminal-view-t-drag-outside");

    // Simulate drag start inside the terminal.
    outer.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    // Clear any copies triggered by onSelectionChange during the drag.
    mockClipboardWriteText.mockClear();

    // Drag ends outside — pointerup fires on window, not the terminal.
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));

    await vi.waitFor(() => {
      expect(mockClipboardWriteText).toHaveBeenCalledWith("dragged outside text");
    });
  });

  it("does not copy on window pointerup without a preceding pointerdown in the terminal", async () => {
    // Guard: an unrelated pointerup anywhere on the page must not copy.
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      convenience: { ...useSettingsStore.getState().convenience, copyOnSelect: true },
    });
    mockHasSelection.mockReturnValue(true);
    mockGetSelection.mockReturnValue("unrelated selection");

    render(<TerminalView instanceId="t-drag-guard" profile="PowerShell" syncGroup="" />);

    // No pointerdown on the terminal → nothing should be listening for pointerup.
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));

    // onSelectionChange path is independent; this guard only asserts the
    // pointerup-driven copy doesn't fire spuriously.
    expect(mockClipboardWriteText).not.toHaveBeenCalledWith("unrelated selection");
  });

  it("does not copy on pointerup when copyOnSelect is disabled", async () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      convenience: { ...useSettingsStore.getState().convenience, copyOnSelect: false },
    });
    mockHasSelection.mockReturnValue(true);
    mockGetSelection.mockReturnValue("ignored text");

    render(<TerminalView instanceId="t-drag-off" profile="PowerShell" syncGroup="" />);
    const outer = screen.getByTestId("terminal-view-t-drag-off");

    outer.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));

    expect(mockClipboardWriteText).not.toHaveBeenCalled();
  });

  // -- Hide mouse cursor on typing --

  it("hides mouse cursor when typing in terminal (onKey)", async () => {
    render(<TerminalView instanceId="t-cursor1" profile="PowerShell" syncGroup="" />);

    // Capture the onKey callback
    expect(mockOnKey).toHaveBeenCalled();
    const onKeyCallback = mockOnKey.mock.calls[0][0];

    // outerEl in the component is containerRef.current?.parentElement
    // containerRef is on the inner div, parentElement is the data-testid div
    const testIdDiv = screen.getByTestId("terminal-view-t-cursor1");
    expect(testIdDiv.style.cursor).toBe("");

    // Simulate typing via terminal.onKey
    onKeyCallback({ key: "a", domEvent: new KeyboardEvent("keydown", { key: "a" }) });

    expect(testIdDiv.style.cursor).toBe("none");
  });

  it("restores mouse cursor on mouse move after typing", async () => {
    render(<TerminalView instanceId="t-cursor2" profile="PowerShell" syncGroup="" />);

    const onKeyCallback = mockOnKey.mock.calls[0][0];
    const testIdDiv = screen.getByTestId("terminal-view-t-cursor2");

    // Type to hide cursor
    onKeyCallback({ key: "a", domEvent: new KeyboardEvent("keydown", { key: "a" }) });
    expect(testIdDiv.style.cursor).toBe("none");

    // Move mouse to restore cursor
    testIdDiv.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    expect(testIdDiv.style.cursor).toBe("");
  });

  // -- Font zoom via keybindings (Ctrl+= / Ctrl+- / Ctrl+0) --

  /** xterm의 customKeyEventHandler를 직접 호출한다. 반환값은 "xterm이 이 키를 추가 처리할지". */
  function fireTerminalKey(init: Partial<KeyboardEventInit> & { key: string }): {
    handled: boolean;
    preventDefault: ReturnType<typeof vi.fn>;
  } {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    const preventDefault = vi.spyOn(event, "preventDefault") as unknown as ReturnType<typeof vi.fn>;
    // xterm이 처리한다고 신호: false. 추가 전달: true.
    const result = capturedKeyHandler ? capturedKeyHandler(event) : true;
    return { handled: !result, preventDefault };
  }

  it("Ctrl+= increases font size (writes view override, not profile)", async () => {
    render(
      <TerminalView instanceId="t-zoom1" paneId="pane-zoom1" profile="PowerShell" syncGroup="" />,
    );

    const { handled, preventDefault } = fireTerminalKey({ key: "=", ctrlKey: true });

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalled();
    expect(useOverridesStore.getState().getViewOverride("pane-zoom1")?.fontSize).toBe(15);
    expect(useSettingsStore.getState().profiles[0].font).toBeUndefined();
  });

  it("Ctrl+- decreases font size (writes view override, not profile)", async () => {
    render(
      <TerminalView instanceId="t-zoom2" paneId="pane-zoom2" profile="PowerShell" syncGroup="" />,
    );

    const { handled } = fireTerminalKey({ key: "-", ctrlKey: true });

    expect(handled).toBe(true);
    expect(useOverridesStore.getState().getViewOverride("pane-zoom2")?.fontSize).toBe(13);
    expect(useSettingsStore.getState().profiles[0].font).toBeUndefined();
  });

  it("Ctrl+0 clears the view override (resets to profile default)", async () => {
    useOverridesStore.getState().setViewOverride("pane-zoom-reset", { fontSize: 20 });

    render(
      <TerminalView
        instanceId="t-zoom-reset"
        paneId="pane-zoom-reset"
        profile="PowerShell"
        syncGroup=""
      />,
    );

    const { handled } = fireTerminalKey({ key: "0", ctrlKey: true });

    expect(handled).toBe(true);
    expect(useOverridesStore.getState().getViewOverride("pane-zoom-reset")).toBeUndefined();
  });

  it("does not zoom when the key is pressed without Ctrl", async () => {
    render(
      <TerminalView
        instanceId="t-zoom-nomod"
        paneId="pane-zoom-nomod"
        profile="PowerShell"
        syncGroup=""
      />,
    );

    // ctrlKey false → xterm이 처리하도록 통과, override 그대로.
    fireTerminalKey({ key: "=", ctrlKey: false });
    fireTerminalKey({ key: "-", ctrlKey: false });
    fireTerminalKey({ key: "0", ctrlKey: false });

    expect(useOverridesStore.getState().getViewOverride("pane-zoom-nomod")).toBeUndefined();
  });

  it("zoomOut clamps font size to minimum 6", async () => {
    useOverridesStore.getState().setViewOverride("pane-zoom-min", { fontSize: 6 });

    render(
      <TerminalView
        instanceId="t-zoom-min"
        paneId="pane-zoom-min"
        profile="PowerShell"
        syncGroup=""
      />,
    );

    fireTerminalKey({ key: "-", ctrlKey: true });

    expect(useOverridesStore.getState().getViewOverride("pane-zoom-min")?.fontSize).toBe(6);
  });

  it("zoomIn clamps font size to maximum 72", async () => {
    useOverridesStore.getState().setViewOverride("pane-zoom-max", { fontSize: 72 });

    render(
      <TerminalView
        instanceId="t-zoom-max"
        paneId="pane-zoom-max"
        profile="PowerShell"
        syncGroup=""
      />,
    );

    fireTerminalKey({ key: "=", ctrlKey: true });

    expect(useOverridesStore.getState().getViewOverride("pane-zoom-max")?.fontSize).toBe(72);
  });

  it("zoom on one pane does not affect another pane with the same profile", async () => {
    render(<TerminalView instanceId="t-zoomA" paneId="pane-A" profile="PowerShell" syncGroup="" />);
    // 각 TerminalView가 자신의 customKeyEventHandler를 등록하는데, 마지막에 등록된
    // handler가 capturedKeyHandler에 남는다. 그래서 두 번째 render는 pane-B의
    // handler로 capturedKeyHandler를 덮어쓴다. 이 테스트에서는 pane-A만 대상으로
    // 하므로 pane-B는 render하지 않고 override 공간만 격리되는지 확인한다.

    fireTerminalKey({ key: "=", ctrlKey: true });

    expect(useOverridesStore.getState().getViewOverride("pane-A")?.fontSize).toBe(15);
    expect(useOverridesStore.getState().getViewOverride("pane-B")).toBeUndefined();
    expect(useSettingsStore.getState().profiles[0].font).toBeUndefined();
  });

  it("zoom keybindings are a no-op when paneId prop is absent", async () => {
    render(<TerminalView instanceId="t-zoom-nopane" profile="PowerShell" syncGroup="" />);

    fireTerminalKey({ key: "=", ctrlKey: true });
    fireTerminalKey({ key: "-", ctrlKey: true });
    fireTerminalKey({ key: "0", ctrlKey: true });

    expect(Object.keys(useOverridesStore.getState().viewOverrides)).toHaveLength(0);
    expect(useSettingsStore.getState().profiles[0].font).toBeUndefined();
  });

  // -- Regression: issue #224 — resize/zoom leaves glyphs left-clustered --
  //
  // When fontSize changes (zoom, settings update) the WebGL renderer's
  // texture atlas still holds glyphs measured at the OLD cell dimensions.
  // xterm's `refresh()` alone does not rebuild the atlas, so cells drawn
  // afterwards use stale cell widths and glyphs visibly collapse to the
  // left. The fix: call `term.clearTextureAtlas()` whenever fontSize or
  // fontFamily changes, *after* `fit()` so the renderer re-measures first.
  it("schedules a single deferred reflow and clears texture atlas when fontSize changes (issue #224)", async () => {
    render(
      <TerminalView
        instanceId="t-atlas-fontsize"
        paneId="pane-atlas-fontsize"
        profile="PowerShell"
        syncGroup=""
      />,
    );

    // Clear the initial-mount bookkeeping calls so we only observe the
    // font-change-triggered invocation.
    mockClearTextureAtlas.mockClear();
    mockFit.mockClear();
    mockRequestAnimationFrame.mockClear();

    act(() => {
      useOverridesStore.getState().setViewOverride("pane-atlas-fontsize", { fontSize: 20 });
    });

    await vi.waitFor(() => {
      // Font metrics settle one frame after the option write, so the fix
      // schedules the fit + atlas rebuild in a single rAF (avoiding the
      // double-call burst that races with TUI exit sequences).
      expect(mockFit).toHaveBeenCalled();
      expect(mockClearTextureAtlas).toHaveBeenCalled();
      expect(mockRequestAnimationFrame).toHaveBeenCalled();
    });
  });

  // -- Regression: reflow must NOT fire on activity / cursor changes --
  //
  // The font/cursor option-update effect runs whenever Codex starts/exits
  // (`nativeCursorHidden` toggles), focus moves, or cursor shape is edited.
  // Coupling fit() + clearTextureAtlas() to that effect causes WebGL atlas
  // rebuild bursts to overlap with TUI exit sequences (`ESC[?1049l`,
  // scrollback re-emit), which is when glyph corruption surfaces in
  // adjacent panes. Cell geometry only moves on font changes — so reflow
  // must be gated to font.
  it("does not reflow when Codex activity toggles native cursor hidden", async () => {
    render(
      <TerminalView
        instanceId="t-no-reflow-activity"
        paneId="pane-no-reflow-activity"
        profile="PowerShell"
        syncGroup=""
      />,
    );

    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
    });

    mockClearTextureAtlas.mockClear();
    mockFit.mockClear();

    // Codex starts → nativeCursorHidden flips on.
    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-no-reflow-activity", {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });
    // Codex exits → nativeCursorHidden flips off (this is the burst window).
    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-no-reflow-activity", {
        activity: { type: "shell" },
      });
    });

    expect(mockFit).not.toHaveBeenCalled();
    expect(mockClearTextureAtlas).not.toHaveBeenCalled();
  });

  it("does not reflow when cursor shape changes", async () => {
    render(
      <TerminalView
        instanceId="t-no-reflow-cursor"
        paneId="pane-no-reflow-cursor"
        profile="PowerShell"
        syncGroup=""
      />,
    );

    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
    });

    mockClearTextureAtlas.mockClear();
    mockFit.mockClear();

    act(() => {
      useSettingsStore.getState().updateProfile(0, { cursorShape: "underscore" });
    });

    // Options should still update, but no fit/atlas rebuild should fire.
    await vi.waitFor(() => {
      expect(createdTerminals[0].options.cursorStyle).toBe("underline");
    });
    expect(mockFit).not.toHaveBeenCalled();
    expect(mockClearTextureAtlas).not.toHaveBeenCalled();
  });

  it("clears texture atlas when devicePixelRatio changes (issue #224)", async () => {
    // Install a `window.matchMedia` stub that captures the change listener
    // so the test can synthesise a DPR change without actually zooming.
    type DprMql = {
      matches: boolean;
      media: string;
      listeners: Array<(e: MediaQueryListEvent) => void>;
      addEventListener: (type: string, cb: (e: MediaQueryListEvent) => void) => void;
      removeEventListener: (type: string, cb: (e: MediaQueryListEvent) => void) => void;
      dispatchEvent: (e: Event) => boolean;
      onchange: null;
      addListener: () => void;
      removeListener: () => void;
    };
    const mqls: DprMql[] = [];
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn((query: string) => {
      const mql: DprMql = {
        matches: true,
        media: query,
        listeners: [],
        addEventListener: (type, cb) => {
          if (type === "change") mql.listeners.push(cb);
        },
        removeEventListener: (type, cb) => {
          if (type === "change") mql.listeners = mql.listeners.filter((l) => l !== cb);
        },
        dispatchEvent: () => true,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
      };
      mqls.push(mql);
      return mql as unknown as MediaQueryList;
    }) as unknown as typeof window.matchMedia;

    try {
      render(<TerminalView instanceId="t-atlas-dpr" profile="PowerShell" syncGroup="" />);

      mockClearTextureAtlas.mockClear();
      mockFit.mockClear();

      // Simulate DPR change (e.g. browser zoom). The listener registered by
      // TerminalView must respond by re-fitting and clearing the atlas.
      expect(mqls.length).toBeGreaterThan(0);
      const listeners = mqls.flatMap((mql) => mql.listeners);
      expect(listeners.length).toBeGreaterThan(0);

      act(() => {
        for (const listener of listeners) {
          listener(new Event("change") as MediaQueryListEvent);
        }
      });

      await vi.waitFor(() => {
        expect(mockFit).toHaveBeenCalled();
        expect(mockClearTextureAtlas).toHaveBeenCalled();
      });
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  // -- Regression: issue #232 — workspace return leaves glyphs garbled --
  //
  // WorkspaceArea / PaneGrid hide inactive workspaces and panes via
  // `display: none`, which fires a 0×0 ResizeObserver entry without
  // unmounting TerminalView. While hidden, the WebGL texture atlas can
  // drift out of sync (e.g. a devicePixelRatio change fires on a 0-size
  // terminal and cannot rebuild anything, or the atlas was already sized
  // for the pre-hide cell geometry). On the return trip from hidden
  // (non-zero size again) the renderer must force a full atlas rebuild;
  // otherwise every row renders with stale, scrambled glyphs over the
  // otherwise-correct background cell colors.
  it("clears texture atlas when the container returns from hidden (issue #232)", async () => {
    type Observer = {
      target: Element | null;
      callback: (entries: ResizeObserverEntry[], obs: ResizeObserver) => void;
    };
    const observers: Observer[] = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      private obs: Observer;
      constructor(cb: (entries: ResizeObserverEntry[], obs: ResizeObserver) => void) {
        this.obs = { target: null, callback: cb };
        observers.push(this.obs);
      }
      observe(target: Element) {
        this.obs.target = target;
        // Match the global polyfill: fire a non-zero contentRect immediately
        // so terminal.open() runs. sessionCreated flips to true here.
        setTimeout(() => {
          this.obs.callback(
            [
              {
                target,
                contentRect: { width: 800, height: 600 },
              } as unknown as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
        }, 0);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      render(<TerminalView instanceId="t-atlas-hide" profile="PowerShell" syncGroup="" />);

      // Wait for session to finish creation (first ResizeObserver entry).
      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
      });

      mockClearTextureAtlas.mockClear();
      mockRefresh.mockClear();
      mockFit.mockClear();

      // Find the observer that belongs to the TerminalView container (the
      // first — there is only one resizeObserver in that useEffect).
      const obs = observers[0];
      expect(obs).toBeDefined();
      const target = obs.target as Element;

      // Workspace switched away: pane container gets display:none, which
      // fires a 0×0 contentRect. This path should NOT clear the atlas.
      act(() => {
        obs.callback(
          [{ target, contentRect: { width: 0, height: 0 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });

      expect(mockClearTextureAtlas).not.toHaveBeenCalled();

      // Workspace switched back: container regains real dimensions. On this
      // transition the fix must re-fit AND rebuild the atlas, otherwise
      // every glyph renders from stale atlas coordinates (issue #232).
      act(() => {
        obs.callback(
          [
            {
              target,
              contentRect: { width: 800, height: 600 },
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      });

      await vi.waitFor(() => {
        expect(mockFit).toHaveBeenCalled();
        expect(mockClearTextureAtlas).toHaveBeenCalled();
        expect(mockRefresh).toHaveBeenCalled();
      });

      // Subsequent resizes while still visible must NOT keep clearing the
      // atlas — that would be wasteful. Reset counters and fire another
      // (non-hidden → non-hidden) resize.
      mockClearTextureAtlas.mockClear();
      mockRefresh.mockClear();
      mockFit.mockClear();

      act(() => {
        obs.callback(
          [
            {
              target,
              contentRect: { width: 900, height: 700 },
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      });

      await vi.waitFor(() => {
        expect(mockFit).toHaveBeenCalled();
      });
      expect(mockClearTextureAtlas).not.toHaveBeenCalled();
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  // -- Regression: same-size ResizeObserver entries must not trigger fit() --
  //
  // ResizeObserver fires a fresh entry on sub-pixel layout shifts (DPR
  // rounding, scrollbar shimmies, hover bars). Calling fit() — and through
  // it `terminal.onResize` → PTY resize round-trips — for changes the user
  // never perceives is wasteful and overlaps with TUI exit bursts.
  it("ignores same-size ResizeObserver entries", async () => {
    type Observer = {
      target: Element | null;
      callback: (entries: ResizeObserverEntry[], obs: ResizeObserver) => void;
    };
    const observers: Observer[] = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      private obs: Observer;
      constructor(cb: (entries: ResizeObserverEntry[], obs: ResizeObserver) => void) {
        this.obs = { target: null, callback: cb };
        observers.push(this.obs);
      }
      observe(target: Element) {
        this.obs.target = target;
        setTimeout(() => {
          this.obs.callback(
            [
              {
                target,
                contentRect: { width: 800, height: 600 },
              } as unknown as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          );
        }, 0);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      render(<TerminalView instanceId="t-resize-dedup" profile="PowerShell" syncGroup="" />);

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
      });

      const obs = observers[0];
      expect(obs).toBeDefined();
      const target = obs.target as Element;

      // Initial mount opens the terminal at 800×600. Now fire two more
      // identical entries — the guard must short-circuit both.
      mockFit.mockClear();

      act(() => {
        obs.callback(
          [
            {
              target,
              contentRect: { width: 800, height: 600 },
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      });
      act(() => {
        obs.callback(
          [
            {
              target,
              contentRect: { width: 800.4, height: 600.2 }, // sub-pixel jitter
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      });

      expect(mockFit).not.toHaveBeenCalled();

      // A real change (different integer dimensions) must still fit.
      act(() => {
        obs.callback(
          [
            {
              target,
              contentRect: { width: 900, height: 700 },
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      });

      await vi.waitFor(() => {
        expect(mockFit).toHaveBeenCalled();
      });
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
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

    it("indented link handler calls openExternal when invoked", async () => {
      render(<TerminalView instanceId="t-link3" profile="PowerShell" syncGroup="" />);

      expect(capturedIndentedLinkHandler).not.toBeNull();

      capturedIndentedLinkHandler!("https://example.com/indented-url");

      await vi.waitFor(() => {
        expect(mockOpenExternal).toHaveBeenCalledWith("https://example.com/indented-url");
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
          true, // cwdSend
          true, // cwdReceive
          "/home/user/project",
          undefined,
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
          true, // cwdSend
          true, // cwdReceive
          undefined,
          undefined,
        );
      });
    });

    it("still creates session when cache load fails", async () => {
      mockLoadTerminalOutputCache.mockRejectedValueOnce(
        new Error("Cache not found: /fake/path.dat"),
      );

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
          true, // cwdSend
          true, // cwdReceive
          undefined,
          undefined,
        );
      });
    });

    it("passes claude --resume as startupCommandOverride when lastClaudeSession is set", async () => {
      render(
        <TerminalView
          instanceId="t-claude-restore"
          paneId="pane-claude"
          profile="PowerShell"
          syncGroup="default"
          lastCwd="/home/user/project"
          lastClaudeSession="abc123-session-id"
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-claude-restore",
          "PowerShell",
          80,
          24,
          "default",
          true, // cwdSend
          true, // cwdReceive
          "/home/user/project",
          "claude --resume abc123-session-id",
        );
      });
    });

    it("does not pass startupCommandOverride when restoreSession is false", async () => {
      useSettingsStore.setState({
        claude: { syncCwd: "skip", restoreSession: false },
      });

      render(
        <TerminalView
          instanceId="t-claude-norestore"
          paneId="pane-claude-no"
          profile="PowerShell"
          syncGroup="default"
          lastClaudeSession="abc123-session-id"
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-claude-norestore",
          "PowerShell",
          80,
          24,
          "default",
          true, // cwdSend
          true, // cwdReceive
          undefined,
          undefined,
        );
      });
    });

    it("rejects invalid session ID to prevent command injection", async () => {
      render(
        <TerminalView
          instanceId="t-claude-inject"
          paneId="pane-inject"
          profile="PowerShell"
          syncGroup="default"
          lastCwd="/home/user/project"
          lastClaudeSession="bad; rm -rf /"
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-claude-inject",
          "PowerShell",
          80,
          24,
          "default",
          true, // cwdSend
          true, // cwdReceive
          "/home/user/project",
          undefined,
        );
      });
    });

    it("pushes restored content into scrollback with padding newlines", async () => {
      mockLoadTerminalOutputCache.mockResolvedValueOnce("cached-terminal-output");

      render(
        <TerminalView
          instanceId="t-restore-scroll"
          paneId="pane-scroll"
          profile="PowerShell"
          syncGroup="default"
        />,
      );

      await vi.waitFor(() => {
        expect(mockLoadTerminalOutputCache).toHaveBeenCalledWith("pane-scroll");
      });

      // Should write: cached content, separator, then padding newlines (rows=24)
      await vi.waitFor(() => {
        const calls = mockWrite.mock.calls.map((c: unknown[]) => c[0]);
        expect(calls).toContain("cached-terminal-output");
        expect(calls).toContain("\r\n".repeat(24));
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
        // cwdSend and cwdReceive are passed directly to createTerminalSession
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-cwd1",
          "PowerShell",
          80,
          24,
          "default",
          true, // cwdSend default
          false, // cwdReceive
          undefined,
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
          true, // cwdSend default
          true, // cwdReceive
          undefined,
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

  describe("WebGL stagger", () => {
    it("delays WebGL addon creation based on init counter", async () => {
      vi.useFakeTimers();

      render(<TerminalView instanceId="t-wgl1" profile="PowerShell" syncGroup="g" />);
      render(<TerminalView instanceId="t-wgl2" profile="PowerShell" syncGroup="g" />);

      // Advance past ResizeObserver setTimeout(0) + first WebGL setTimeout(0)
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      // Drain nested timers (ResizeObserver → WebGL init at delay 0)
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(WebglAddon).toHaveBeenCalledTimes(1);

      // Second terminal: delay = 1 * 150 = 150ms
      await act(async () => {
        vi.advanceTimersByTime(150);
      });
      expect(WebglAddon).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    it("injects pinned bar left content with title when pinned (issue #209)", async () => {
      const { PaneControlContext } = await import("@/components/layout/PaneControlContext");
      const setLeftBarContent = vi.fn();
      const ctxValue = {
        paneControls: <div />,
        mode: "pinned" as const,
        hovered: false,
        onSetMode: vi.fn(),
        registerHeader: vi.fn(),
        unregisterHeader: vi.fn(),
        leftBarContent: null,
        setLeftBarContent,
      };
      render(
        <PaneControlContext.Provider value={ctxValue}>
          <TerminalView instanceId="t-pin-info" profile="WSL" syncGroup="g" />
        </PaneControlContext.Provider>,
      );

      await act(async () => {
        useTerminalStore.getState().updateInstanceInfo("t-pin-info", {
          title: "zsh — /home/user/proj",
          cwd: "/home/user/proj",
          branch: "main",
        });
      });

      expect(setLeftBarContent).toHaveBeenCalled();
      const lastCall = setLeftBarContent.mock.calls.at(-1);
      const node = lastCall?.[0];
      expect(node).not.toBeNull();
      const { container } = render(<>{node}</>);
      expect(container.textContent).toContain("zsh — /home/user/proj");
      // title 만 표시: cwd/branch 는 렌더되지 않는다.
      expect(container.textContent).not.toContain("~/proj");
      expect(container.textContent).not.toContain("main");
    });

    it("injects null when pinned but title is empty (issue #209)", async () => {
      const { PaneControlContext } = await import("@/components/layout/PaneControlContext");
      const setLeftBarContent = vi.fn();
      const ctxValue = {
        paneControls: <div />,
        mode: "pinned" as const,
        hovered: false,
        onSetMode: vi.fn(),
        registerHeader: vi.fn(),
        unregisterHeader: vi.fn(),
        leftBarContent: null,
        setLeftBarContent,
      };
      render(
        <PaneControlContext.Provider value={ctxValue}>
          <TerminalView instanceId="t-pin-empty" profile="WSL" syncGroup="g" />
        </PaneControlContext.Provider>,
      );
      await act(async () => {
        useTerminalStore.getState().updateInstanceInfo("t-pin-empty", {
          title: "",
          cwd: "/home/user/proj",
          branch: "main",
        });
      });
      for (const call of setLeftBarContent.mock.calls) {
        expect(call[0]).toBeNull();
      }
    });

    it("injects null when control bar mode is not pinned (issue #209)", async () => {
      const { PaneControlContext } = await import("@/components/layout/PaneControlContext");
      const setLeftBarContent = vi.fn();
      const ctxValue = {
        paneControls: <div />,
        mode: "hover" as const,
        hovered: false,
        onSetMode: vi.fn(),
        registerHeader: vi.fn(),
        unregisterHeader: vi.fn(),
        leftBarContent: null,
        setLeftBarContent,
      };
      render(
        <PaneControlContext.Provider value={ctxValue}>
          <TerminalView instanceId="t-pin-hover" profile="PowerShell" syncGroup="g" />
        </PaneControlContext.Provider>,
      );
      await act(async () => {
        useTerminalStore.getState().updateInstanceInfo("t-pin-hover", {
          title: "pwsh",
          cwd: "C:\\Users\\me\\proj",
        });
      });
      // 모든 주입 호출은 null 이어야 한다.
      for (const call of setLeftBarContent.mock.calls) {
        expect(call[0]).toBeNull();
      }
    });

    it("cleans up WebGL timer on unmount before it fires", async () => {
      vi.useFakeTimers();
      _resetWebglStagger();

      // First terminal gets delay=0, second gets delay=150
      render(<TerminalView instanceId="t-bump" profile="PowerShell" syncGroup="g" />);
      const { unmount } = render(
        <TerminalView instanceId="t-wgl-cleanup" profile="PowerShell" syncGroup="g" />,
      );

      // Fire ResizeObserver callbacks + first WebGL (delay=0)
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      const callsBefore = WebglAddon.mock.calls.length;

      // Unmount second terminal before its 150ms timer fires
      unmount();

      // Advance past the stagger delay
      await act(async () => {
        vi.advanceTimersByTime(300);
      });

      // WebGL should NOT have been created for the unmounted terminal
      expect(WebglAddon).toHaveBeenCalledTimes(callsBefore);

      vi.useRealTimers();
    });
  });
});

describe("shouldEnableTerminalWebgl", () => {
  it("keeps WebGL enabled", () => {
    expect(shouldEnableTerminalWebgl()).toBe(true);
  });
});
