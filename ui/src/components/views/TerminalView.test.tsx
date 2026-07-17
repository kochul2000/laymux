import { render, screen, act, fireEvent } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  TerminalView,
  _resetWebglStagger,
  _reserveWebglInitDelay,
  shouldEnableTerminalWebgl,
  isTerminalScrolledUp,
} from "./TerminalView";
import { WebglAddon } from "@xterm/addon-webgl";
import { useTerminalStore } from "@/stores/terminal-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useOverridesStore } from "@/stores/overrides-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { CODEX_INPUT_PENDING_MARKER, CLAUDE_INPUT_PENDING_MARKER } from "@/lib/activity-detection";
import { clearRuntimeComposerState } from "@/lib/terminal-input-composer-state";

// Mock xterm since it requires a real DOM with canvas
const mockOnData = vi.fn();
let capturedResizeHandler: ((size: { cols: number; rows: number }) => void) | null = null;
const mockOnResize = vi.fn((handler: (size: { cols: number; rows: number }) => void) => {
  capturedResizeHandler = handler;
  return { dispose: vi.fn() };
});
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
// Issue #349: capture the onScroll handler + scrollToBottom for the
// jump-to-bottom button tests. `mockBufferActive` is mutated by tests to
// simulate scrolling up (viewportY < baseY) vs being pinned to the bottom.
let capturedScrollHandler: (() => void) | null = null;
// Mirror real xterm: scrollToBottom pins the viewport to the live bottom.
// Tests rely on this so a later refreshScrollToBottom() (e.g. the deferred
// mount-time sync) sees the post-click "at bottom" state, not a stale
// scrolled-up one.
const mockScrollToBottom = vi.fn(() => {
  mockBufferActive.viewportY = mockBufferActive.baseY;
});
const mockScrollLines = vi.fn((lines: number) => {
  mockBufferActive.viewportY = Math.max(
    0,
    Math.min(mockBufferActive.baseY, mockBufferActive.viewportY + lines),
  );
});
const mockBufferActive: { cursorX: number; cursorY: number; baseY: number; viewportY: number } = {
  cursorX: 0,
  cursorY: 0,
  baseY: 0,
  viewportY: 0,
};
const mockOnScroll = vi.fn((handler: () => void) => {
  capturedScrollHandler = handler;
  return { dispose: vi.fn() };
});
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
const mockReset = vi.fn();
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
    onScroll = mockOnScroll;
    scrollToBottom = mockScrollToBottom;
    scrollLines = mockScrollLines;
    attachCustomKeyEventHandler = mockAttachCustomKeyEventHandler;
    focus = mockFocus;
    blur = mockBlur;
    paste = mockPaste;
    hasSelection = mockHasSelection;
    getSelection = mockGetSelection;
    clearSelection = mockClearSelection;
    refresh = mockRefresh;
    clearTextureAtlas = mockClearTextureAtlas;
    reset = mockReset;
    dispose = vi.fn();
    loadAddon = vi.fn();
    registerLinkProvider = vi.fn().mockReturnValue({ dispose: vi.fn() });
    element = document.createElement("div");
    buffer = { active: mockBufferActive, normal: mockBufferActive };
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
const mockProposeDimensions = vi.fn(() => ({ cols: 80, rows: 24 }));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class MockFitAddon {
    fit = mockFit;
    proposeDimensions = mockProposeDimensions;
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
  const WebglAddon = vi.fn().mockImplementation(() => {
    webglInitTimes.push(Date.now());
    return {
      dispose: vi.fn(),
      onContextLoss: vi.fn(),
    };
  });
  return { WebglAddon: WebglAddon };
});

const webglInitTimes: number[] = [];

const mockSerialize = vi.fn().mockReturnValue("serialized-data");
vi.mock("@xterm/addon-serialize", () => ({
  SerializeAddon: class MockSerializeAddon {
    serialize = mockSerialize;
    dispose = vi.fn();
  },
}));

const mockRegisterTerminalSerializer = vi.fn();
const mockUnregisterTerminalSerializer = vi.fn();
const mockRegisterTerminalInspector = vi.fn();
const mockUnregisterTerminalInspector = vi.fn();
const mockRegisterTerminalScroller = vi.fn();
const mockUnregisterTerminalScroller = vi.fn();
vi.mock("@/lib/terminal-serialize-registry", () => ({
  registerTerminalSerializer: (...args: unknown[]) => mockRegisterTerminalSerializer(...args),
  unregisterTerminalSerializer: (...args: unknown[]) => mockUnregisterTerminalSerializer(...args),
  registerTerminalInspector: (...args: unknown[]) => mockRegisterTerminalInspector(...args),
  unregisterTerminalInspector: (...args: unknown[]) => mockUnregisterTerminalInspector(...args),
  registerTerminalScroller: (...args: unknown[]) => mockRegisterTerminalScroller(...args),
  unregisterTerminalScroller: (...args: unknown[]) => mockUnregisterTerminalScroller(...args),
}));

// Mock tauri API
const mockCreateTerminalSession = vi.fn().mockResolvedValue({
  id: "t1",
  title: "Terminal",
  config: { profile: "PowerShell", cols: 80, rows: 24, sync_group: "", env: [] },
});
const mockWriteToTerminal = vi.fn().mockResolvedValue(undefined);
const mockWriteTerminalInput = vi.fn().mockResolvedValue(undefined);
const mockResizeTerminal = vi.fn().mockResolvedValue(undefined);
const mockCloseTerminalSession = vi.fn().mockResolvedValue(undefined);
const mockOnTerminalOutput = vi.fn().mockResolvedValue(vi.fn());
const mockAttachTerminalOutput = vi.fn().mockResolvedValue({
  state: {
    version: 1,
    snapshotStartSeq: 0,
    snapshotSeq: 0,
    protocolRevision: 0,
    modes: { bracketedPaste: false },
  },
  snapshot: [],
});
let mockOutputSequence = 0;
const mockGetRemoteControlStatus = vi.fn().mockResolvedValue({
  active: false,
  leaseId: null,
  remoteAddr: null,
  clientName: null,
  heartbeatTimeoutSeconds: 15,
});
let capturedRemoteControlChanged: ((data: { active: boolean }) => void) | null = null;
const mockOnRemoteControlChanged = vi.fn((callback: (data: { active: boolean }) => void) => {
  capturedRemoteControlChanged = callback;
  return Promise.resolve(vi.fn());
});
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
  writeTerminalInput: (...args: unknown[]) => mockWriteTerminalInput(...args),
  resizeTerminal: (...args: unknown[]) => mockResizeTerminal(...args),
  closeTerminalSession: (...args: unknown[]) => mockCloseTerminalSession(...args),
  attachTerminalOutput: (...args: unknown[]) => mockAttachTerminalOutput(...args),
  onTerminalOutputV2: (terminalId: string, callback: (payload: unknown) => void) => {
    const forward = (data: Uint8Array | Record<string, unknown>) => {
      if ("seqStart" in data) {
        callback(data);
        return;
      }
      const raw = new Uint8Array(data as Uint8Array);
      const seqStart = mockOutputSequence;
      mockOutputSequence += raw.length;
      callback({ seqStart, seqEnd: mockOutputSequence, data: Array.from(raw) });
    };
    let attachWaitTurns = 0;
    const exposeRegisteredListenerAfterAttach = () => {
      attachWaitTurns += 1;
      if (mockAttachTerminalOutput.mock.calls.length === 0 && attachWaitTurns < 20) {
        queueMicrotask(exposeRegisteredListenerAfterAttach);
        return;
      }
      // Existing TerminalView tests model an already-attached stream. Expose
      // their callback only after the empty mock snapshot pipeline settles.
      queueMicrotask(() => queueMicrotask(() => void mockOnTerminalOutput(terminalId, forward)));
    };
    queueMicrotask(exposeRegisteredListenerAfterAttach);
    return Promise.resolve(vi.fn());
  },
  getRemoteControlStatus: (...args: unknown[]) => mockGetRemoteControlStatus(...args),
  onRemoteControlChanged: (...args: unknown[]) => mockOnRemoteControlChanged(...args),
  smartPaste: (...args: unknown[]) => mockSmartPaste(...args),
  clipboardWriteText: (...args: unknown[]) => mockClipboardWriteText(...args),
  setTerminalCwdSend: (...args: unknown[]) => mockSetTerminalCwdSend(...args),
  setTerminalCwdReceive: (...args: unknown[]) => mockSetTerminalCwdReceive(...args),
  updateTerminalSyncGroup: vi.fn().mockResolvedValue(undefined),
  openExternal: (...args: unknown[]) => mockOpenExternal(...args),
  resolveGitRemote: vi.fn().mockResolvedValue(null),
  loadTerminalOutputCache: (...args: unknown[]) => mockLoadTerminalOutputCache(...args),
  markClaudeTerminal: (...args: unknown[]) => mockMarkClaudeTerminal(...args),
  markCodexTerminal: (...args: unknown[]) => mockMarkCodexTerminal(...args),
}));

async function waitForTerminalInputReady(): Promise<void> {
  await vi.waitFor(() => {
    expect(mockGetRemoteControlStatus).toHaveBeenCalled();
    expect(mockAttachTerminalOutput).toHaveBeenCalled();
    expect(mockOnTerminalOutput).toHaveBeenCalled();
  });
}

describe("TerminalView", () => {
  beforeEach(() => {
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useOverridesStore.setState({ paneOverrides: {}, viewOverrides: {} });
    useNotificationStore.setState({ notifications: [] });
    localStorage.clear();
    clearRuntimeComposerState();
    capturedKeyHandler = null;
    capturedLinkHandler = null;
    capturedIndentedLinkHandler = null;
    createdTerminals.length = 0;
    webglInitTimes.length = 0;
    csiHandlers.clear();
    oscHandlers.clear();
    escHandlers.clear();
    mockModes.synchronizedOutputMode = false;
    capturedRemoteControlChanged = null;
    mockOutputSequence = 0;
    capturedResizeHandler = null;
    capturedScrollHandler = null;
    mockBufferActive.cursorX = 0;
    mockBufferActive.cursorY = 0;
    mockBufferActive.baseY = 0;
    mockBufferActive.viewportY = 0;
    mockGetRemoteControlStatus.mockResolvedValue({
      active: false,
      leaseId: null,
      remoteAddr: null,
      clientName: null,
      heartbeatTimeoutSeconds: 15,
    });
    _resetWebglStagger();
    vi.clearAllMocks();
    mockProposeDimensions.mockReturnValue({ cols: 80, rows: 24 });
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

  it("renders a persistent terminal background layer below the xterm host", () => {
    render(<TerminalView instanceId="t-background-layer" profile="PowerShell" syncGroup="" />);

    const background = screen.getByTestId("terminal-background-t-background-layer");
    const host = screen.getByTestId("terminal-xterm-host-t-background-layer");
    const wrapper = screen.getByTestId("terminal-view-t-background-layer");
    expect(background).toBeInTheDocument();
    expect(background).toHaveClass("terminal-background-layer");
    expect(host).toHaveClass("terminal-xterm-host");
    expect(wrapper).toHaveClass("min-w-0", "overflow-hidden");
    expect(
      background.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps the top loading overlay hidden after output once xterm has rendered", async () => {
    render(<TerminalView instanceId="t-output-paint" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalledWith("t-output-paint", expect.any(Function));
      expect(mockOnRender).toHaveBeenCalled();
    });

    const overlay = screen.getByTestId("terminal-loading-t-output-paint");
    const renderHandler = mockOnRender.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    await act(async () => {
      renderHandler?.();
    });
    expect(overlay).not.toHaveClass("visible");

    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;
    await act(async () => {
      onOutput?.(new TextEncoder().encode("busy output"));
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

  it("clears a finished IME preview before park-pending freezes overlay repaint", async () => {
    render(<TerminalView instanceId="t-ime-park" profile="PowerShell" syncGroup="" isFocused />);

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-ime-park", {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });

    const container = screen.getByTestId("terminal-view-t-ime-park");
    const preview = screen.getByTestId("terminal-composition-preview-t-ime-park");
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
    terminal.buffer.active.cursorX = 2;
    terminal.buffer.active.cursorY = 4;
    helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    helper.value = "\u3131";
    helper.selectionStart = 1;
    helper.selectionEnd = 1;
    helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\u3131" }));
    helper.dispatchEvent(new Event("input"));

    await vi.waitFor(() => {
      expect(preview.textContent).toBe("\u3131");
      expect(preview.style.opacity).toBe("1");
    });

    await act(async () => {
      await csiHandlers.get("?:h")?.([2026]);
      terminal.buffer.active.cursorX = 44;
      terminal.buffer.active.cursorY = 20;
      await csiHandlers.get("?:l")?.([2026]);
      helper.dispatchEvent(new CompositionEvent("compositionend", { data: "\uAC00" }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(container).not.toHaveClass("terminal-ime-composition-active");
    const overlayFrame = mockRequestAnimationFrame.mock.calls.at(-1)?.[0] as
      | FrameRequestCallback
      | undefined;
    act(() => {
      overlayFrame?.(performance.now());
    });

    expect(preview.style.opacity).toBe("0");
    expect(preview.textContent).toBe("");
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

  it("opens the DEC 2026 parser frame before Codex activity is classified", async () => {
    localStorage.setItem("laymux:cursor-trace", "1");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const traces = (needle: string) =>
      logSpy.mock.calls.filter((call) => typeof call[0] === "string" && call[0].includes(needle));
    try {
      render(
        <TerminalView instanceId="t-frame-before-activity" profile="PowerShell" syncGroup="" />,
      );

      await act(async () => {
        await csiHandlers.get("?:h")?.([2026]);
      });
      act(() => {
        useTerminalStore.getState().updateInstanceInfo("t-frame-before-activity", {
          activity: { type: "interactiveApp", name: "Codex" },
        });
      });

      await act(async () => {
        await csiHandlers.get("?:h")?.([25]);
      });
      expect(traces("dectcem-park")).toHaveLength(0);

      await act(async () => {
        await csiHandlers.get("?:l")?.([2026]);
        await csiHandlers.get("?:h")?.([25]);
      });
      expect(traces("dectcem-park").length).toBeGreaterThan(0);
    } finally {
      logSpy.mockRestore();
      localStorage.removeItem("laymux:cursor-trace");
    }
  });

  it("defers the park settle timeout while the next DEC 2026 frame is mid-flight", async () => {
    // Regression: frame N flushes (`?2026l` → parkPending + settle timer),
    // no park arrives, and frame N+1 opens (`?2026h`) before the timer
    // fires. Consuming the timeout mid-frame would schedule a paint that
    // the sync-output gate hides — a one-frame overlay blink. The timer
    // must re-arm instead and only fire once the frame closes.
    localStorage.setItem("laymux:cursor-trace", "1");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const settleTraces = () =>
      logSpy.mock.calls.filter(
        (call) => typeof call[0] === "string" && call[0].includes("park-settle-timeout"),
      );
    try {
      render(<TerminalView instanceId="t-park-defer" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(csiHandlers.get("?:l")).toBeTypeOf("function");
        expect(mockOnTerminalOutput).toHaveBeenCalled();
      });
      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      act(() => {
        useTerminalStore.getState().updateInstanceInfo("t-park-defer", {
          activity: { type: "interactiveApp", name: "Codex" },
        });
      });

      vi.useFakeTimers();
      // Frame N flush: parkPending set, settle timer armed.
      await act(async () => {
        await csiHandlers.get("?:l")?.([2026]);
      });
      // Frame N+1 opens before the timer fires…
      await act(async () => {
        await csiHandlers.get("?:h")?.([2026]);
      });
      // xterm releases synchronizedOutputMode after its safety timeout,
      // while the parser frame remains open until the reset sequence.
      mockModes.synchronizedOutputMode = false;
      act(() => {
        onOutput?.(new TextEncoder().encode("long-frame-body"));
      });
      await act(async () => {
        vi.advanceTimersByTime(120);
      });
      // …so the timeout defers instead of consuming parkPending.
      expect(settleTraces()).toHaveLength(0);

      // Frame N+1 closes without a park: the settle fallback now fires.
      await act(async () => {
        await csiHandlers.get("?:l")?.([2026]);
      });
      await act(async () => {
        vi.advanceTimersByTime(120);
      });
      expect(settleTraces().length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
      logSpy.mockRestore();
      localStorage.removeItem("laymux:cursor-trace");
    }
  });

  it("releases settle freeze without closing a still-open DEC 2026 parser frame", async () => {
    // Frame N flushes (`?2026l` → parkPending + settle timer), then
    // frame N+1 stays open beyond the deferral budget. The fallback may
    // release its overlay freeze, but only a real `?2026l` may close the
    // parser frame. Otherwise a later in-frame `?25h` is misclassified
    // as an authoritative park and can store the footer coordinate.
    localStorage.setItem("laymux:cursor-trace", "1");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const traces = (needle: string) =>
      logSpy.mock.calls.filter((call) => typeof call[0] === "string" && call[0].includes(needle));
    try {
      render(<TerminalView instanceId="t-park-stale" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(csiHandlers.get("?:l")).toBeTypeOf("function");
      });
      act(() => {
        useTerminalStore.getState().updateInstanceInfo("t-park-stale", {
          activity: { type: "interactiveApp", name: "Codex" },
        });
      });

      vi.useFakeTimers();
      // Frame N flush: parkPending set, settle timer armed.
      await act(async () => {
        await csiHandlers.get("?:l")?.([2026]);
      });
      // Frame N+1 opens… and its reset never arrives.
      await act(async () => {
        await csiHandlers.get("?:h")?.([2026]);
      });

      // Within the deferral budget the timeout keeps deferring.
      await act(async () => {
        vi.advanceTimersByTime(500);
      });
      expect(traces("park-settle-timeout")).toHaveLength(0);

      // Past the budget (20 deferrals × 50 ms + the initial window) the
      // fallback commits, but the parser frame remains open.
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      expect(traces("park-settle-timeout").length).toBeGreaterThan(0);
      expect(traces("park-settle-stale-frame")).toHaveLength(0);

      await act(async () => {
        await csiHandlers.get("?:h")?.([25]);
      });
      expect(traces("dectcem-park")).toHaveLength(0);

      await act(async () => {
        await csiHandlers.get("?:l")?.([2026]);
        await csiHandlers.get("?:h")?.([25]);
      });
      expect(traces("dectcem-park").length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
      logSpy.mockRestore();
      localStorage.removeItem("laymux:cursor-trace");
    }
  });

  it("keeps DECTCEM show in-frame after xterm synchronized-output safety timeout", async () => {
    render(
      <TerminalView
        instanceId="t-sync-timeout-frame"
        profile="PowerShell"
        syncGroup=""
        isFocused
      />,
    );

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-sync-timeout-frame", {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });

    const container = screen.getByTestId("terminal-view-t-sync-timeout-frame");
    const overlay = screen.getByTestId("terminal-overlay-caret-t-sync-timeout-frame");
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

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });
    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;

    terminal.buffer.active.baseY = 0;
    terminal.buffer.active.cursorX = 2;
    terminal.buffer.active.cursorY = 4;
    const writeParsedHandler = mockOnWriteParsed.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    await act(async () => {
      writeParsedHandler?.();
    });
    await vi.waitFor(() => {
      expect(overlay.style.transform).toBe("translate(20px, 80px)");
    });

    mockModes.synchronizedOutputMode = true;
    await act(async () => {
      await csiHandlers.get("?:h")?.([2026]);
    });

    // xterm.js safety timeout releases rendering, but the byte stream
    // has not delivered DEC 2026 reset yet.
    mockModes.synchronizedOutputMode = false;
    act(() => {
      onOutput?.(new TextEncoder().encode("long-frame-body"));
    });
    await vi.waitFor(() => {
      expect(container).not.toHaveClass("terminal-sync-output-active");
    });

    terminal.buffer.active.cursorX = 44;
    terminal.buffer.active.cursorY = 20;
    await act(async () => {
      await csiHandlers.get("?:h")?.([25]);
    });

    await vi.waitFor(() => {
      expect(overlay.style.transform).toBe("translate(20px, 80px)");
    });
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

  it("marks Claude permission prompts as input pending and emits one notification", async () => {
    // Regression guard for the WSL-Claude scenario: the working spinner title
    // keeps animating behind the modal, so the existing working→idle
    // notification path in `claude_activity.rs` never fires. Detecting the
    // modal directly from the rolling output tail surfaces the "needs your
    // input" badge that was previously missing.
    render(<TerminalView instanceId="t-claude-prompt" profile="WSL" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-claude-prompt", {
      activity: { type: "interactiveApp", name: "Claude" },
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
          "│ Do you want to make this edit to file.rs?  │\r\n" +
            "│ ❯ 1. Yes                                    │\r\n" +
            "│   2. Yes, and don't ask again this session  │\r\n" +
            "│   3. No                                     │\r\n",
        ),
      );
    });

    const instance = useTerminalStore.getState().instances.find((i) => i.id === "t-claude-prompt");
    expect(instance?.activityMessage).toBe(CLAUDE_INPUT_PENDING_MARKER);

    const notifications = useNotificationStore.getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      terminalId: "t-claude-prompt",
      message: "Claude is waiting for your input",
      level: "info",
    });

    // A second identical chunk must not re-notify — the prompt is the same
    // modal sliding through the rolling tail, not a fresh user-actionable
    // event.
    act(() => {
      onOutput?.(
        new TextEncoder().encode(
          "│ ❯ 1. Yes                                    │\r\n" +
            "│   2. Yes, and don't ask again this session  │\r\n" +
            "│   3. No                                     │\r\n",
        ),
      );
    });
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
  });

  // Issue #312: Claude Code session-limit banner → schedule auto-resume.
  // The banner carries a wall-clock reset time; these tests use the current
  // local minute (inside the recent-past grace window) with delay 0 so the
  // resume fires immediately without fake timers.
  function localSessionLimitBanner(): string {
    const t = new Date();
    const h = t.getHours();
    const h12 = h % 12 === 0 ? 12 : h % 12;
    const ampm = h >= 12 ? "pm" : "am";
    const mm = String(t.getMinutes()).padStart(2, "0");
    return `⎿  You've hit your session limit · resets ${h12}:${mm}${ampm}\r\n`;
  }

  it("sends the session-limit resume message after the reset time passes", async () => {
    useSettingsStore.getState().setClaude({ sessionLimitResumeDelaySeconds: 0 });
    render(<TerminalView instanceId="t-claude-limit" profile="WSL" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-claude-limit", {
      activity: { type: "interactiveApp", name: "Claude" },
    });

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });
    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;

    act(() => {
      onOutput?.(new TextEncoder().encode(localSessionLimitBanner()));
    });

    // A schedule notification is raised immediately.
    expect(
      useNotificationStore
        .getState()
        .notifications.some((n) => n.message.toLowerCase().includes("session limit")),
    ).toBe(true);

    // The resume message is submitted via CR (\r), not \n — Claude Code's TUI
    // treats \n as a soft line break.
    await vi.waitFor(() => {
      expect(
        mockWriteToTerminal.mock.calls.some((c) => c[0] === "t-claude-limit" && c[1] === "go on"),
      ).toBe(true);
    });
    await vi.waitFor(() => {
      expect(
        mockWriteToTerminal.mock.calls.some((c) => c[0] === "t-claude-limit" && c[1] === "\r"),
      ).toBe(true);
    });

    // Re-emitting the same banner (alt-screen redraw residue) must not arm a
    // second resume for the same reset time.
    act(() => {
      onOutput?.(new TextEncoder().encode(localSessionLimitBanner()));
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(mockWriteToTerminal.mock.calls.filter((c) => c[1] === "go on")).toHaveLength(1);
  });

  it("uses the configured resume message", async () => {
    useSettingsStore.getState().setClaude({
      sessionLimitResumeDelaySeconds: 0,
      sessionLimitResumeMessage: "continue please",
    });
    render(<TerminalView instanceId="t-claude-limit-msg" profile="WSL" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-claude-limit-msg", {
      activity: { type: "interactiveApp", name: "Claude" },
    });

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });
    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;

    act(() => {
      onOutput?.(new TextEncoder().encode(localSessionLimitBanner()));
    });

    await vi.waitFor(() => {
      expect(
        mockWriteToTerminal.mock.calls.some(
          (c) => c[0] === "t-claude-limit-msg" && c[1] === "continue please",
        ),
      ).toBe(true);
    });
  });

  it("skips the resume send when the pane is no longer running Claude at fire time", async () => {
    // The timer can be armed hours before it fires; if the user exits Claude
    // (or starts another app) in the meantime, the resume text must not be
    // typed into whatever now owns the pane.
    useSettingsStore.getState().setClaude({ sessionLimitResumeDelaySeconds: 1 });
    render(<TerminalView instanceId="t-claude-limit-gone" profile="WSL" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-claude-limit-gone", {
      activity: { type: "interactiveApp", name: "Claude" },
    });

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });
    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;

    act(() => {
      onOutput?.(new TextEncoder().encode(localSessionLimitBanner()));
    });
    // Armed while Claude was active; the schedule notification confirms it.
    expect(
      useNotificationStore
        .getState()
        .notifications.some((n) => n.message.includes("auto-resume scheduled")),
    ).toBe(true);

    // Claude exits before the timer fires.
    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-claude-limit-gone", {
        activity: { type: "shell" },
      });
    });

    await vi.waitFor(() => {
      expect(
        useNotificationStore
          .getState()
          .notifications.some((n) => n.message.includes("auto-resume skipped")),
      ).toBe(true);
    });
    expect(mockWriteToTerminal.mock.calls.some((c) => c[0] === "t-claude-limit-gone")).toBe(false);
  });

  it("does not auto-resume when sessionLimitAutoResume is disabled", async () => {
    useSettingsStore.getState().setClaude({
      sessionLimitAutoResume: false,
      sessionLimitResumeDelaySeconds: 0,
    });
    render(<TerminalView instanceId="t-claude-limit-off" profile="WSL" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-claude-limit-off", {
      activity: { type: "interactiveApp", name: "Claude" },
    });

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });
    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;

    act(() => {
      onOutput?.(new TextEncoder().encode(localSessionLimitBanner()));
    });

    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(mockWriteToTerminal.mock.calls.some((c) => c[1] === "go on")).toBe(false);
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it("clears Claude input-pending marker after the modal is dismissed", async () => {
    render(<TerminalView instanceId="t-claude-prompt-done" profile="WSL" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-claude-prompt-done", {
      activity: { type: "interactiveApp", name: "Claude" },
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
          "│ Do you want to proceed?       │\r\n" +
            "│ ❯ 1. Yes                      │\r\n" +
            "│   2. No                       │\r\n",
        ),
      );
    });

    expect(
      useTerminalStore.getState().instances.find((i) => i.id === "t-claude-prompt-done")
        ?.activityMessage,
    ).toBe(CLAUDE_INPUT_PENDING_MARKER);

    // User answered — Claude writes enough non-modal content to push
    // the ❯ arrow out of the 4 KB dismissal window. Marker must
    // then clear so the next ⏳ working spinner can take over and
    // the *next* modal can re-fire its notification. Keying
    // dismissal off the larger 16 KB detection buffer (an earlier
    // attempt) pinned the marker for ~30 seconds and suppressed the
    // follow-up alert; trusting `text` alone (a later attempt)
    // dismissed mid-frame on WSL where modals split across chunks.
    // ~30 chars × 200 lines = ~6 KB clears the 4 KB window.
    act(() => {
      onOutput?.(new TextEncoder().encode("Continuing with the edit...\r\n".repeat(200)));
    });

    expect(
      useTerminalStore.getState().instances.find((i) => i.id === "t-claude-prompt-done")
        ?.activityMessage,
    ).toBeUndefined();

    // The unread badge for this terminal's requiresAction alert must
    // also clear — otherwise the badge would hang around forever after
    // the user has already resolved the modal.
    const pending = useNotificationStore
      .getState()
      .notifications.filter((n) => n.terminalId === "t-claude-prompt-done" && n.requiresAction);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((n) => n.readAt !== null)).toBe(true);
  });

  it("clears Claude input-pending marker when Claude returns to the normal prompt", async () => {
    render(<TerminalView instanceId="t-claude-normal-prompt" profile="WSL" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-claude-normal-prompt", {
      activity: { type: "interactiveApp", name: "Claude" },
      workspaceId: "ws-test",
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
          "│ Do you want to proceed?       │\r\n" +
            "│ ❯ 1. Yes                      │\r\n" +
            "│   2. No                       │\r\n",
        ),
      );
    });

    expect(
      useTerminalStore.getState().instances.find((i) => i.id === "t-claude-normal-prompt")
        ?.activityMessage,
    ).toBe(CLAUDE_INPUT_PENDING_MARKER);

    act(() => {
      onOutput?.(new TextEncoder().encode("╰─❯ "));
    });

    expect(
      useTerminalStore.getState().instances.find((i) => i.id === "t-claude-normal-prompt")
        ?.activityMessage,
    ).toBeUndefined();

    const pending = useNotificationStore
      .getState()
      .notifications.filter((n) => n.terminalId === "t-claude-normal-prompt" && n.requiresAction);
    expect(pending.length).toBeGreaterThan(0);
    expect(pending.every((n) => n.readAt !== null)).toBe(true);
  });

  it("keeps the marker steady when a modal frame is split across PTY chunks (WSL/ConPTY)", async () => {
    // WSL via ConPTY routinely emits a single Claude modal redraw as
    // 3-10 small PTY chunks. The first chunk holds the arrow line and
    // satisfies detection, but the next chunk is a spinner footer
    // continuation that contains no modal pattern at all. A naive
    // dismissal that trusted `text` alone would clear the marker 60 ms
    // after firing, and `notif-1.readAt - notif-1.createdAt = 60` in
    // production confirmed exactly that race. This test locks in the
    // fix: the marker survives the spinner-only continuation.
    render(<TerminalView instanceId="t-claude-chunked" profile="WSL" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-claude-chunked", {
      activity: { type: "interactiveApp", name: "Claude" },
      workspaceId: "ws-test",
    });

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });
    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;
    expect(onOutput).toBeTypeOf("function");

    // Chunk 1: full modal frame.
    act(() => {
      onOutput?.(
        new TextEncoder().encode(
          "│ Do you want to proceed?       │\r\n" +
            "│ ❯ 1. Yes                      │\r\n" +
            "│   2. No                       │\r\n",
        ),
      );
    });
    expect(
      useTerminalStore.getState().instances.find((i) => i.id === "t-claude-chunked")
        ?.activityMessage,
    ).toBe(CLAUDE_INPUT_PENDING_MARKER);

    // Chunk 2: spinner footer continuation (modal still on screen,
    // but this chunk's text doesn't include the modal box). Marker
    // must NOT flap to undefined.
    act(() => {
      onOutput?.(new TextEncoder().encode("✶ Hashing… (5s)\r\n"));
    });
    expect(
      useTerminalStore.getState().instances.find((i) => i.id === "t-claude-chunked")
        ?.activityMessage,
    ).toBe(CLAUDE_INPUT_PENDING_MARKER);
  });

  it("re-fires the input-pending notification when a fresh modal arrives after the previous one was dismissed", async () => {
    // User answered modal #1, Claude started a new task, then asked
    // for input again. The previous modal text may still sit in the
    // rolling buffer but the marker has been cleared, so the new
    // modal must trigger a fresh notification — without this the
    // status icon stays on ⏳ silently and the user is never told
    // Claude is parked on the second prompt.
    render(<TerminalView instanceId="t-claude-second-modal" profile="WSL" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-claude-second-modal", {
      activity: { type: "interactiveApp", name: "Claude" },
      workspaceId: "ws-test",
    });

    await vi.waitFor(() => {
      expect(mockOnTerminalOutput).toHaveBeenCalled();
    });
    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;
    expect(onOutput).toBeTypeOf("function");

    const notifCountBefore = useNotificationStore
      .getState()
      .notifications.filter((n) => n.terminalId === "t-claude-second-modal").length;

    // First modal arrives → notification fires.
    act(() => {
      onOutput?.(
        new TextEncoder().encode(
          "│ Do you want to proceed?       │\r\n" +
            "│ ❯ 1. Yes                      │\r\n" +
            "│   2. No                       │\r\n",
        ),
      );
    });
    expect(
      useNotificationStore
        .getState()
        .notifications.filter((n) => n.terminalId === "t-claude-second-modal").length,
    ).toBe(notifCountBefore + 1);

    // User answered — Claude writes enough non-modal content to push
    // the ❯ arrow out of the 4 KB dismissal window.
    act(() => {
      onOutput?.(new TextEncoder().encode("Continuing with the edit...\r\n".repeat(200)));
    });
    expect(
      useTerminalStore.getState().instances.find((i) => i.id === "t-claude-second-modal")
        ?.activityMessage,
    ).toBeUndefined();

    // Second modal arrives → notification fires AGAIN.
    act(() => {
      onOutput?.(
        new TextEncoder().encode(
          "│ Run this command?             │\r\n" +
            "│ ❯ 1. Yes                      │\r\n" +
            "│   2. Edit                     │\r\n" +
            "│   3. No                       │\r\n",
        ),
      );
    });
    expect(
      useNotificationStore
        .getState()
        .notifications.filter((n) => n.terminalId === "t-claude-second-modal").length,
    ).toBe(notifCountBefore + 2);
  });

  it("does not fire Claude pending notification for an unrelated numbered list", async () => {
    render(<TerminalView instanceId="t-claude-no-prompt" profile="WSL" syncGroup="" />);
    useTerminalStore.getState().updateInstanceInfo("t-claude-no-prompt", {
      activity: { type: "interactiveApp", name: "Claude" },
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
          "Steps to reproduce:\r\n 1. open file\r\n 2. press enter\r\n 3. observe\r\n",
        ),
      );
    });

    const instance = useTerminalStore
      .getState()
      .instances.find((i) => i.id === "t-claude-no-prompt");
    expect(instance?.activityMessage).toBeUndefined();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
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

  // --- Issue #365 follow-up: typing dismisses notifications by focus, not key ---
  // Entering a workspace clears its alerts; typing is an even stronger "I'm
  // responding here" signal, so onData must clear unread alerts (including
  // requiresAction) with the *same granularity* as the focus/entry policy.
  describe("clears notifications on terminal input", () => {
    const latestOnData = () => {
      const calls = mockOnData.mock.calls;
      return calls[calls.length - 1]?.[0] as ((data: string) => void) | undefined;
    };
    const waitForLocalControl = async () => {
      await vi.waitFor(() => {
        expect(mockGetRemoteControlStatus).toHaveBeenCalled();
      });
      await act(async () => {
        await Promise.resolve();
      });
    };
    const setDismiss = (mode: "workspace" | "paneFocus" | "manual") =>
      useSettingsStore.setState((s) => ({ notifications: { ...s.notifications, dismiss: mode } }));

    it("clears the typed pane's requiresAction alert (paneFocus mode)", async () => {
      setDismiss("paneFocus");
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      useNotificationStore.getState().addNotification({
        terminalId: "t-input-pf",
        workspaceId: wsId,
        message: "Claude is waiting for your input",
        requiresAction: true,
      });
      expect(useNotificationStore.getState().notifications[0].readAt).toBeNull();

      render(<TerminalView instanceId="t-input-pf" profile="PowerShell" syncGroup="" />);
      await waitForLocalControl();
      const onData = latestOnData();
      expect(onData).toBeTypeOf("function");
      act(() => onData!("a"));

      expect(useNotificationStore.getState().notifications[0].readAt).not.toBeNull();
    });

    it("clears the whole workspace's alerts, even one on another pane (workspace mode)", async () => {
      setDismiss("workspace");
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      // Alert belongs to a *different* pane in the same workspace.
      useNotificationStore.getState().addNotification({
        terminalId: "other-pane",
        workspaceId: wsId,
        message: "Build finished",
        requiresAction: true,
      });

      render(<TerminalView instanceId="t-input-ws" profile="PowerShell" syncGroup="" />);
      await waitForLocalControl();
      act(() => latestOnData()!("x"));

      expect(useNotificationStore.getState().notifications[0].readAt).not.toBeNull();
    });

    it("does not clear alerts on input in manual dismiss mode", async () => {
      setDismiss("manual");
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      useNotificationStore.getState().addNotification({
        terminalId: "t-input-manual",
        workspaceId: wsId,
        message: "Claude is waiting for your input",
        requiresAction: true,
      });

      render(<TerminalView instanceId="t-input-manual" profile="PowerShell" syncGroup="" />);
      await waitForLocalControl();
      act(() => latestOnData()!("z"));

      expect(useNotificationStore.getState().notifications[0].readAt).toBeNull();
    });
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
    await waitForTerminalInputReady();
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
      expect(mockWriteTerminalInput).toHaveBeenCalledWith(
        expect.any(String),
        "C:\\test\\file.png",
        false,
      );
    });
  });

  it("writes text when smartPaste returns text type", async () => {
    mockSmartPaste.mockResolvedValue({ pasteType: "text", content: "hello world" });

    render(<TerminalView instanceId="t-paste2" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
    });
    await waitForTerminalInputReady();

    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    capturedKeyHandler!(event);

    await vi.waitFor(() => {
      expect(mockSmartPaste).toHaveBeenCalled();
    });

    await vi.waitFor(() => {
      expect(mockWriteTerminalInput).toHaveBeenCalledWith(expect.any(String), "hello world", false);
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
    await waitForTerminalInputReady();

    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    capturedKeyHandler!(event);

    await vi.waitFor(() => {
      expect(mockWriteTerminalInput).toHaveBeenCalledWith(expect.any(String), pasted, false);
    });
  });

  it("pastes multiple file paths joined by the configured separator (default space)", async () => {
    mockSmartPaste.mockResolvedValue({
      pasteType: "path",
      content: "C:\\test\\one.txt",
      paths: ["C:\\test\\one.txt", "C:\\test\\two.txt"],
    });

    render(<TerminalView instanceId="t-paste-multi1" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
    });
    await waitForTerminalInputReady();

    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    capturedKeyHandler!(event);

    await vi.waitFor(() => {
      expect(mockWriteTerminalInput).toHaveBeenCalledWith(
        expect.any(String),
        "C:\\test\\one.txt C:\\test\\two.txt",
        false,
      );
    });
  });

  it("pastes multiple file paths with newline separator and quote wrapping from settings", async () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      paste: {
        ...useSettingsStore.getState().paste,
        pathSeparator: "newline",
        pathQuote: true,
      },
    });
    mockSmartPaste.mockResolvedValue({
      pasteType: "path",
      content: "C:\\My Files\\one.txt",
      paths: ["C:\\My Files\\one.txt", "C:\\test\\two.txt"],
    });

    render(<TerminalView instanceId="t-paste-multi2" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
    });
    await waitForTerminalInputReady();

    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    capturedKeyHandler!(event);

    await vi.waitFor(() => {
      expect(mockWriteTerminalInput).toHaveBeenCalledWith(
        expect.any(String),
        '"C:\\My Files\\one.txt"\n"C:\\test\\two.txt"',
        false,
      );
    });
  });

  it("falls back to content when path result has no paths array (backward compat)", async () => {
    mockSmartPaste.mockResolvedValue({ pasteType: "path", content: "C:\\test\\file.png" });

    render(<TerminalView instanceId="t-paste-multi3" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
    });
    await waitForTerminalInputReady();

    const event = new KeyboardEvent("keydown", { key: "v", ctrlKey: true });
    Object.defineProperty(event, "preventDefault", { value: vi.fn() });
    capturedKeyHandler!(event);

    await vi.waitFor(() => {
      expect(mockWriteTerminalInput).toHaveBeenCalledWith(
        expect.any(String),
        "C:\\test\\file.png",
        false,
      );
    });
  });

  it("skips the smart paste pipeline when smartPaste is disabled but still consumes the key", async () => {
    // Override bindings like Ctrl+Shift+V can't rely on the browser's native
    // paste event, so the keybinding handler must always consume the event.
    // When smartPaste is off we just skip the Rust clipboard pipeline and
    // fall back to plain navigator.clipboard in runTerminalPaste.
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      paste: {
        ...useSettingsStore.getState().paste,
        smart: false,
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
      paste: {
        ...useSettingsStore.getState().paste,
        removeIndent: false,
        removeLineBreak: false,
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

    await waitForTerminalInputReady();

    const container = screen.getByTestId("terminal-view-t-rc1");
    const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    container.dispatchEvent(event);

    await vi.waitFor(() => {
      expect(mockSmartPaste).toHaveBeenCalledWith("", "PowerShell");
    });

    // Right-click paste uses terminal.paste() for bracketed paste support (same as Ctrl+V)
    await vi.waitFor(() => {
      expect(mockWriteTerminalInput).toHaveBeenCalledWith(expect.any(String), "pasted text", false);
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
      terminal: { ...useSettingsStore.getState().terminal, copyOnSelect: true },
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
      terminal: { ...useSettingsStore.getState().terminal, copyOnSelect: true },
      paste: {
        ...useSettingsStore.getState().paste,
        removeIndent: false,
        removeLineBreak: false,
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
      terminal: { ...useSettingsStore.getState().terminal, copyOnSelect: false },
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
      terminal: { ...useSettingsStore.getState().terminal, copyOnSelect: true },
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
      terminal: { ...useSettingsStore.getState().terminal, copyOnSelect: true },
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
      terminal: { ...useSettingsStore.getState().terminal, copyOnSelect: true },
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
      terminal: { ...useSettingsStore.getState().terminal, copyOnSelect: false },
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

  it("waits for write drain before font, DPR, and scrollbar geometry reflows", async () => {
    type DprMql = {
      listeners: Array<(event: MediaQueryListEvent) => void>;
      addEventListener: (type: string, callback: (event: MediaQueryListEvent) => void) => void;
      removeEventListener: (type: string, callback: (event: MediaQueryListEvent) => void) => void;
    };
    const mqls: DprMql[] = [];
    const originalMatchMedia = window.matchMedia;
    const finishWrites: Array<() => void> = [];
    window.matchMedia = vi.fn(() => {
      const mql: DprMql = {
        listeners: [],
        addEventListener: (type, callback) => {
          if (type === "change") mql.listeners.push(callback);
        },
        removeEventListener: (type, callback) => {
          if (type === "change") mql.listeners = mql.listeners.filter((item) => item !== callback);
        },
      };
      mqls.push(mql);
      return mql as unknown as MediaQueryList;
    }) as unknown as typeof window.matchMedia;

    try {
      render(
        <TerminalView
          instanceId="t-geometry-write-drain"
          paneId="pane-geometry-write-drain"
          profile="PowerShell"
          syncGroup=""
        />,
      );
      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
        expect(mockOnTerminalOutput).toHaveBeenCalled();
        expect(mqls[0]?.listeners).toHaveLength(1);
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      mockWrite.mockImplementationOnce((_: string | Uint8Array, callback?: () => void) => {
        if (callback) finishWrites.push(callback);
      });
      act(() => {
        onOutput?.(new TextEncoder().encode("write still parsing"));
      });
      expect(finishWrites).toHaveLength(1);
      mockFit.mockClear();
      mockClearTextureAtlas.mockClear();

      act(() => {
        useOverridesStore.getState().setViewOverride("pane-geometry-write-drain", { fontSize: 20 });
        useSettingsStore.setState({
          ...useSettingsStore.getState(),
          terminal: {
            ...useSettingsStore.getState().terminal,
            scrollbarStyle: "separate" as const,
          },
        });
        for (const listener of [...mqls[0].listeners]) {
          listener(new Event("change") as MediaQueryListEvent);
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(mockFit).not.toHaveBeenCalled();
      expect(mockClearTextureAtlas).not.toHaveBeenCalled();

      act(() => {
        finishWrites[0]();
      });
      await vi.waitFor(() => {
        expect(mockFit).toHaveBeenCalledTimes(1);
        expect(mockClearTextureAtlas).toHaveBeenCalledTimes(1);
      });
    } finally {
      mockWrite.mockImplementation((_: string | Uint8Array, callback?: () => void) => {
        callback?.();
      });
      window.matchMedia = originalMatchMedia;
    }
  });

  it("reflows the renderer when remote control returns to the PC", async () => {
    render(<TerminalView instanceId="t-remote-return" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
      expect(capturedRemoteControlChanged).toBeTruthy();
    });

    mockFit.mockClear();
    mockClearTextureAtlas.mockClear();
    mockRefresh.mockClear();
    mockResizeTerminal.mockClear();

    act(() => {
      capturedRemoteControlChanged?.({ active: true });
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockFit).not.toHaveBeenCalled();

    act(() => {
      capturedRemoteControlChanged?.({ active: false });
    });

    await vi.waitFor(() => {
      expect(mockFit).toHaveBeenCalled();
      expect(mockClearTextureAtlas).toHaveBeenCalled();
      expect(mockRefresh).toHaveBeenCalled();
      expect(mockResizeTerminal).toHaveBeenCalledWith("t-remote-return", 80, 24);
    });
  });

  it("arms the repaint filter for a same-size remote-return backend resize", async () => {
    const userAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

    try {
      render(<TerminalView instanceId="t-remote-repaint" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
        expect(mockOnTerminalOutput).toHaveBeenCalled();
        expect(capturedRemoteControlChanged).toBeTruthy();
      });
      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      mockBufferActive.baseY = 40;
      mockFit.mockClear();
      mockResizeTerminal.mockClear();
      mockWrite.mockClear();

      act(() => {
        capturedRemoteControlChanged?.({ active: true });
        capturedRemoteControlChanged?.({ active: false });
      });
      await vi.waitFor(() => {
        expect(mockResizeTerminal).toHaveBeenCalledTimes(1);
        expect(mockResizeTerminal).toHaveBeenCalledWith("t-remote-repaint", 80, 24);
      });

      act(() => {
        onOutput?.(new TextEncoder().encode("\x1b[?25l\x1b[Hremote repaint\x1b[?25h"));
      });
      expect(mockWrite).not.toHaveBeenCalled();
    } finally {
      userAgent.mockRestore();
    }
  });

  it("sends one protected backend resize when remote-return fit changes geometry", async () => {
    const userAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

    try {
      render(<TerminalView instanceId="t-remote-resized-fit" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
        expect(mockOnTerminalOutput).toHaveBeenCalled();
        expect(capturedRemoteControlChanged).toBeTruthy();
      });
      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      mockBufferActive.baseY = 40;
      mockFit.mockImplementationOnce(() => {
        (createdTerminals[0] as unknown as { cols: number }).cols = 100;
        capturedResizeHandler?.({ cols: 100, rows: 24 });
      });
      mockResizeTerminal.mockClear();
      mockWrite.mockClear();

      act(() => {
        capturedRemoteControlChanged?.({ active: true });
        capturedRemoteControlChanged?.({ active: false });
      });
      await vi.waitFor(() => {
        expect(mockResizeTerminal).toHaveBeenCalledTimes(1);
        expect(mockResizeTerminal).toHaveBeenCalledWith("t-remote-resized-fit", 100, 24);
      });

      act(() => {
        onOutput?.(new TextEncoder().encode("\x1b[?25l\x1b[Hremote repaint\x1b[?25h"));
      });
      expect(mockWrite).not.toHaveBeenCalled();
    } finally {
      mockFit.mockImplementation(() => {});
      userAgent.mockRestore();
    }
  });

  it("retries a rejected remote-return backend resize", async () => {
    render(<TerminalView instanceId="t-remote-retry" profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
      expect(capturedRemoteControlChanged).toBeTruthy();
    });
    mockResizeTerminal.mockRejectedValueOnce(new Error("resize rejected"));
    mockResizeTerminal.mockResolvedValue(undefined);
    mockResizeTerminal.mockClear();

    act(() => {
      capturedRemoteControlChanged?.({ active: true });
      capturedRemoteControlChanged?.({ active: false });
    });

    await vi.waitFor(
      () => {
        expect(mockResizeTerminal).toHaveBeenCalledTimes(2);
        expect(mockResizeTerminal).toHaveBeenLastCalledWith("t-remote-retry", 80, 24);
      },
      { timeout: 2500 },
    );
  });

  it("resends the latest PC geometry when it changes during remote-return sync", async () => {
    let resolveFirstResize: (() => void) | undefined;
    mockResizeTerminal.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirstResize = resolve;
        }),
    );
    mockResizeTerminal.mockResolvedValue(undefined);

    render(
      <TerminalView
        instanceId="t-remote-latest-geometry"
        paneId="pane-remote-latest-geometry"
        profile="PowerShell"
        syncGroup=""
      />,
    );
    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
      expect(capturedRemoteControlChanged).toBeTruthy();
    });
    mockResizeTerminal.mockClear();

    act(() => {
      capturedRemoteControlChanged?.({ active: true });
      capturedRemoteControlChanged?.({ active: false });
    });
    await vi.waitFor(() => {
      expect(mockResizeTerminal).toHaveBeenCalledTimes(1);
      expect(mockResizeTerminal).toHaveBeenCalledWith("t-remote-latest-geometry", 80, 24);
    });

    mockFit.mockClear();
    mockFit.mockImplementationOnce(() => {
      (createdTerminals[0] as unknown as { cols: number }).cols = 100;
      capturedResizeHandler?.({ cols: 100, rows: 24 });
    });
    act(() => {
      useOverridesStore.getState().setViewOverride("pane-remote-latest-geometry", { fontSize: 20 });
    });
    await vi.waitFor(() => {
      expect(mockFit).toHaveBeenCalledTimes(1);
    });

    act(() => {
      resolveFirstResize?.();
    });
    await vi.waitFor(
      () => {
        expect(mockResizeTerminal).toHaveBeenCalledTimes(2);
        expect(mockResizeTerminal).toHaveBeenLastCalledWith("t-remote-latest-geometry", 100, 24);
      },
      { timeout: 2500 },
    );
  });

  it("retries a remote-return backend resize after a bounded timeout", async () => {
    render(<TerminalView instanceId="t-remote-timeout" profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
      expect(capturedRemoteControlChanged).toBeTruthy();
    });
    mockResizeTerminal.mockImplementationOnce(() => new Promise<void>(() => {}));
    mockResizeTerminal.mockResolvedValue(undefined);
    mockResizeTerminal.mockClear();

    act(() => {
      capturedRemoteControlChanged?.({ active: true });
      capturedRemoteControlChanged?.({ active: false });
    });

    await vi.waitFor(
      () => {
        expect(mockResizeTerminal).toHaveBeenCalledTimes(2);
        expect(mockResizeTerminal).toHaveBeenLastCalledWith("t-remote-timeout", 80, 24);
      },
      { timeout: 3500 },
    );
  });

  it("preserves remote-return backend sync when a deferred fit becomes hidden", async () => {
    type Observer = {
      target: Element | null;
      callback: (entries: ResizeObserverEntry[], obs: ResizeObserver) => void;
    };
    const observers: Observer[] = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    const finishWrites: Array<() => void> = [];
    const userAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
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
      render(<TerminalView instanceId="t-remote-hidden-sync" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
        expect(mockOnTerminalOutput).toHaveBeenCalled();
        expect(capturedRemoteControlChanged).toBeTruthy();
      });
      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      mockWrite.mockImplementationOnce((_: string | Uint8Array, callback?: () => void) => {
        if (callback) finishWrites.push(callback);
      });
      act(() => {
        onOutput?.(new TextEncoder().encode("pending parser write"));
      });
      expect(finishWrites).toHaveLength(1);
      mockBufferActive.baseY = 40;

      const obs = observers[0];
      const target = obs.target as Element;
      mockFit.mockClear();
      mockResizeTerminal.mockClear();
      act(() => {
        capturedRemoteControlChanged?.({ active: true });
        capturedRemoteControlChanged?.({ active: false });
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(mockFit).not.toHaveBeenCalled();

      act(() => {
        obs.callback(
          [{ target, contentRect: { width: 0, height: 0 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
        obs.callback(
          [{ target, contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
        finishWrites[0]();
      });

      await vi.waitFor(() => {
        expect(mockFit).toHaveBeenCalledTimes(1);
        expect(mockResizeTerminal).toHaveBeenCalledTimes(1);
        expect(mockResizeTerminal).toHaveBeenCalledWith("t-remote-hidden-sync", 80, 24);
      });

      const writesBeforeRepaint = mockWrite.mock.calls.length;
      act(() => {
        onOutput?.(new TextEncoder().encode("\x1b[?25l\x1b[Hremote repaint\x1b[?25h"));
      });
      expect(mockWrite).toHaveBeenCalledTimes(writesBeforeRepaint);
    } finally {
      mockWrite.mockImplementation((_: string | Uint8Array, callback?: () => void) => {
        callback?.();
      });
      userAgent.mockRestore();
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it("polls active remote control status and reflows after lease expiration", async () => {
    vi.useFakeTimers();
    mockGetRemoteControlStatus
      .mockResolvedValueOnce({
        active: true,
        leaseId: "expired-lease",
        remoteAddr: "127.0.0.1:1",
        clientName: "browser",
        heartbeatTimeoutSeconds: 15,
      })
      .mockResolvedValueOnce({
        active: false,
        leaseId: null,
        remoteAddr: null,
        clientName: null,
        heartbeatTimeoutSeconds: 15,
      });

    try {
      render(<TerminalView instanceId="t-remote-expired" profile="PowerShell" syncGroup="" />);

      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
        expect(mockGetRemoteControlStatus).toHaveBeenCalledTimes(1);
      });

      mockFit.mockClear();
      mockClearTextureAtlas.mockClear();
      mockRefresh.mockClear();
      mockResizeTerminal.mockClear();

      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      await act(async () => {
        vi.runOnlyPendingTimers();
      });

      expect(mockGetRemoteControlStatus).toHaveBeenCalledTimes(2);
      expect(mockFit).toHaveBeenCalled();
      expect(mockClearTextureAtlas).toHaveBeenCalled();
      expect(mockRefresh).toHaveBeenCalled();
      expect(mockResizeTerminal).toHaveBeenCalledWith("t-remote-expired", 80, 24);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not write or resize the backend while remote control is active", async () => {
    mockGetRemoteControlStatus.mockResolvedValue({
      active: true,
      leaseId: "remote-lease",
      remoteAddr: "127.0.0.1:1",
      clientName: "browser",
      heartbeatTimeoutSeconds: 15,
    });

    render(<TerminalView instanceId="t-remote-owned" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
      expect(mockGetRemoteControlStatus).toHaveBeenCalled();
    });

    mockWriteToTerminal.mockClear();
    mockResizeTerminal.mockClear();

    const dataHandler = mockOnData.mock.calls.at(-1)?.[0] as ((data: string) => void) | undefined;
    const resizeHandler = mockOnResize.mock.calls.at(-1)?.[0] as
      | ((size: { cols: number; rows: number }) => void)
      | undefined;
    expect(dataHandler).toBeDefined();
    expect(resizeHandler).toBeDefined();

    act(() => {
      dataHandler?.("x");
      resizeHandler?.({ cols: 120, rows: 40 });
    });

    expect(mockWriteToTerminal).not.toHaveBeenCalled();
    expect(mockResizeTerminal).not.toHaveBeenCalled();
  });

  it("does not resize the backend before the initial remote status is known", async () => {
    let resolveStatus: ((status: { active: boolean }) => void) | undefined;
    mockGetRemoteControlStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );

    render(<TerminalView instanceId="t-remote-pending" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
      expect(mockOnResize).toHaveBeenCalled();
    });

    const resizeHandler = mockOnResize.mock.calls.at(-1)?.[0] as
      | ((size: { cols: number; rows: number }) => void)
      | undefined;
    expect(resizeHandler).toBeDefined();

    mockResizeTerminal.mockClear();

    act(() => {
      resizeHandler?.({ cols: 120, rows: 40 });
    });

    expect(mockResizeTerminal).not.toHaveBeenCalled();

    await act(async () => {
      resolveStatus?.({ active: false });
      await Promise.resolve();
    });

    act(() => {
      resizeHandler?.({ cols: 120, rows: 40 });
    });

    expect(mockResizeTerminal).toHaveBeenCalledWith("t-remote-pending", 120, 40);
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
    const userAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
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
      mockResizeTerminal.mockClear();

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
      // Same-size workspace return must rebuild only the renderer. Re-fitting
      // mutates the xterm buffer and waits on the ConPTY quiet gate, exposing
      // the stale canvas for up to the bounded resize delay.
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
        expect(mockClearTextureAtlas).toHaveBeenCalled();
        expect(mockRefresh).toHaveBeenCalled();
      });
      expect(mockFit).not.toHaveBeenCalled();
      expect(mockResizeTerminal).not.toHaveBeenCalled();

      // A hidden terminal can retain a stale xterm grid even when the outer
      // container returns to the same pixel size. Repaint immediately, but
      // preserve the ConPTY quiet window before mutating the xterm buffer.
      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      mockFit.mockClear();
      mockClearTextureAtlas.mockClear();
      mockRefresh.mockClear();
      mockProposeDimensions.mockReturnValue({ cols: 100, rows: 30 });
      vi.useFakeTimers();
      act(() => {
        onOutput?.(new TextEncoder().encode("recent output"));
        obs.callback(
          [{ target, contentRect: { width: 0, height: 0 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
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
      expect(mockFit).not.toHaveBeenCalled();
      expect(mockClearTextureAtlas).toHaveBeenCalledTimes(1);
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(119);
      });
      expect(mockFit).not.toHaveBeenCalled();
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(mockFit).toHaveBeenCalledTimes(1);
      expect(mockClearTextureAtlas).toHaveBeenCalledTimes(2);
      expect(mockRefresh).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
      mockProposeDimensions.mockReturnValue({ cols: 80, rows: 24 });

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
      vi.useRealTimers();
      userAgent.mockRestore();
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it("preserves hidden atlas recovery while a later visible fit waits for writes", async () => {
    type Observer = {
      target: Element | null;
      callback: (entries: ResizeObserverEntry[], obs: ResizeObserver) => void;
    };
    const observers: Observer[] = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    const finishWrites: Array<() => void> = [];
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
      render(<TerminalView instanceId="t-atlas-sticky" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
        expect(mockOnTerminalOutput).toHaveBeenCalled();
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      mockWrite.mockImplementationOnce((_: string | Uint8Array, callback?: () => void) => {
        if (callback) finishWrites.push(callback);
      });
      act(() => {
        onOutput?.(new TextEncoder().encode("pending parser write"));
      });
      expect(finishWrites).toHaveLength(1);

      const obs = observers[0];
      const target = obs.target as Element;
      mockFit.mockClear();
      mockClearTextureAtlas.mockClear();
      mockRefresh.mockClear();
      act(() => {
        obs.callback(
          [{ target, contentRect: { width: 0, height: 0 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
        obs.callback(
          [{ target, contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
        obs.callback(
          [{ target, contentRect: { width: 900, height: 600 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(mockFit).not.toHaveBeenCalled();

      act(() => {
        finishWrites[0]();
      });
      await vi.waitFor(() => {
        expect(mockFit).toHaveBeenCalledTimes(1);
        expect(mockClearTextureAtlas).toHaveBeenCalledTimes(1);
        expect(mockRefresh).toHaveBeenCalledTimes(1);
      });
    } finally {
      mockWrite.mockImplementation((_: string | Uint8Array, callback?: () => void) => {
        callback?.();
      });
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  // -- Regression: rapid resize burst (pane-divider drag) must coalesce (#285) --
  //
  // Dragging a pane divider emits a ResizeObserver entry every frame. Reflowing
  // (fit → terminal.resize → xterm buffer reflow) on each intermediate width
  // races xterm's synchronous reflow against ConPTY's async resize repaints and
  // corrupts scrollback (duplicated / merged lines). The fix debounces the fit
  // so a whole drag burst collapses into a single reflow after it settles.
  it("coalesces a rapid resize burst into a single fit (issue #285)", async () => {
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
      render(<TerminalView instanceId="t-resize-coalesce" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
      });

      const obs = observers[0];
      const target = obs.target as Element;

      // Ignore the synchronous creation fit; measure only the drag burst.
      mockFit.mockClear();

      // Simulate a divider drag: many distinct widths in one synchronous burst.
      act(() => {
        for (let w = 790; w >= 700; w -= 5) {
          obs.callback(
            [{ target, contentRect: { width: w, height: 600 } } as unknown as ResizeObserverEntry],
            {} as ResizeObserver,
          );
        }
      });

      // Debounced: no per-frame fit fires synchronously during the burst.
      expect(mockFit).not.toHaveBeenCalled();

      // After the burst settles, exactly one fit runs for the whole drag.
      await vi.waitFor(() => {
        expect(mockFit).toHaveBeenCalledTimes(1);
      });
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it("waits for queued PTY writes and an output quiet window before resize reflow", async () => {
    type Observer = {
      target: Element | null;
      callback: (entries: ResizeObserverEntry[], obs: ResizeObserver) => void;
    };
    const observers: Observer[] = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    const userAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
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
      render(<TerminalView instanceId="t-resize-write-queue" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
        expect(mockOnTerminalOutput).toHaveBeenCalled();
      });

      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      const finishWrites: Array<() => void> = [];
      const holdWrite = function (_: string | Uint8Array, callback?: () => void) {
        if (callback) finishWrites.push(callback);
      };
      mockWrite.mockImplementationOnce(holdWrite).mockImplementationOnce(holdWrite);

      mockFit.mockClear();
      act(() => {
        onOutput?.(new TextEncoder().encode("streaming output one"));
        onOutput?.(new TextEncoder().encode("streaming output two"));
      });

      const obs = observers[0];
      const target = obs.target as Element;
      act(() => {
        obs.callback(
          [{ target, contentRect: { width: 760, height: 600 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });

      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(mockFit).not.toHaveBeenCalled();

      act(() => {
        // A new ConPTY chunk can arrive after the queue briefly drained. Its
        // cursor-addressing sequences still target the old width, so the fit
        // must also wait for a short output-quiet window.
        onOutput?.(new TextEncoder().encode("latest streaming output"));
        finishWrites[0]?.();
      });
      expect(mockFit).not.toHaveBeenCalled();

      act(() => {
        finishWrites[1]?.();
      });
      expect(mockFit).not.toHaveBeenCalled();

      await new Promise((resolve) => setTimeout(resolve, 150));
      await vi.waitFor(() => {
        expect(mockFit).toHaveBeenCalledTimes(1);
      });
    } finally {
      userAgent.mockRestore();
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it("bounds resize deferral while ConPTY output remains continuous", async () => {
    type Observer = {
      target: Element | null;
      callback: (entries: ResizeObserverEntry[], obs: ResizeObserver) => void;
    };
    const observers: Observer[] = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    const userAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
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
      render(<TerminalView instanceId="t-resize-continuous" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
        expect(mockOnTerminalOutput).toHaveBeenCalled();
      });
      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      const obs = observers[0];
      const target = obs.target as Element;
      mockFit.mockClear();

      act(() => {
        obs.callback(
          [{ target, contentRect: { width: 760, height: 600 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });

      for (let i = 0; i < 14; i++) {
        act(() => {
          onOutput?.(new TextEncoder().encode(`continuous output ${i}`));
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      expect(mockFit).toHaveBeenCalledTimes(1);
    } finally {
      userAgent.mockRestore();
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it("waits for session restore writes to drain before resize reflow", async () => {
    type Observer = {
      target: Element | null;
      callback: (entries: ResizeObserverEntry[], obs: ResizeObserver) => void;
    };
    const observers: Observer[] = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    const finishWrites: Array<() => void> = [];
    const written: Array<string | Uint8Array> = [];
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
    mockLoadTerminalOutputCache.mockResolvedValueOnce("large cached terminal output");
    mockWrite.mockImplementation((data: string | Uint8Array, callback?: () => void) => {
      written.push(data);
      if (callback) finishWrites.push(callback);
    });

    try {
      render(
        <TerminalView
          instanceId="t-resize-restore-queue"
          paneId="pane-resize-restore"
          profile="PowerShell"
          syncGroup=""
        />,
      );
      await vi.waitFor(() => {
        expect(mockLoadTerminalOutputCache).toHaveBeenCalledWith("pane-resize-restore");
        expect(finishWrites).toHaveLength(1);
      });
      const obs = observers[0];
      const target = obs.target as Element;
      mockFit.mockClear();

      act(() => {
        obs.callback(
          [{ target, contentRect: { width: 760, height: 600 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(mockFit).not.toHaveBeenCalled();

      for (let index = 0; index < 4; index += 1) {
        const finish = finishWrites.shift();
        expect(finish).toBeTypeOf("function");
        act(() => finish?.());
        if (index < 3) {
          await vi.waitFor(() => expect(finishWrites).toHaveLength(1));
          expect(mockFit).not.toHaveBeenCalled();
        }
      }
      expect(written.at(-1)).toBe("\x1b[?2004l");
      await vi.waitFor(() => {
        expect(mockFit).toHaveBeenCalledTimes(1);
      });
    } finally {
      mockWrite.mockImplementation((_: string | Uint8Array, callback?: () => void) => {
        callback?.();
      });
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it("filters the ConPTY screen repaint after widening normal-buffer scrollback", async () => {
    const userAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

    try {
      render(<TerminalView instanceId="t-conpty-widen" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockGetRemoteControlStatus).toHaveBeenCalled();
        expect(mockOnTerminalOutput).toHaveBeenCalled();
        expect(capturedResizeHandler).not.toBeNull();
      });

      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      mockBufferActive.baseY = 40;
      mockWrite.mockClear();
      mockResizeTerminal.mockClear();

      act(() => {
        capturedResizeHandler?.({ cols: 100, rows: 24 });
      });
      await vi.waitFor(() => {
        expect(mockResizeTerminal).toHaveBeenCalledWith("t-conpty-widen", 100, 24);
      });

      act(() => {
        onOutput?.(
          new TextEncoder().encode("\x1b[?25l\x1b[Hduplicated historical rows\x1b[19;19H\x1b[?25h"),
        );
      });
      expect(mockWrite).not.toHaveBeenCalled();

      act(() => {
        onOutput?.(new TextEncoder().encode("real output after repaint"));
      });
      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(new TextDecoder().decode(mockWrite.mock.calls[0][0] as Uint8Array)).toBe(
        "real output after repaint",
      );
    } finally {
      userAgent.mockRestore();
    }
  });

  it("filters the ConPTY window-size repaint after narrowing normal-buffer scrollback", async () => {
    const userAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

    try {
      render(<TerminalView instanceId="t-conpty-narrow" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockOnTerminalOutput).toHaveBeenCalled();
        expect(capturedResizeHandler).not.toBeNull();
      });

      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      mockBufferActive.baseY = 40;
      mockWrite.mockClear();
      mockResizeTerminal.mockClear();

      act(() => {
        capturedResizeHandler?.({ cols: 60, rows: 24 });
      });
      await vi.waitFor(() => {
        expect(mockResizeTerminal).toHaveBeenCalledWith("t-conpty-narrow", 60, 24);
      });

      act(() => {
        onOutput?.(
          new TextEncoder().encode(
            "\x1b[?25l\x1b[8;24;60t\x1b[Hduplicated narrow rows\x1b[24;7H\x1b[?25h",
          ),
        );
      });
      expect(mockWrite).not.toHaveBeenCalled();
    } finally {
      userAgent.mockRestore();
    }
  });

  it("filters a widen repaint when shallow scrollback reflows to baseY zero", async () => {
    type Observer = {
      target: Element | null;
      callback: (entries: ResizeObserverEntry[], obs: ResizeObserver) => void;
    };
    const observers: Observer[] = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    const userAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
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
      render(<TerminalView instanceId="t-conpty-shallow" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
        expect(mockOnTerminalOutput).toHaveBeenCalled();
      });
      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      const obs = observers[0];
      const target = obs.target as Element;
      mockBufferActive.baseY = 1;
      mockWrite.mockClear();
      mockFit.mockClear();
      mockFit.mockImplementationOnce(() => {
        mockBufferActive.baseY = 0;
        capturedResizeHandler?.({ cols: 100, rows: 24 });
      });

      act(() => {
        obs.callback(
          [{ target, contentRect: { width: 1000, height: 600 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });
      await vi.waitFor(() => {
        expect(mockFit).toHaveBeenCalledTimes(1);
      });

      act(() => {
        onOutput?.(new TextEncoder().encode("\x1b[?25l\x1b[Hold screen\x1b[?25h"));
      });
      expect(mockWrite).not.toHaveBeenCalled();
    } finally {
      mockFit.mockImplementation(() => {});
      userAgent.mockRestore();
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it("keeps dropping the first repaint when a second widen rearms the filter", async () => {
    const userAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

    try {
      render(<TerminalView instanceId="t-conpty-rearm" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockOnTerminalOutput).toHaveBeenCalled();
        expect(capturedResizeHandler).not.toBeNull();
      });
      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      mockBufferActive.baseY = 40;
      mockWrite.mockClear();

      act(() => {
        capturedResizeHandler?.({ cols: 100, rows: 24 });
        onOutput?.(new TextEncoder().encode("\x1b[?25l\x1b[Hfirst frame"));
        capturedResizeHandler?.({ cols: 120, rows: 24 });
        onOutput?.(
          new TextEncoder().encode(
            " tail\x1b[?25hbetween\x1b[?25l\x1b[Hsecond frame\x1b[?25hafter",
          ),
        );
      });

      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(new TextDecoder().decode(mockWrite.mock.calls[0][0] as Uint8Array)).toBe(
        "betweenafter",
      );
    } finally {
      userAgent.mockRestore();
    }
  });

  it("keeps a split repaint start private when a second widen rearms scanning", async () => {
    const userAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");

    try {
      render(<TerminalView instanceId="t-conpty-probe-rearm" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockOnTerminalOutput).toHaveBeenCalled();
        expect(capturedResizeHandler).not.toBeNull();
      });
      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      mockBufferActive.baseY = 40;
      mockWrite.mockClear();

      act(() => {
        capturedResizeHandler?.({ cols: 100, rows: 24 });
        onOutput?.(new TextEncoder().encode("\x1b[?25"));
        capturedResizeHandler?.({ cols: 120, rows: 24 });
        onOutput?.(
          new TextEncoder().encode(
            "l\x1b[Hfirst frame\x1b[?25hbetween" + "\x1b[?25l\x1b[Hsecond frame\x1b[?25hafter",
          ),
        );
      });

      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(new TextDecoder().decode(mockWrite.mock.calls[0][0] as Uint8Array)).toBe(
        "betweenafter",
      );
    } finally {
      userAgent.mockRestore();
    }
  });

  it("releases the write-drain gate when xterm write throws synchronously", async () => {
    type Observer = {
      target: Element | null;
      callback: (entries: ResizeObserverEntry[], obs: ResizeObserver) => void;
    };
    const observers: Observer[] = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
      render(<TerminalView instanceId="t-write-throw" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
        expect(mockOnTerminalOutput).toHaveBeenCalled();
      });
      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      mockWrite.mockImplementationOnce(() => {
        throw new Error("write data discarded");
      });
      let writeError: unknown;
      try {
        act(() => {
          onOutput?.(new TextEncoder().encode("overloaded output"));
        });
      } catch (error) {
        writeError = error;
      }

      await vi.waitFor(() => {
        expect(mockWrite).toHaveBeenCalledTimes(2);
        expect(new TextDecoder().decode(mockWrite.mock.calls[1][0] as Uint8Array)).toBe(
          "overloaded output",
        );
      });

      const obs = observers[0];
      const target = obs.target as Element;
      mockFit.mockClear();
      act(() => {
        obs.callback(
          [{ target, contentRect: { width: 760, height: 600 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });

      await vi.waitFor(() => {
        expect(mockFit).toHaveBeenCalledTimes(1);
      });
      expect(writeError).toBeUndefined();
      expect(warn).toHaveBeenCalledWith("[TerminalView] xterm write failed:", expect.any(Error));
    } finally {
      mockWrite.mockImplementation((_: string | Uint8Array, callback?: () => void) => {
        callback?.();
      });
      warn.mockRestore();
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  // -- Regression: pending debounced fit cancelled when container hides (#285 P2) --
  //
  // A normal resize schedules the trailing fit, then the workspace/pane can go
  // display:none (0×0) before the 80ms debounce expires. If the pending timer
  // is not cancelled it fires fitAddon.fit() against the hidden container,
  // pushing cols/rows=0 through the PTY and garbling the pane on return.
  it("cancels a pending debounced fit when the container becomes hidden (issue #285 P2)", async () => {
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
      render(<TerminalView instanceId="t-resize-hide" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
      });

      const obs = observers[0];
      const target = obs.target as Element;
      mockFit.mockClear();

      // 1) A normal size change schedules the debounced fit.
      act(() => {
        obs.callback(
          [{ target, contentRect: { width: 760, height: 600 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });

      // 2) Before the 80ms debounce fires, the pane is hidden (display:none → 0×0).
      act(() => {
        obs.callback(
          [{ target, contentRect: { width: 0, height: 0 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });

      // 3) Wait past the debounce window: the pending fit must NOT have fired
      //    (cancelled on hide), so no fit runs against the 0×0 container.
      await new Promise((r) => setTimeout(r, 150));
      expect(mockFit).not.toHaveBeenCalled();
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  // -- Regression: reflow triggers fired while inactive workspace is hidden --
  //
  // WorkspaceArea hides inactive workspaces via `display: none`. The font /
  // DPR / scrollbar reflow effects run for every mounted TerminalView, so
  // without a guard they call `fit()` on a 0×0 container — propagating
  // cols/rows=0 through `terminal.onResize` to a PTY resize ioctl — and
  // attempt an atlas rebuild against a canvas that is not painted. Both are
  // wasted work; worse, the bogus PTY resize can leave inactive workspaces
  // with glyphs collapsed to the left when they are next shown. Defer all
  // three paths while hidden and rely on the existing hidden→visible
  // transition (issue #232) to rebuild atlas once on return.
  it("does not fit/clear atlas when fontSize changes while container is hidden", async () => {
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
      render(
        <TerminalView
          instanceId="t-hidden-font"
          paneId="pane-hidden-font"
          profile="PowerShell"
          syncGroup=""
        />,
      );
      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
      });
      const obs = observers[0];
      const target = obs.target as Element;

      // Workspace becomes inactive → 0×0.
      act(() => {
        obs.callback(
          [{ target, contentRect: { width: 0, height: 0 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });

      mockFit.mockClear();
      mockClearTextureAtlas.mockClear();
      mockRefresh.mockClear();

      // Font change while hidden — must NOT touch fit/atlas.
      act(() => {
        useOverridesStore.getState().setViewOverride("pane-hidden-font", { fontSize: 22 });
      });

      // Flush any pending rAF — runTerminalRendererReflow defers via rAF
      // (stubbed to setTimeout(0)). Wait one tick plus a margin.
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(mockFit).not.toHaveBeenCalled();
      expect(mockClearTextureAtlas).not.toHaveBeenCalled();
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it("does not fit/clear atlas when DPR changes while container is hidden", async () => {
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
      render(<TerminalView instanceId="t-hidden-dpr" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
      });
      const obs = observers[0];
      const target = obs.target as Element;

      // Hide.
      act(() => {
        obs.callback(
          [{ target, contentRect: { width: 0, height: 0 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });

      mockFit.mockClear();
      mockClearTextureAtlas.mockClear();

      // Simulate DPR change while hidden.
      const listeners = mqls.flatMap((mql) => mql.listeners);
      expect(listeners.length).toBeGreaterThan(0);
      act(() => {
        for (const listener of listeners) {
          listener(new Event("change") as MediaQueryListEvent);
        }
      });

      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(mockFit).not.toHaveBeenCalled();
      expect(mockClearTextureAtlas).not.toHaveBeenCalled();
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
      window.matchMedia = originalMatchMedia;
    }
  });

  it("does not fit when scrollbarStyle changes while container is hidden", async () => {
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
      render(<TerminalView instanceId="t-hidden-sb" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
      });
      const obs = observers[0];
      const target = obs.target as Element;

      // Hide.
      act(() => {
        obs.callback(
          [{ target, contentRect: { width: 0, height: 0 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });

      mockFit.mockClear();

      // Scrollbar style change while hidden.
      useSettingsStore.setState({
        ...useSettingsStore.getState(),
        terminal: {
          ...useSettingsStore.getState().terminal,
          scrollbarStyle: "separate" as const,
        },
      });

      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(mockFit).not.toHaveBeenCalled();
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it("rebuilds atlas on hidden→visible transition after a deferred font change", async () => {
    type Observer = {
      target: Element | null;
      callback: (entries: ResizeObserverEntry[], obs: ResizeObserver) => void;
    };
    const observers: Observer[] = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    const userAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
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
      render(
        <TerminalView
          instanceId="t-deferred-font"
          paneId="pane-deferred-font"
          profile="PowerShell"
          syncGroup=""
        />,
      );
      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
      });
      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      const obs = observers[0];
      const target = obs.target as Element;

      // Hide.
      act(() => {
        obs.callback(
          [{ target, contentRect: { width: 0, height: 0 } } as unknown as ResizeObserverEntry],
          {} as ResizeObserver,
        );
      });

      // Font change while hidden — deferred.
      act(() => {
        useOverridesStore.getState().setViewOverride("pane-deferred-font", { fontSize: 22 });
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      mockFit.mockClear();
      mockClearTextureAtlas.mockClear();
      mockRefresh.mockClear();

      // Show again: clear the stale canvas immediately, then rebuild once more
      // after the guarded fit applies the deferred font geometry.
      vi.useFakeTimers();
      act(() => {
        onOutput?.(new TextEncoder().encode("recent output"));
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
      expect(mockFit).not.toHaveBeenCalled();
      expect(mockClearTextureAtlas).toHaveBeenCalledTimes(1);
      expect(mockRefresh).toHaveBeenCalledTimes(1);
      act(() => {
        vi.advanceTimersByTime(120);
      });
      expect(mockFit).toHaveBeenCalledTimes(1);
      expect(mockClearTextureAtlas).toHaveBeenCalledTimes(2);
      expect(mockRefresh).toHaveBeenCalledTimes(2);
      vi.useRealTimers();
    } finally {
      vi.useRealTimers();
      userAgent.mockRestore();
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
      terminal: {
        ...useSettingsStore.getState().terminal,
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
      terminal: {
        ...useSettingsStore.getState().terminal,
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
      terminal: {
        ...useSettingsStore.getState().terminal,
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
      terminal: {
        ...useSettingsStore.getState().terminal,
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

    it("passes a structured external viewer request to session creation", async () => {
      const viewerStartup = { command: "vi", path: "C:\\Users\\me\\README.md" };
      render(
        <TerminalView
          instanceId="t-viewer-structured"
          profile="Ubuntu"
          syncGroup=""
          cwdSend={false}
          cwdReceive={false}
          viewerStartup={viewerStartup}
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-viewer-structured",
          "Ubuntu",
          80,
          24,
          "",
          false,
          false,
          undefined,
          viewerStartup,
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

    it("repairs a cache saved while the alternate buffer was active", async () => {
      const normalBuffer = "old scrollback\r\nlast normal line";
      const cached = `${normalBuffer}\x1b[?1049h\x1b[Hstale Claude frame`;
      mockLoadTerminalOutputCache.mockResolvedValueOnce(cached);

      render(
        <TerminalView
          instanceId="t-restore-alt"
          paneId="pane-restore-alt"
          profile="PowerShell"
          syncGroup="default"
        />,
      );

      await vi.waitFor(() => {
        const calls = mockWrite.mock.calls.map((c: unknown[]) => c[0]);
        expect(calls).toContain(normalBuffer);
        expect(calls).not.toContain(cached);
      });
    });

    it("serializes output caches without alternate buffers or live terminal modes", async () => {
      render(
        <TerminalView
          instanceId="t-ser-options"
          paneId="pane-ser-options"
          profile="PowerShell"
          syncGroup="default"
        />,
      );

      await vi.waitFor(() => {
        expect(mockRegisterTerminalSerializer).toHaveBeenCalledWith(
          "pane-ser-options",
          expect.any(Function),
        );
      });

      const serializer = mockRegisterTerminalSerializer.mock.calls.find(
        ([id]) => id === "pane-ser-options",
      )?.[1] as (() => string) | undefined;
      expect(serializer?.()).toBe("serialized-data");
      expect(mockSerialize).toHaveBeenCalledWith({
        excludeAltBuffer: true,
        excludeModes: true,
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
    it("reserves later reveal waves after the last scheduled slot", () => {
      _resetWebglStagger();
      expect(_reserveWebglInitDelay(0)).toBe(0);
      expect(_reserveWebglInitDelay(0)).toBe(150);
      expect(_reserveWebglInitDelay(0)).toBe(300);
      expect(_reserveWebglInitDelay(0)).toBe(450);

      // The first slot has already fired at 16ms, but three reservations remain.
      // A counter-based scheduler incorrectly returned 450ms (target 466ms),
      // nearly colliding with the 450ms slot. The timeline reserves 600ms.
      expect(_reserveWebglInitDelay(16)).toBe(584);
    });

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

    it("does not accumulate delay after the reserved timeline has elapsed", async () => {
      vi.useFakeTimers();
      _resetWebglStagger();

      // Wave 1: two terminals mount and both WebGL inits fire (delays 0, 150).
      render(<TerminalView instanceId="t-wave1a" profile="PowerShell" syncGroup="g" />);
      render(<TerminalView instanceId="t-wave1b" profile="PowerShell" syncGroup="g" />);
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      await act(async () => {
        vi.advanceTimersByTime(150);
      });
      expect(WebglAddon).toHaveBeenCalledTimes(2);
      const afterWave1 = WebglAddon.mock.calls.length;

      // Once the next allowed slot has passed, a later wave starts immediately;
      // the reservation timeline does not grow with app-lifetime mount count.
      await act(async () => {
        vi.advanceTimersByTime(150);
      });
      render(<TerminalView instanceId="t-wave2" profile="PowerShell" syncGroup="g" />);
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(WebglAddon).toHaveBeenCalledTimes(afterWave1 + 1);

      vi.useRealTimers();
    });

    it("keeps the full stagger interval when a later reveal wave overlaps reservations", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      _resetWebglStagger();

      // Initial reveal reserves four slots. After the first slot fires, a new
      // pane is mounted on the next frame while 150/300/450ms slots are still
      // pending. The new reservation must come after the last existing slot,
      // not after `inFlightCount * 150` from the current frame.
      for (let i = 0; i < 4; i++) {
        render(<TerminalView instanceId={`t-overlap-${i}`} profile="PowerShell" syncGroup="g" />);
      }
      await act(async () => {
        vi.advanceTimersByTime(1);
      });
      expect(WebglAddon).toHaveBeenCalledTimes(1);

      await act(async () => {
        vi.advanceTimersByTime(15);
      });
      render(<TerminalView instanceId="t-overlap-late" profile="PowerShell" syncGroup="g" />);
      await act(async () => {
        vi.advanceTimersByTime(700);
      });

      expect(WebglAddon).toHaveBeenCalledTimes(5);
      const gaps = webglInitTimes.slice(1).map((time, i) => time - webglInitTimes[i]);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(150);

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
      expect(screen.getByTestId("terminal-pinned-info-title-t-pin-info").className).toContain(
        "ui-toolbar-title",
      );
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

describe("isTerminalScrolledUp", () => {
  const makeTerminal = (baseY: number, viewportY?: number) =>
    ({ buffer: { active: { baseY, viewportY } } }) as unknown as Parameters<
      typeof isTerminalScrolledUp
    >[0];

  it("returns false when pinned to the live bottom (viewportY === baseY)", () => {
    expect(isTerminalScrolledUp(makeTerminal(100, 100))).toBe(false);
  });

  it("returns true when scrolled up into scrollback (viewportY < baseY)", () => {
    expect(isTerminalScrolledUp(makeTerminal(100, 40))).toBe(true);
  });

  it("treats a missing viewportY as being at the bottom", () => {
    expect(isTerminalScrolledUp(makeTerminal(100))).toBe(false);
  });
});

describe("TerminalView jump-to-bottom button (issue #349)", () => {
  it("hides the button initially and shows it after scrolling up", async () => {
    render(<TerminalView instanceId="t-jump" profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => {
      expect(capturedScrollHandler).not.toBeNull();
    });

    expect(screen.queryByTestId("terminal-scroll-to-bottom-t-jump")).not.toBeInTheDocument();

    // Simulate the user scrolling up: viewport now sits above the base.
    mockBufferActive.baseY = 100;
    mockBufferActive.viewportY = 30;
    await act(async () => {
      capturedScrollHandler?.();
    });

    expect(screen.getByTestId("terminal-scroll-to-bottom-t-jump")).toBeInTheDocument();
  });

  it("keeps the button hidden when disabled via settings, even when scrolled up", async () => {
    useSettingsStore.getState().setTerminal({ showScrollToBottomButton: false });
    try {
      render(<TerminalView instanceId="t-jump-off" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(capturedScrollHandler).not.toBeNull();
      });

      // Scroll up: normally this would reveal the button.
      mockBufferActive.baseY = 100;
      mockBufferActive.viewportY = 30;
      await act(async () => {
        capturedScrollHandler?.();
      });

      expect(screen.queryByTestId("terminal-scroll-to-bottom-t-jump-off")).not.toBeInTheDocument();
    } finally {
      useSettingsStore.getState().setTerminal({ showScrollToBottomButton: true });
    }
  });

  it("scrolls to bottom and hides the button on click", async () => {
    render(<TerminalView instanceId="t-jump2" profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => {
      expect(capturedScrollHandler).not.toBeNull();
    });

    mockBufferActive.baseY = 100;
    mockBufferActive.viewportY = 30;
    await act(async () => {
      capturedScrollHandler?.();
    });

    const button = screen.getByTestId("terminal-scroll-to-bottom-t-jump2");
    await act(async () => {
      fireEvent.click(button);
    });

    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("terminal-scroll-to-bottom-t-jump2")).not.toBeInTheDocument();
  });

  it("shows the button on mount when already scrolled up (no scroll event yet)", async () => {
    // Reattach/restore case: the viewport is parked above the scrollback
    // bottom before the first onScroll fires. The mount-time refresh must
    // sync the button so it appears without waiting for a scroll event.
    mockBufferActive.baseY = 100;
    mockBufferActive.viewportY = 30;
    render(<TerminalView instanceId="t-jump-init" profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => {
      expect(capturedScrollHandler).not.toBeNull();
    });

    await vi.waitFor(() => {
      expect(screen.getByTestId("terminal-scroll-to-bottom-t-jump-init")).toBeInTheDocument();
    });
  });

  it("hides the button again when the viewport returns to the bottom", async () => {
    render(<TerminalView instanceId="t-jump3" profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => {
      expect(capturedScrollHandler).not.toBeNull();
    });

    mockBufferActive.baseY = 100;
    mockBufferActive.viewportY = 30;
    await act(async () => {
      capturedScrollHandler?.();
    });
    expect(screen.getByTestId("terminal-scroll-to-bottom-t-jump3")).toBeInTheDocument();

    // Viewport scrolls back down to the live bottom.
    mockBufferActive.viewportY = 100;
    await act(async () => {
      capturedScrollHandler?.();
    });
    expect(screen.queryByTestId("terminal-scroll-to-bottom-t-jump3")).not.toBeInTheDocument();
  });

  // Issue #361: the button must clear the scrollbar slider. The slider renders at
  // the same right-edge width in both modes and the button is positioned relative
  // to the pane edge, so the offset (--terminal-scroll-btn-right) is the same
  // (26px = 14px slider + 12px clearance) regardless of scrollbar mode.
  it("uses a 26px right offset in overlay scrollbar mode", () => {
    useSettingsStore.getState().setTerminal({ scrollbarStyle: "overlay" });
    render(<TerminalView instanceId="t-sb-overlay" profile="PowerShell" syncGroup="" />);
    const wrapper = screen.getByTestId("terminal-view-t-sb-overlay");
    expect(wrapper.style.getPropertyValue("--terminal-scroll-btn-right")).toBe("26px");
  });

  it("uses the same 26px right offset in separate scrollbar mode", () => {
    useSettingsStore.getState().setTerminal({ scrollbarStyle: "separate" });
    render(<TerminalView instanceId="t-sb-separate" profile="PowerShell" syncGroup="" />);
    const wrapper = screen.getByTestId("terminal-view-t-sb-separate");
    // 14px scrollbar slider + 12px clearance.
    expect(wrapper.style.getPropertyValue("--terminal-scroll-btn-right")).toBe("26px");
  });
});

describe("TerminalView desktop input composer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useOverridesStore.setState({ paneOverrides: {}, viewOverrides: {} });
    useNotificationStore.setState({ notifications: [] });
    localStorage.clear();
    clearRuntimeComposerState();
    mockOutputSequence = 0;
    capturedKeyHandler = null;
    capturedResizeHandler = null;
    mockGetRemoteControlStatus.mockResolvedValue({
      active: false,
      leaseId: null,
      remoteAddr: null,
      clientName: null,
      heartbeatTimeoutSeconds: 15,
    });
    mockWriteTerminalInput.mockResolvedValue(undefined);
  });

  // The input-mode toggle now lives in the pane control bar, which is not mounted
  // when TerminalView is rendered in isolation. Drive mode switches through the
  // registered keybinding (Ctrl+Alt+M) instead of clicking an in-composer button.
  const toggleInputMode = (terminalId: string) => {
    const host = screen.getByTestId(`terminal-input-composer-${terminalId}`);
    fireEvent.keyDown(host.parentElement!, { key: "m", ctrlKey: true, altKey: true });
  };

  // Feed raw output so OSC 133 flips the prompt/program phase the Composer routes on.
  const emitOutput = (terminalId: string, str: string) => {
    const onOutput = mockOnTerminalOutput.mock.calls.find((call) => call[0] === terminalId)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;
    act(() => onOutput?.(new TextEncoder().encode(str)));
  };

  it("toggles the desktop composer through the registered keybinding", async () => {
    render(<TerminalView instanceId="t-composer-toggle" profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    const composer = screen.getByTestId("terminal-input-composer-t-composer-toggle");
    expect(composer).toHaveAttribute("data-mode", "direct");
    expect(screen.queryByTestId("terminal-input-composer-t-composer-toggle-textarea")).toBeNull();

    fireEvent.keyDown(composer.parentElement!, { key: "m", ctrlKey: true, altKey: true });

    expect(composer).toHaveAttribute("data-mode", "composer");
    expect(
      screen.getByTestId("terminal-input-composer-t-composer-toggle-textarea"),
    ).toBeInTheDocument();
    expect(localStorage.getItem("laymux.desktop.inputMode")).toBe("composer");
  });

  it("hides the native WebGL cursor in Composer and restores it in Direct", async () => {
    const terminalId = "t-composer-webgl-cursor";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    const terminal = createdTerminals.at(-1)!;
    toggleInputMode(terminalId);

    await vi.waitFor(() => {
      expect(terminal.options.cursorInactiveStyle).toBe("none");
      expect(screen.getByTestId(`terminal-view-${terminalId}`)).toHaveClass(
        "terminal-native-cursor-hidden",
      );
    });

    toggleInputMode(terminalId);
    await vi.waitFor(() => {
      expect(terminal.options.cursorInactiveStyle).toBe("outline");
      expect(screen.getByTestId(`terminal-view-${terminalId}`)).not.toHaveClass(
        "terminal-native-cursor-hidden",
      );
    });
  });

  it("drops an async Direct smart paste that resolves after switching to Composer", async () => {
    const terminalId = "t-composer-stale-paste";
    let resolvePaste!: (value: { pasteType: string; content: string }) => void;
    mockSmartPaste.mockReturnValueOnce(
      new Promise((resolve) => {
        resolvePaste = resolve;
      }),
    );
    mockHasSelection.mockReturnValue(false);

    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    const container = screen.getByTestId(`terminal-view-${terminalId}`);
    container.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(mockSmartPaste).toHaveBeenCalledWith("", "PowerShell"));

    toggleInputMode(terminalId);
    await act(async () => {
      resolvePaste({ pasteType: "text", content: "must stay in the draft boundary" });
      await Promise.resolve();
    });

    expect(mockWriteTerminalInput).not.toHaveBeenCalled();
  });

  it("installs the Remote owner listener before requesting its initial snapshot", async () => {
    let resolveListener!: (cleanup: () => void) => void;
    mockOnRemoteControlChanged.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveListener = resolve;
      }),
    );

    render(
      <TerminalView instanceId="t-owner-listener-barrier" profile="PowerShell" syncGroup="" />,
    );
    await vi.waitFor(() => expect(mockOnRemoteControlChanged).toHaveBeenCalledTimes(1));
    expect(mockGetRemoteControlStatus).not.toHaveBeenCalled();

    await act(async () => resolveListener(vi.fn()));
    await vi.waitFor(() => expect(mockGetRemoteControlStatus).toHaveBeenCalledTimes(1));
  });

  it("discards a stale Local snapshot that resolves after a Remote owner event", async () => {
    let resolveStatus!: (status: { active: boolean }) => void;
    localStorage.setItem("laymux.desktop.inputMode", "composer");
    mockGetRemoteControlStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveStatus = resolve;
      }),
    );

    const terminalId = "t-owner-stale-snapshot";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => expect(mockGetRemoteControlStatus).toHaveBeenCalledTimes(1));

    act(() => capturedRemoteControlChanged?.({ active: true }));
    await act(async () => resolveStatus({ active: false }));

    expect(screen.getByTestId(`terminal-input-composer-${terminalId}-textarea`)).toBeDisabled();
  });

  it("keeps an unknown owner fail-closed and retries a failed status snapshot", async () => {
    vi.useFakeTimers();
    let unmount: (() => void) | undefined;
    try {
      localStorage.setItem("laymux.desktop.inputMode", "composer");
      mockGetRemoteControlStatus.mockRejectedValueOnce(new Error("IPC unavailable"));

      const terminalId = "t-owner-status-retry";
      ({ unmount } = render(
        <TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />,
      ));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockGetRemoteControlStatus).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId(`terminal-input-composer-${terminalId}-textarea`)).toBeDisabled();

      await act(async () => {
        vi.advanceTimersByTime(3000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(mockGetRemoteControlStatus).toHaveBeenCalledTimes(2);
      expect(screen.getByTestId(`terminal-input-composer-${terminalId}-textarea`)).toBeEnabled();
    } finally {
      unmount?.();
      vi.useRealTimers();
    }
  });

  it("fails closed and reattaches after a malformed V2 output delta", async () => {
    const terminalId = "t-composer-malformed-output";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode(terminalId);
    const composer = screen.getByTestId(`terminal-input-composer-${terminalId}`);
    await vi.waitFor(() => expect(composer).toHaveAttribute("data-can-send", "true"));

    const registeredOutput = mockOnTerminalOutput.mock.calls.find(
      ([registeredTerminalId]) => registeredTerminalId === terminalId,
    );
    const emitOutput = registeredOutput?.[1] as
      | ((data: Uint8Array | Record<string, unknown>) => void)
      | undefined;
    expect(emitOutput).toBeDefined();

    const attachCallsBeforeMalformedDelta = mockAttachTerminalOutput.mock.calls.length;
    // Keep the recovery attach pending so readiness cannot bounce back to true
    // before the fail-closed assertion observes it.
    mockAttachTerminalOutput.mockReturnValueOnce(new Promise(() => {}));

    act(() => {
      emitOutput?.({ seqStart: 0, seqEnd: 2, data: [0x61] });
    });

    expect(composer).toHaveAttribute("data-can-send", "false");
    await vi.waitFor(() => {
      expect(mockAttachTerminalOutput.mock.calls.length).toBeGreaterThan(
        attachCallsBeforeMalformedDelta,
      );
    });
  });

  it("routes a native terminal paste through structured input", async () => {
    const terminalId = "t-composer-native-paste";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();
    mockWriteTerminalInput.mockClear();
    mockWriteToTerminal.mockClear();

    fireEvent.paste(screen.getByTestId(`terminal-xterm-host-${terminalId}`), {
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "first\nsecond" : ""),
      },
    });

    expect(mockWriteTerminalInput).toHaveBeenCalledWith(terminalId, "first\nsecond", false);
    expect(mockWriteToTerminal).not.toHaveBeenCalled();
  });

  it("sends one submitted composer action and clears the unchanged desktop draft", async () => {
    render(<TerminalView instanceId="t-composer-send" profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode("t-composer-send");
    const textarea = screen.getByTestId(
      "terminal-input-composer-t-composer-send-textarea",
    ) as HTMLTextAreaElement;
    await vi.waitFor(() =>
      expect(screen.getByTestId("terminal-input-composer-t-composer-send")).toHaveAttribute(
        "data-can-send",
        "true",
      ),
    );
    fireEvent.change(textarea, { target: { value: "한글\nsecond" } });
    expect(
      screen.queryByTestId("terminal-input-composer-t-composer-send-insert"),
    ).not.toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(mockWriteTerminalInput).toHaveBeenCalledWith("t-composer-send", "한글\nsecond", true);
    await vi.waitFor(() => expect(textarea.value).toBe(""));
  });

  it("blocks duplicate Send while preserving edits made in flight", async () => {
    let resolveInput!: () => void;
    mockWriteTerminalInput.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveInput = resolve;
      }),
    );
    render(<TerminalView instanceId="t-composer-flight" profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode("t-composer-flight");
    const textarea = screen.getByTestId(
      "terminal-input-composer-t-composer-flight-textarea",
    ) as HTMLTextAreaElement;
    const composer = screen.getByTestId("terminal-input-composer-t-composer-flight");
    await vi.waitFor(() => expect(composer).toHaveAttribute("data-can-send", "true"));
    fireEvent.change(textarea, { target: { value: "first" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(mockWriteTerminalInput).toHaveBeenCalledTimes(1);
    expect(mockWriteTerminalInput).toHaveBeenCalledWith("t-composer-flight", "first", true);

    fireEvent.change(textarea, { target: { value: "first + next" } });
    await act(async () => resolveInput());
    expect(textarea.value).toBe("first + next");
  });

  it("updates a replacement mount when an earlier mount's submission settles", async () => {
    let resolveInput!: () => void;
    mockWriteTerminalInput.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveInput = resolve;
      }),
    );
    const terminalId = "t-composer-remount-flight";
    const first = render(
      <TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />,
    );
    await waitForTerminalInputReady();

    toggleInputMode(terminalId);
    const firstTextarea = screen.getByTestId(`terminal-input-composer-${terminalId}-textarea`);
    fireEvent.change(firstTextarea, { target: { value: "pending across remount" } });
    fireEvent.keyDown(firstTextarea, { key: "Enter" });
    first.unmount();

    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    const replacementTextarea = await screen.findByTestId(
      `terminal-input-composer-${terminalId}-textarea`,
    );
    expect(replacementTextarea).toHaveValue("pending across remount");
    expect(screen.getByTestId(`terminal-input-composer-${terminalId}`)).toHaveAttribute(
      "data-can-send",
      "false",
    );

    await act(async () => resolveInput());
    await vi.waitFor(() => {
      expect(replacementTextarea).toHaveValue("");
      expect(screen.getByTestId(`terminal-input-composer-${terminalId}`)).toHaveAttribute(
        "data-can-send",
        "true",
      );
    });
  });

  it("keeps the desktop draft but disables editing while Remote owns the PTY", async () => {
    localStorage.setItem("laymux.desktop.inputMode", "composer");
    mockGetRemoteControlStatus.mockResolvedValueOnce({
      active: true,
      leaseId: "lease-remote",
      remoteAddr: "127.0.0.1:4000",
      clientName: "phone",
      heartbeatTimeoutSeconds: 15,
    });
    render(<TerminalView instanceId="t-composer-remote" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(
        screen.getByTestId("terminal-input-composer-t-composer-remote-textarea"),
      ).toBeDisabled();
    });
    expect(screen.getByTestId("terminal-input-composer-t-composer-remote")).toHaveAttribute(
      "data-can-send",
      "false",
    );
    expect(mockWriteTerminalInput).not.toHaveBeenCalled();
  });

  it("recalls Composer history into the draft at the shell prompt (not the shell's)", async () => {
    const terminalId = "t-composer-history";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode(terminalId);
    const textarea = screen.getByTestId(
      `terminal-input-composer-${terminalId}-textarea`,
    ) as HTMLTextAreaElement;

    // Send one entry so the Composer has history, then confirm the draft cleared.
    fireEvent.change(textarea, { target: { value: "echo hi" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await vi.waitFor(() => expect(textarea.value).toBe(""));

    mockWriteToTerminal.mockClear();
    // Empty draft at the prompt: ↑ recalls into the editor, not the terminal line.
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    await vi.waitFor(() => expect(textarea.value).toBe("echo hi"));
    expect(mockWriteToTerminal).not.toHaveBeenCalled();
  });

  it("forwards every key (and honors DECCKM) while a program owns the screen", async () => {
    const terminalId = "t-composer-program";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode(terminalId);
    const textarea = screen.getByTestId(`terminal-input-composer-${terminalId}-textarea`);
    // OSC 133;C = a command started running → Composer steps aside to passthrough.
    emitOutput(terminalId, "\x1b]133;C\x07");
    mockWriteToTerminal.mockClear();

    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(mockWriteToTerminal).toHaveBeenCalledWith(terminalId, "\x1b[A");
    fireEvent.keyDown(textarea, { key: "j" });
    expect(mockWriteToTerminal).toHaveBeenCalledWith(terminalId, "j");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(mockWriteToTerminal).toHaveBeenCalledWith(terminalId, "\r");

    const modes = mockModes as typeof mockModes & { applicationCursorKeysMode?: boolean };
    try {
      modes.applicationCursorKeysMode = true;
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      expect(mockWriteToTerminal).toHaveBeenCalledWith(terminalId, "\x1bOA");
    } finally {
      delete modes.applicationCursorKeysMode;
    }

    // Back at the prompt, keys belong to the Composer again.
    emitOutput(terminalId, "\x1b]133;B\x07");
    mockWriteToTerminal.mockClear();
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(mockWriteToTerminal).not.toHaveBeenCalled();
  });
});

describe("shouldEnableTerminalWebgl", () => {
  it("keeps WebGL enabled", () => {
    expect(shouldEnableTerminalWebgl()).toBe(true);
  });
});
