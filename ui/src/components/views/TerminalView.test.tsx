import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { TerminalView } from "./TerminalView";
import { setTerminalOutputV3RuntimeLoaderForTest } from "@/lib/terminal-output-v3-runtime-loader";
import {
  _resetWebglStagger,
  _reserveWebglInitDelay,
  shouldEnableTerminalWebgl,
  isTerminalScrolledUp,
} from "@/lib/terminal-view-runtime";
import { WebglAddon } from "@xterm/addon-webgl";
import { useTerminalStore } from "@/stores/terminal-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useOverridesStore } from "@/stores/overrides-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useWorkspaceStore } from "@/stores/workspace-store";
import { useTerminalStartupStore } from "@/stores/terminal-startup-store";
import { CODEX_INPUT_PENDING_MARKER, CLAUDE_INPUT_PENDING_MARKER } from "@/lib/activity-detection";
import { clearRuntimeComposerState } from "@/lib/terminal-input-composer-state";
import { terminalOutputRecoveryCounters } from "@/lib/terminal-output-recovery-metrics";
import * as terminalOutputRecoveryMetrics from "@/lib/terminal-output-recovery-metrics";
import { terminalOutputPipelineCounters } from "@/lib/terminal-output-pipeline-metrics";
import {
  allTerminalInputDeliveryCounters,
  forgetTerminalInputDeliveryCounters,
  resetTerminalInputDeliveryCounters,
  terminalInputDeliveryCounters,
} from "@/lib/terminal-input-delivery-metrics";
import { terminalOutputControlOperationRegistry } from "@/lib/terminal-output-control-registry";
import { terminalWriteFairScheduler } from "@/lib/terminal-write-fair-scheduler";
import {
  allTerminalOutputV3Diagnostics,
  resetTerminalOutputV3DiagnosticsForTest,
} from "@/lib/terminal-output-v3-diagnostics";
import { LAYMUX_UNICODE_VERSION } from "@/lib/terminal-unicode-width";
import {
  registerAtlasRebuilder,
  unregisterAtlasRebuilder,
  notifyTextureAtlasCleared,
  __resetAtlasRebuildersForTest,
} from "@/lib/webgl-atlas-rebuild";

// Mock xterm since it requires a real DOM with canvas
const mockOnData = vi.fn();
const mockOnBinary = vi.fn();
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
const mockGetSelectionPosition = vi.fn().mockReturnValue(null);
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
/**
 * ADR-0188 point 트리거용 라인 fixture. `setMockBufferLine` 로 채운 텍스트를
 * 실제 xterm 처럼 셀 단위로 돌려준다(모두 1셀 폭 문자로 가정).
 */
type MockBufferLine = {
  length: number;
  getCell(x: number): { getChars(): string; getWidth(): number } | undefined;
  translateToString(trimRight?: boolean): string;
};
let mockBufferLineText: string | null = null;
function setMockBufferLine(text: string | null): void {
  mockBufferLineText = text;
}
function mockBufferLine(): MockBufferLine | undefined {
  const text = mockBufferLineText;
  if (text === null) return undefined;
  return {
    length: text.length,
    getCell: (x: number) =>
      x < text.length ? { getChars: () => text[x], getWidth: () => 1 } : undefined,
    translateToString: (trimRight = false) => (trimRight ? text.trimEnd() : text),
  };
}
const mockBufferActive: {
  cursorX: number;
  cursorY: number;
  baseY: number;
  viewportY: number;
  length: number;
  getLine(index: number): MockBufferLine | undefined;
  // Real xterm reports which buffer is live. Composer passthrough keys off it.
  type: "normal" | "alternate";
} = {
  cursorX: 0,
  cursorY: 0,
  baseY: 0,
  viewportY: 0,
  length: 1,
  getLine: () => mockBufferLine(),
  type: "normal",
};
const mockOnScroll = vi.fn((handler: () => void) => {
  capturedScrollHandler = handler;
  return { dispose: vi.fn() };
});
type MockTerminalInstance = {
  options: Record<string, unknown>;
  element: HTMLDivElement;
  emitCoreData(data: string, wasUserInput?: boolean): void;
  _core: { coreService: { isCursorHidden: boolean } };
};
const createdTerminals: MockTerminalInstance[] = [];
const mockModes = { synchronizedOutputMode: false };
let capturedKeyHandler: ((e: KeyboardEvent) => boolean) | null = null;
let capturedWheelHandler: ((e: WheelEvent) => boolean) | null = null;
const mockAttachCustomKeyEventHandler = vi.fn((handler: (e: KeyboardEvent) => boolean) => {
  capturedKeyHandler = handler;
});
const mockAttachCustomWheelEventHandler = vi.fn((handler: (e: WheelEvent) => boolean) => {
  capturedWheelHandler = handler;
});
const mockConsumeWheelEvent = vi.fn(() => 1);
const mockTerminalInput = vi.fn();
function completeMockWrite(_: string | Uint8Array, callback?: () => void): void {
  callback?.();
}
const mockWrite = vi.fn(completeMockWrite);
const mockRefresh = vi.fn();
const mockClearTextureAtlas = vi.fn();
type MockPathLinkDecoration = {
  element: HTMLElement;
  dispose: ReturnType<typeof vi.fn>;
};
const mockPathLinkDecorations: MockPathLinkDecoration[] = [];

// ── stream attach reset gate ────────────────────────────────────────────────
// The output attach chain ends in `terminal.reset()`, which also rebuilds the
// pane's stream-derived cursor state (issue #596). Production buffers live bytes
// behind that reset, so no parser sequence can ever be observed before it — but
// a test driving the parser handlers directly can, and would then watch its own
// shadow-cursor state get wiped.
//
// No individual test should have to remember that (issue #603): the mock funnels
// every registered parser handler through `waitForStreamAttachReset()` below, so
// the ordering rule is enforced by the harness instead of by convention.
//
// The gate is armed by the `terminal.reset()` call itself rather than by polling
// or by counting event-loop turns, so it stays correct however many awaits the
// attach chain gains or loses.
let streamAttachResetSeen = false;
let resolveStreamAttachReset: (() => void) | undefined;
let streamAttachResetArrived = new Promise<void>((resolve) => {
  resolveStreamAttachReset = resolve;
});
function armStreamAttachResetGate(): void {
  streamAttachResetSeen = false;
  streamAttachResetArrived = new Promise<void>((resolve) => {
    resolveStreamAttachReset = resolve;
  });
}
// Modelled on the real `reset()`, whose semantics are pinned against the shipped
// bundle in `ui/src/test/screen/xterm-semantics.screen.test.ts`: it empties the
// buffer, collapses the scrollback to `baseY === 0`, and emits `onScroll`
// **synchronously** on the way out. A bare `vi.fn()` modelled none of that, which
// left issue #602 — that synchronous scroll being charged to an open IME
// composition anchor — inexpressible at this tier. ADR-0074 keeps byte→cell claims
// in the screen suite and leaves this component-level reproduction here.
//
// Only an `open()`ed terminal gets the buffer/scroll effects. The rendererless
// checkpoint mirror (`TerminalRenderCheckpointModel`, ADR-0069) resets its own
// instance on every attach, and in production that instance owns a private buffer
// with no viewport listeners. Here every mock instance shares `mockBufferActive`
// and the one `capturedScrollHandler`, so without this gate the mirror's reset
// would fire the visible pane's scroll handler. Gate arming stays ungated — it
// only tracks that an attach reset has happened at all.
const mockReset = vi.fn((terminal?: { wasOpened?: boolean }) => {
  streamAttachResetSeen = true;
  resolveStreamAttachReset?.();
  if (!terminal?.wasOpened) return;
  mockBufferActive.cursorX = 0;
  mockBufferActive.cursorY = 0;
  mockBufferActive.baseY = 0;
  mockBufferActive.viewportY = 0;
  mockBufferActive.length = 1;
  capturedScrollHandler?.();
});
// Captured before any test installs fake timers, so the bail-out below still
// measures wall clock while `vi.useFakeTimers()` is active.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realClearTimeout = globalThis.clearTimeout.bind(globalThis);
// Stops a handler from hanging forever when the attach chain cannot advance at
// all (a hung/failed attach fixture, or fake timers holding it). The handler then
// runs ungated — but that is a fixture bug, not a supported mode: every bail is
// recorded below and the `afterEach` fails the test that bailed. There is no
// silent path through this timeout.
const STREAM_ATTACH_RESET_BAIL_MS = 1000;
/** Tests that ran a parser handler without an attach reset, named at gate entry. */
const streamAttachResetBails: string[] = [];
function currentTestNameForBail(): string {
  try {
    return expect.getState().currentTestName ?? "(unknown test)";
  } catch {
    return "(unknown test)";
  }
}
async function waitForStreamAttachReset(): Promise<void> {
  if (streamAttachResetSeen) return;
  // Captured before the await, not after: a gated handler whose promise outlives
  // its test would otherwise be recorded under whichever test is running when the
  // bail resolves, and `afterEach` would fail an innocent test by that name.
  // A late bail still fails whichever test is running when it lands — vitest has no
  // way to fail an already-finished test after the fact. What this name buys is that
  // the message points at the culprit, which is what a human needs to fix it.
  const testAtGateEntry = currentTestNameForBail();
  let bail: ReturnType<typeof realSetTimeout> | undefined;
  try {
    await Promise.race([
      streamAttachResetArrived,
      new Promise<void>((resolve) => {
        bail = realSetTimeout(resolve, STREAM_ATTACH_RESET_BAIL_MS);
      }),
    ]);
  } finally {
    if (bail !== undefined) realClearTimeout(bail);
  }
  // Losing the race means this test ran a parser handler without an attach reset
  // ever landing, so it is back to the pre-gate ordering luck. Record it — the
  // value of the gate is determinism, and a silent bail restores exactly the
  // nondeterminism it exists to remove. `console.warn` alone does not work here:
  // this project's vitest run does not surface test-side console output at all
  // (verified), so the bail would stay invisible. The `afterEach` below turns it
  // into a failing assertion on the test that bailed instead. The handler itself
  // still runs, so the timeout never aborts a test mid-flight — it only reports.
  if (!streamAttachResetSeen) streamAttachResetBails.push(testAtGateEntry);
}
/** Registered parser handlers only run once the attach reset has landed. */
function gateOnStreamAttachReset<Args extends unknown[]>(
  callback: (...args: Args) => boolean | Promise<boolean>,
): (...args: Args) => Promise<boolean> {
  return async (...args: Args) => {
    await waitForStreamAttachReset();
    return callback(...args);
  };
}
// ───────────────────────────────────────────────────────────────────────────

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
    // The Unicode provider decides how many cells every printed code point
    // claims, so the registration order relative to open()/write() is part of
    // the contract — record it instead of just accepting the call.
    unicodeActivations: Array<{ version: string; opened: boolean; writeCallsBefore: number }> = [];
    unicode = {
      register: (provider: { version: string }) => {
        this.unicodeActivations.push({
          version: provider.version,
          opened: this.wasOpened,
          writeCallsBefore: mockWrite.mock.calls.length,
        });
        this.unicode.versions.push(provider.version);
      },
      versions: [] as string[],
      activeVersion: "6",
    };
    wasOpened = false;
    open = vi.fn(() => {
      this.wasOpened = true;
    });
    write = mockWrite;
    onData = mockOnData;
    onBinary = mockOnBinary;
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
    attachCustomWheelEventHandler = mockAttachCustomWheelEventHandler;
    input = mockTerminalInput;
    private readonly userInputListeners = new Set<() => void>();
    _core = {
      // ADR-0188 point 트리거는 xterm 코어의 좌표 변환을 쓴다. 셀 폭 10px,
      // 셀 높이 20px 로 두어 clientX/clientY 를 1-based 셀로 옮긴다.
      _mouseService: {
        getCoords: (event: MouseEvent): [number, number] => [
          Math.floor(event.clientX / 10) + 1,
          Math.floor(event.clientY / 20) + 1,
        ],
      },
      screenElement: null,
      coreMouseService: {
        consumeWheelEvent: mockConsumeWheelEvent,
      },
      _renderService: {
        dimensions: { device: { cell: { height: 20 } } },
      },
      _coreBrowserService: { dpr: 1 },
      coreService: {
        // The field both renderers gate the cursor on. Real xterm owns it and
        // DECTCEM writes it; issue #598 suppresses through it, so the mock must
        // carry it or the suppression path silently reports unsupported.
        isCursorHidden: false,
        onUserInput: (listener: () => void) => {
          this.userInputListeners.add(listener);
          return { dispose: () => this.userInputListeners.delete(listener) };
        },
      },
    };
    emitCoreData = (data: string, wasUserInput = false) => {
      // Mirrors the pinned xterm patch: disableStdin rejects human input but
      // still lets parser-generated protocol replies reach public onData.
      if (this.options.disableStdin && wasUserInput) return;
      if (wasUserInput) {
        for (const listener of this.userInputListeners) listener();
      }
      const handler = mockOnData.mock.calls.at(-1)?.[0] as ((value: string) => void) | undefined;
      handler?.(data);
    };
    emitBinary = (data: string) => {
      // xterm's CoreService applies disableStdin to every binary event. Binary
      // reports are human mouse input, never parser-generated replies.
      if (this.options.disableStdin) return;
      const handler = mockOnBinary.mock.calls.at(-1)?.[0] as ((value: string) => void) | undefined;
      handler?.(data);
    };
    focus = mockFocus;
    blur = mockBlur;
    paste = mockPaste;
    hasSelection = mockHasSelection;
    getSelection = mockGetSelection;
    getSelectionPosition = mockGetSelectionPosition;
    clearSelection = mockClearSelection;
    registerMarker = vi.fn(() => ({ dispose: vi.fn() }));
    // The path-link hit test reads the decoration's real rect and requires the
    // element to be connected, so the mock attaches it and derives the rect from
    // the cell geometry the mock `_mouseService` uses (10px x 20px cells).
    registerDecoration = vi.fn((options?: { x?: number; width?: number }) => {
      const element = document.createElement("div");
      const x = options?.x ?? 0;
      const width = options?.width ?? 1;
      element.getBoundingClientRect = () =>
        ({
          x: x * 10,
          y: 0,
          left: x * 10,
          right: (x + width) * 10,
          top: 0,
          bottom: 20,
          width: width * 10,
          height: 20,
          toJSON: () => ({}),
        }) as DOMRect;
      document.body.appendChild(element);
      const decoration = {
        element,
        onRender: vi.fn(),
        dispose: vi.fn(() => element.remove()),
      };
      mockPathLinkDecorations.push(decoration);
      return decoration;
    });
    refresh = mockRefresh;
    // Passes itself so a test can tell *which* terminals were cleared, not just
    // how many calls happened (issue #571).
    clearTextureAtlas = () => mockClearTextureAtlas(this);
    // Passes itself so the real `reset()` semantics only apply to the pane's own
    // opened terminal, not to the rendererless checkpoint mirror (issue #602).
    reset = () => mockReset(this);
    dispose = vi.fn();
    loadAddon = vi.fn();
    registerLinkProvider = vi.fn().mockReturnValue({ dispose: vi.fn() });
    element = document.createElement("div");
    buffer = { active: mockBufferActive, normal: mockBufferActive };
    modes = mockModes;
    parser = {
      registerOscHandler: mockRegisterOscHandler.mockImplementation(
        (ident: number, callback: (data: string) => boolean | Promise<boolean>) => {
          oscHandlers.set(String(ident), gateOnStreamAttachReset(callback));
          return { dispose: vi.fn() };
        },
      ),
      registerEscHandler: mockRegisterEscHandler.mockImplementation(
        (id: { final: string }, callback: () => boolean | Promise<boolean>) => {
          escHandlers.set(id.final, gateOnStreamAttachReset(callback));
          return { dispose: vi.fn() };
        },
      ),
      registerCsiHandler: mockRegisterCsiHandler.mockImplementation(
        (
          id: { prefix?: string; final: string },
          callback: (params: readonly (number | number[])[]) => boolean | Promise<boolean>,
        ) => {
          csiHandlers.set(`${id.prefix ?? ""}:${id.final}`, gateOnStreamAttachReset(callback));
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
vi.mock("@/lib/indented-link-provider", async () => ({
  // provider 생성만 가로채고 나머지(readIndentedLine 등)는 실물을 쓴다.
  ...(await vi.importActual<typeof import("@/lib/indented-link-provider")>(
    "@/lib/indented-link-provider",
  )),
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
const mockRegisterTerminalRenderCheckpointProvider = vi.fn();
const mockUnregisterTerminalRenderCheckpointProvider = vi.fn();
const mockRegisterTerminalInspector = vi.fn();
const mockUnregisterTerminalInspector = vi.fn();
const mockRegisterTerminalScroller = vi.fn();
const mockUnregisterTerminalScroller = vi.fn();
const mockTerminalRenderCheckpointApply = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/terminal-serialize-registry", () => ({
  registerTerminalSerializer: (...args: unknown[]) => mockRegisterTerminalSerializer(...args),
  unregisterTerminalSerializer: (...args: unknown[]) => mockUnregisterTerminalSerializer(...args),
  registerTerminalRenderCheckpointProvider: (...args: unknown[]) =>
    mockRegisterTerminalRenderCheckpointProvider(...args),
  unregisterTerminalRenderCheckpointProvider: (...args: unknown[]) =>
    mockUnregisterTerminalRenderCheckpointProvider(...args),
  registerTerminalInspector: (...args: unknown[]) => mockRegisterTerminalInspector(...args),
  unregisterTerminalInspector: (...args: unknown[]) => mockUnregisterTerminalInspector(...args),
  registerTerminalScroller: (...args: unknown[]) => mockRegisterTerminalScroller(...args),
  unregisterTerminalScroller: (...args: unknown[]) => mockUnregisterTerminalScroller(...args),
}));

vi.mock("@/lib/terminal-render-checkpoint", () => ({
  TerminalRenderCheckpointModel: class MockTerminalRenderCheckpointModel {
    attach = vi.fn().mockResolvedValue(undefined);
    apply = (...args: unknown[]) => mockTerminalRenderCheckpointApply(...args);
    capture = vi.fn().mockResolvedValue({
      generation: 1,
      seq: 0,
      geometry: { revision: 0, cols: 80, rows: 24 },
      data: "",
    });
    dispose = vi.fn();
  },
}));

// Mock tauri API
const mockCreateTerminalSession = vi.fn().mockResolvedValue({
  id: "t1",
  title: "Terminal",
  initialExecutionHost: "unknown",
  config: {
    profile: "PowerShell",
    cols: 80,
    rows: 24,
    sync_group: "",
    env: [],
    advertise_true_color: true,
  },
});
const mockWriteToTerminal = vi.fn().mockResolvedValue(undefined);
const mockWriteTerminalBinaryInput = vi.fn().mockResolvedValue(undefined);
const mockWriteTerminalBootstrapProtocolReply = vi.fn().mockResolvedValue(false);
const mockWriteTerminalProtocolReply = vi.fn().mockResolvedValue(undefined);
const mockWriteTerminalInput = vi.fn().mockResolvedValue(undefined);
const mockResizeTerminal = vi.fn().mockResolvedValue(undefined);
const mockCloseTerminalSession = vi.fn().mockResolvedValue(undefined);
const mockOnTerminalOutput = vi.fn().mockResolvedValue(vi.fn());
const mockOnTerminalOutputV3 = vi.fn().mockResolvedValue(vi.fn());
const mockAttachTerminalOutput = vi.fn().mockResolvedValue({
  state: {
    version: 1,
    generation: 1,
    snapshotStartSeq: 0,
    snapshotSeq: 0,
    sourceStartSeq: 0,
    sourceSeq: 0,
    snapshotKind: "raw",
    protocolRevision: 0,
    modes: { bracketedPaste: false },
    geometry: { revision: 0, cols: 80, rows: 24 },
  },
  snapshot: [],
  flowControl: { token: "lease-1", windowBytes: 524288 },
});
const mockAcknowledgeTerminalOutput = vi.fn().mockResolvedValue(true);
const mockAcknowledgeTerminalOutputEnvelope = vi.fn().mockResolvedValue(true);
const mockRepairTerminalOutputEnvelope = vi
  .fn()
  .mockResolvedValue({ status: "idle", envelope: null });
const mockHoldTerminalOutputContinuation = vi.fn().mockResolvedValue(true);
const mockCloseTerminalOutputContinuation = vi.fn().mockResolvedValue(true);
const mockFailStopTerminalOutputSurface = vi.fn().mockResolvedValue(true);
const mockResumeTerminalOutput = vi.fn().mockResolvedValue(null);
let capturedTerminalOutputFailStopped:
  | ((failure: {
      terminalId: string;
      generation: number;
      leaseToken: string | null;
      reason: string;
    }) => void)
  | null = null;
const mockOnTerminalOutputFailStopped = vi.fn(
  (callback: NonNullable<typeof capturedTerminalOutputFailStopped>) => {
    capturedTerminalOutputFailStopped = callback;
    return Promise.resolve(vi.fn());
  },
);
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
const mockStatPaths = vi.fn().mockResolvedValue([]);
const mockMarkClaudeTerminal = vi.fn().mockResolvedValue(true);
const mockMarkCodexTerminal = vi.fn().mockResolvedValue(true);
const mockLoadTerminalOutputCache = vi
  .fn()
  .mockRejectedValue(new Error("Cache not found: /fake/path.dat"));

vi.mock("@/lib/tauri-api", () => ({
  createTerminalSession: (...args: unknown[]) => mockCreateTerminalSession(...args),
  writeToTerminal: (...args: unknown[]) => mockWriteToTerminal(...args),
  writeTerminalBinaryInput: (...args: unknown[]) => mockWriteTerminalBinaryInput(...args),
  writeTerminalBootstrapProtocolReply: (...args: unknown[]) =>
    mockWriteTerminalBootstrapProtocolReply(...args),
  writeTerminalProtocolReply: (...args: unknown[]) => mockWriteTerminalProtocolReply(...args),
  writeTerminalInput: (...args: unknown[]) => mockWriteTerminalInput(...args),
  resizeTerminal: (...args: unknown[]) => mockResizeTerminal(...args),
  closeTerminalSession: (...args: unknown[]) => mockCloseTerminalSession(...args),
  attachTerminalOutput: (...args: unknown[]) => mockAttachTerminalOutput(...args),
  acknowledgeTerminalOutput: (...args: unknown[]) => mockAcknowledgeTerminalOutput(...args),
  acknowledgeTerminalOutputEnvelope: (...args: unknown[]) =>
    mockAcknowledgeTerminalOutputEnvelope(...args),
  repairTerminalOutputEnvelope: (...args: unknown[]) => mockRepairTerminalOutputEnvelope(...args),
  holdTerminalOutputContinuation: (...args: unknown[]) =>
    mockHoldTerminalOutputContinuation(...args),
  closeTerminalOutputContinuation: (...args: unknown[]) =>
    mockCloseTerminalOutputContinuation(...args),
  failStopTerminalOutputSurface: (...args: unknown[]) => mockFailStopTerminalOutputSurface(...args),
  resumeTerminalOutput: (...args: unknown[]) => mockResumeTerminalOutput(...args),
  onTerminalOutputV2: (terminalId: string, callback: (payload: unknown) => void) => {
    const forward = (data: Uint8Array | Record<string, unknown>) => {
      if ("seqStart" in data) {
        callback(data);
        return;
      }
      const raw = new Uint8Array(data as Uint8Array);
      const seqStart = mockOutputSequence;
      mockOutputSequence += raw.length;
      callback({
        generation: 1,
        seqStart,
        seqEnd: mockOutputSequence,
        data: Array.from(raw),
        geometry: { revision: 0, cols: 80, rows: 24 },
      });
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
  onTerminalOutputV3: (terminalId: string, callback: (payload: unknown) => void) => {
    void mockOnTerminalOutputV3(terminalId, callback);
    return Promise.resolve(vi.fn());
  },
  onTerminalOutputFailStopped: (...args: unknown[]) => mockOnTerminalOutputFailStopped(...args),
  normalizeTerminalOutputSurfaceFailStopReason: (reason: string) =>
    reason === "control_orphan_cap" || reason.endsWith(":control_orphan_cap")
      ? "control_orphan_cap"
      : "surface_unavailable",
  getRemoteControlStatus: (...args: unknown[]) => mockGetRemoteControlStatus(...args),
  onRemoteControlChanged: (...args: unknown[]) => mockOnRemoteControlChanged(...args),
  smartPaste: (...args: unknown[]) => mockSmartPaste(...args),
  clipboardWriteText: (...args: unknown[]) => mockClipboardWriteText(...args),
  setTerminalCwdSend: (...args: unknown[]) => mockSetTerminalCwdSend(...args),
  setTerminalCwdReceive: (...args: unknown[]) => mockSetTerminalCwdReceive(...args),
  updateTerminalSyncGroup: vi.fn().mockResolvedValue(undefined),
  openExternal: (...args: unknown[]) => mockOpenExternal(...args),
  statPaths: (...args: unknown[]) => mockStatPaths(...args),
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
  // "Ready" includes the attach reset that rebuilds stream-derived cursor state
  // (issue #603) — see the stream attach reset gate above.
  await waitForStreamAttachReset();
}

async function waitForLocalTerminalControl(): Promise<void> {
  await vi.waitFor(() => {
    expect(mockGetRemoteControlStatus).toHaveBeenCalled();
  });
  await act(async () => {
    await Promise.resolve();
  });
}

async function waitForTerminalRendererOpen(): Promise<void> {
  await vi.waitFor(() => {
    expect(mockCreateTerminalSession).toHaveBeenCalled();
    expect(createdTerminals.at(-1)?.wasOpened).toBe(true);
  });
}

// File level, not per-`describe`: `streamAttachResetSeen` is module-global, so a
// `describe` without this arming inherits an already-open gate from whichever
// test ran last and the ordering rule silently stops applying there. Every
// `describe` in this file must get the gate, including ones added later.
beforeEach(() => {
  setTerminalOutputV3RuntimeLoaderForTest();
  terminalOutputControlOperationRegistry.resetForTests();
  resetTerminalOutputV3DiagnosticsForTest();
  resetTerminalInputDeliveryCounters();
  armStreamAttachResetGate();
  streamAttachResetBails.length = 0;
  // Production exact-resume returns an empty delta while idle, never `null`.
  // Keep the low-frequency parsed-credit watchdog a no-op unless a test
  // explicitly models ring eviction or undelivered bytes.
  mockResumeTerminalOutput.mockReset();
  mockResumeTerminalOutput.mockImplementation((_id: string, generation: number, seq: number) =>
    Promise.resolve({
      generation,
      seqStart: seq,
      seqEnd: seq,
      data: [],
      geometry: { revision: 0, cols: 80, rows: 24 },
    }),
  );
  mockRepairTerminalOutputEnvelope.mockReset();
  mockRepairTerminalOutputEnvelope.mockResolvedValue({ status: "idle", envelope: null });
  mockFailStopTerminalOutputSurface.mockReset();
  mockFailStopTerminalOutputSurface.mockResolvedValue(true);
});

// A bailed gate is a fixture bug, not a passing test: the handler ran on ordering
// luck. Reported here so the bailing test names itself.
afterEach(async () => {
  cleanup();
  await act(async () => {
    await Promise.resolve();
  });
  const fairSchedulerWasIdle = terminalWriteFairScheduler.isIdleForTests();
  // Reset after capturing the invariant so a fixture leak is attributed to the
  // test that created it rather than cascading through every later test.
  terminalWriteFairScheduler.resetForTests();
  expect(streamAttachResetBails).toEqual([]);
  expect(fairSchedulerWasIdle).toBe(true);
});

describe("TerminalView", () => {
  beforeEach(() => {
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useTerminalStartupStore.setState(useTerminalStartupStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useOverridesStore.setState({ paneOverrides: {}, viewOverrides: {} });
    useNotificationStore.setState({ notifications: [] });
    localStorage.clear();
    clearRuntimeComposerState();
    capturedKeyHandler = null;
    capturedWheelHandler = null;
    capturedLinkHandler = null;
    capturedIndentedLinkHandler = null;
    createdTerminals.length = 0;
    // Module-global like the stores above: terminals mounted by earlier tests
    // would otherwise stay registered and fan a single atlas clear out to all
    // of them, against the one shared xterm mock (issue #571).
    __resetAtlasRebuildersForTest();
    webglInitTimes.length = 0;
    csiHandlers.clear();
    oscHandlers.clear();
    escHandlers.clear();
    mockModes.synchronizedOutputMode = false;
    mockPathLinkDecorations.length = 0;
    capturedRemoteControlChanged = null;
    capturedTerminalOutputFailStopped = null;
    mockOutputSequence = 0;
    capturedResizeHandler = null;
    capturedScrollHandler = null;
    mockBufferActive.cursorX = 0;
    mockBufferActive.cursorY = 0;
    mockBufferActive.baseY = 0;
    mockBufferActive.viewportY = 0;
    mockBufferActive.type = "normal";
    setMockBufferLine(null);
    mockGetRemoteControlStatus.mockResolvedValue({
      active: false,
      leaseId: null,
      remoteAddr: null,
      clientName: null,
      heartbeatTimeoutSeconds: 15,
    });
    _resetWebglStagger();
    vi.clearAllMocks();
    // clearAllMocks preserves implementations and queued one-shot behavior.
    // Restore the shared xterm write fixture explicitly so a callback-holding
    // test cannot strand the next test's app-global fair-scheduler lease.
    mockWrite.mockReset();
    mockWrite.mockImplementation(completeMockWrite);
    mockProposeDimensions.mockReturnValue({ cols: 80, rows: 24 });
  });

  it("renders terminal container", () => {
    render(<TerminalView instanceId="t1" profile="PowerShell" syncGroup="default" />);
    expect(screen.getByTestId("terminal-view-t1")).toBeInTheDocument();
  });

  // Harness self-check for the stream attach reset gate (issue #603). Every test
  // that drives `csiHandlers` / `oscHandlers` / `escHandlers` leans on it, so it
  // is asserted here instead of trusting that the event-loop order works out.
  it("holds parser handlers until the stream attach reset lands", async () => {
    const attachPayload = await mockAttachTerminalOutput();
    mockAttachTerminalOutput.mockClear();
    let releaseAttach = () => {};
    const attachHeld = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });
    mockAttachTerminalOutput.mockImplementationOnce(async () => {
      await attachHeld;
      return attachPayload;
    });

    render(<TerminalView instanceId="t-attach-gate" profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => {
      expect(mockAttachTerminalOutput).toHaveBeenCalled();
      expect(csiHandlers.get("?:h")).toBeTypeOf("function");
    });
    // Attach is parked, so the only `terminal.reset()` call site cannot have run.
    expect(mockReset).not.toHaveBeenCalled();

    // Control: the raw parser callback the gate wraps still runs straight away.
    // This is what every handler-driving test used to get, and why their shadow
    // state survived only when the reset happened to land first.
    const rawShow = mockRegisterCsiHandler.mock.calls.find(
      (call) =>
        (call[0] as { prefix?: string; final: string }).prefix === "?" &&
        (call[0] as { prefix?: string; final: string }).final === "h",
    )?.[1] as ((params: readonly number[]) => boolean | Promise<boolean>) | undefined;
    expect(rawShow).toBeTypeOf("function");
    let rawRan = false;
    await act(async () => {
      await rawShow?.([2026]);
      rawRan = true;
    });
    expect(rawRan).toBe(true);
    expect(mockReset).not.toHaveBeenCalled();

    // Gated: the same callback, reached the way tests reach it, blocks on the
    // reset itself — not on a guessed number of event-loop turns.
    let gatedRan = false;
    const gated = (async () => {
      await csiHandlers.get("?:h")?.([2026]);
      gatedRan = true;
    })();
    for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(gatedRan).toBe(false);
    expect(mockReset).not.toHaveBeenCalled();

    releaseAttach();
    await act(async () => {
      await gated;
    });
    expect(gatedRan).toBe(true);
    expect(mockReset).toHaveBeenCalled();
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

  it("activates the shared Unicode cell-width provider before open and any write", () => {
    render(<TerminalView instanceId="t-unicode-provider" profile="PowerShell" syncGroup="" />);

    expect(createdTerminals).toHaveLength(1);
    const terminal = createdTerminals[0] as unknown as {
      options: Record<string, unknown>;
      unicode: { activeVersion: string; versions: string[] };
      unicodeActivations: Array<{ version: string; opened: boolean; writeCallsBefore: number }>;
    };
    // terminal.unicode is proposed API — without this option xterm throws.
    expect(terminal.options.allowProposedApi).toBe(true);
    expect(terminal.unicodeActivations).toEqual([
      { version: LAYMUX_UNICODE_VERSION, opened: false, writeCallsBefore: 0 },
    ]);
    expect(terminal.unicode.activeVersion).toBe(LAYMUX_UNICODE_VERSION);
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

    await waitForTerminalRendererOpen();

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
    // The native cursor is off at the renderer gate, not by borrowing a shape or
    // a colour the application can overwrite (issue #598).
    await vi.waitFor(() => {
      expect(createdTerminals[0]._core.coreService.isCursorHidden).toBe(true);
    });
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
    await vi.waitFor(() => {
      expect(createdTerminals[0]._core.coreService.isCursorHidden).toBe(false);
    });
  });

  it("never disguises the native cursor as the theme background", async () => {
    // Issue #598. The disguise only worked while the cell under the cursor still
    // had the theme background; a TUI painting SGR 48 turned it into a dark
    // block instead. The theme must stay the user's in every cursor mode.
    render(<TerminalView instanceId="t-598-theme" profile="PowerShell" syncGroup="" />);

    const themeOf = () => createdTerminals[0].options.theme as Record<string, string>;
    const baseCursor = themeOf().cursor;
    const background = themeOf().background;
    expect(baseCursor).not.toBe(background);

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-598-theme", {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });

    await vi.waitFor(() => {
      expect(createdTerminals[0]._core.coreService.isCursorHidden).toBe(true);
    });
    expect(themeOf().cursor).toBe(baseCursor);
    expect(themeOf().cursorAccent).not.toBe(themeOf().cursor);
    // Shape stays the user's too — the app owns it via DECSCUSR regardless.
    expect(createdTerminals[0].options.cursorStyle).toBe("bar");
  });

  it("keeps the application's DECTCEM hide when suppression is released", async () => {
    // ADR-0011 makes the app's DECTCEM the authoritative visible-cursor signal.
    // Suppression records app writes instead of overwriting them, so releasing it
    // must not turn an app-requested hide into a show.
    render(<TerminalView instanceId="t-598-dectcem" profile="PowerShell" syncGroup="" />);

    const coreService = () => createdTerminals[0]._core.coreService;
    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-598-dectcem", {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });
    await vi.waitFor(() => {
      expect(coreService().isCursorHidden).toBe(true);
    });

    // The application hides its own cursor while we are suppressing.
    act(() => {
      coreService().isCursorHidden = true;
    });

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-598-dectcem", {
        activity: { type: "interactiveApp", name: "Claude" },
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(coreService().isCursorHidden).toBe(true);
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

    // The attach reset empties the buffer (issue #602), so buffer state seeded
    // before it lands would be wiped — the same ordering rule the parser-handler
    // gate enforces for stream-derived state (issue #603).
    await waitForStreamAttachReset();
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

    // See above: buffer state has to be seeded after the attach reset.
    await waitForStreamAttachReset();
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

  it("hides the Codex overlay caret while the viewport is scrolled up", async () => {
    render(
      <TerminalView instanceId="t-shadow-scroll" profile="PowerShell" syncGroup="" isFocused />,
    );

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-shadow-scroll", {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });

    const container = screen.getByTestId("terminal-view-t-shadow-scroll");
    const overlay = screen.getByTestId("terminal-overlay-caret-t-shadow-scroll");
    const terminal = createdTerminals[0] as unknown as {
      element: HTMLDivElement;
      buffer: {
        active: {
          cursorX: number;
          cursorY: number;
          baseY: number;
          viewportY: number;
        };
      };
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

    // See above: buffer state has to be seeded after the attach reset.
    await waitForStreamAttachReset();
    terminal.buffer.active.baseY = 100;
    terminal.buffer.active.viewportY = 100;
    terminal.buffer.active.cursorX = 2;
    terminal.buffer.active.cursorY = 4;

    await vi.waitFor(() => {
      expect(capturedScrollHandler).not.toBeNull();
    });
    await act(async () => {
      // Codex does not emit OSC 133. Seed the shadow cursor through its real
      // DEC 2026 frame + out-of-frame DECTCEM cursor-park sequence.
      await csiHandlers.get("?:h")?.([2026]);
      await csiHandlers.get("?:l")?.([2026]);
      await csiHandlers.get("?:l")?.([25]);
      await csiHandlers.get("?:h")?.([25]);
    });
    await vi.waitFor(() => {
      expect(overlay.style.opacity).toBe("1");
    });

    // A new footer frame has flushed, but its authoritative cursor park has
    // not arrived yet. Scrolling must still hide the previously painted caret
    // immediately instead of letting parkPending freeze it in place.
    await act(async () => {
      await csiHandlers.get("?:h")?.([2026]);
      terminal.buffer.active.cursorX = 20;
      terminal.buffer.active.cursorY = 20;
      await csiHandlers.get("?:l")?.([2026]);
    });
    terminal.buffer.active.viewportY = 80;
    await act(async () => {
      capturedScrollHandler?.();
      const overlayFrame = mockRequestAnimationFrame.mock.calls.at(-1)?.[0] as
        | FrameRequestCallback
        | undefined;
      overlayFrame?.(performance.now());
    });
    expect(overlay.style.opacity).toBe("0");

    await act(async () => {
      // Settle the frame while still viewing scrollback. The trusted shadow
      // position may update, but it must remain hidden until live-bottom.
      await csiHandlers.get("?:l")?.([25]);
      terminal.buffer.active.cursorX = 2;
      terminal.buffer.active.cursorY = 4;
      await csiHandlers.get("?:h")?.([25]);
    });

    terminal.buffer.active.viewportY = 100;
    await act(async () => {
      capturedScrollHandler?.();
    });
    await vi.waitFor(() => {
      expect(overlay.style.opacity).toBe("1");
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

    await waitForTerminalRendererOpen();

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

  it("renders the IME composition preview in a non-Codex pane", async () => {
    // Issue #551: the overlay gate required Codex activity, so a bare shell (and
    // every non-Codex TUI) painted nothing for in-flight composition — no glyph and
    // no underline, because xterm's own composition view is hidden unconditionally
    // in index.css. Same driving sequence as the Codex tests, shell activity only.
    render(<TerminalView instanceId="t-ime-shell" profile="PowerShell" syncGroup="" isFocused />);

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-ime-shell", {
        activity: { type: "shell" },
      });
    });

    const container = screen.getByTestId("terminal-view-t-ime-shell");
    const preview = screen.getByTestId("terminal-composition-preview-t-ime-shell");
    const overlay = screen.getByTestId("terminal-overlay-caret-t-ime-shell");
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

    await waitForTerminalRendererOpen();

    terminal.buffer.active.baseY = 0;
    terminal.buffer.active.cursorX = 4;
    terminal.buffer.active.cursorY = 2;
    await act(async () => {
      await oscHandlers.get("133")?.("B");
    });

    // The reported case: two committed jamo plus one still composing.
    helper.value = "ㄱㄱ";
    helper.selectionStart = 2;
    helper.selectionEnd = 2;
    helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    helper.value = "ㄱㄱㄱ";
    helper.selectionStart = 3;
    helper.selectionEnd = 3;
    helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ㄱ" }));
    helper.dispatchEvent(new Event("input"));

    await vi.waitFor(() => {
      expect(preview.textContent).toBe("ㄱ");
      expect(preview.style.opacity).toBe("1");
      // The caret follows the preview here too: xterm's native cursor is hidden
      // while composing, so without this the pane would have no caret at all.
      expect(overlay.style.opacity).toBe("1");
    });
  });

  it("restores the native shell cursor before a fresh key after compositionend", async () => {
    render(<TerminalView instanceId="t-ime-handoff" profile="WSL" syncGroup="" isFocused />);

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-ime-handoff", {
        activity: { type: "shell" },
      });
    });

    const container = screen.getByTestId("terminal-view-t-ime-handoff");
    const terminal = createdTerminals[0] as unknown as {
      element: HTMLDivElement;
      buffer: { active: { cursorX: number; cursorY: number; baseY?: number } };
      _core: { coreService: { isCursorHidden: boolean } };
    };
    const screenEl = document.createElement("div");
    screenEl.className = "xterm-screen";
    const rect = () =>
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
    screenEl.getBoundingClientRect = rect;
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    terminal.element.appendChild(screenEl);
    terminal.element.appendChild(helper);
    container.getBoundingClientRect = rect;

    await waitForTerminalRendererOpen();

    terminal.buffer.active.cursorX = 4;
    terminal.buffer.active.cursorY = 2;
    helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    helper.value = "한";
    helper.selectionStart = 1;
    helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "한" }));
    helper.dispatchEvent(new Event("input"));

    await vi.waitFor(() => {
      expect(container).toHaveClass("terminal-ime-composition-active");
      expect(terminal._core.coreService.isCursorHidden).toBe(true);
    });

    helper.dispatchEvent(new CompositionEvent("compositionend", { data: "한" }));
    helper.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));

    // The deferred controller phase remains available for same-tick Korean
    // carry-over, but a real English key has already handed rendering back to
    // xterm. Otherwise the overlay stays on the finalized syllable while WSL
    // echoes the new key at the advancing buffer cursor.
    expect(container).not.toHaveClass("terminal-ime-composition-active");
    expect(terminal._core.coreService.isCursorHidden).toBe(false);
  });

  it("anchors the IME preview on the buffer cursor when the shadow cursor is not trusted", async () => {
    // Issue #551, measured on a real PowerShell pane: after `ls` the prompt emits
    // OSC 133 `D` but no `B`, so `isInputPhase` stays false, the shadow sync is
    // skipped ("inactive") and the shadow cursor sits a row behind the buffer.
    // Reading it unconditionally painted the preview on the previous row at column
    // 0 — off where the user types, which reads as "nothing appears".
    //
    // No OSC 133 `B` here, so `computeUseShadowCursor` is false and the live buffer
    // cursor must win.
    render(<TerminalView instanceId="t-ime-buf" profile="PowerShell" syncGroup="" isFocused />);

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-ime-buf", {
        activity: { type: "shell" },
      });
    });

    const container = screen.getByTestId("terminal-view-t-ime-buf");
    const preview = screen.getByTestId("terminal-composition-preview-t-ime-buf");
    const terminal = createdTerminals[0] as unknown as {
      element: HTMLDivElement;
      buffer: { active: { cursorX: number; cursorY: number; baseY?: number } };
    };
    const screenEl = document.createElement("div");
    screenEl.className = "xterm-screen";
    const rect = () =>
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
    screenEl.getBoundingClientRect = rect;
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    terminal.element.appendChild(screenEl);
    terminal.element.appendChild(helper);
    container.getBoundingClientRect = rect;

    await waitForTerminalRendererOpen();

    // The shadow cursor is left at its initial 0,0 — the stale state the trace
    // showed. The buffer cursor is where the user actually is.
    terminal.buffer.active.baseY = 0;
    terminal.buffer.active.cursorX = 5;
    terminal.buffer.active.cursorY = 3;

    helper.value = "";
    helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    helper.value = "ㄱ";
    helper.selectionStart = 1;
    helper.selectionEnd = 1;
    helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ㄱ" }));
    helper.dispatchEvent(new Event("input"));

    await vi.waitFor(() => {
      expect(preview.textContent).toBe("ㄱ");
      // 80x24 over 800x480 → 10x20 px cells. Column 5, row 3 — not 0,0.
      expect(preview.style.transform).toBe("translate(50px, 60px)");
    });
  });

  it("places the IME preview correctly when the anchor sits on the right edge", async () => {
    // Issue #551, measured: xterm's pending-wrap cursor reports `cursorX === cols`
    // after a row is filled to its last column. The layout normalizes that into
    // `startColumn` + `rowOffset`, and each row is positioned relative to the *raw*
    // container origin by `row.startColumn - anchorX`. Normalizing the container too
    // double-counts the row offset and drops the preview a row below its own caret,
    // which the unit tests on the layout alone cannot see.
    render(<TerminalView instanceId="t-ime-edge" profile="PowerShell" syncGroup="" isFocused />);

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-ime-edge", {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });

    const container = screen.getByTestId("terminal-view-t-ime-edge");
    const preview = screen.getByTestId("terminal-composition-preview-t-ime-edge");
    const overlay = screen.getByTestId("terminal-overlay-caret-t-ime-edge");
    const terminal = createdTerminals[0] as unknown as {
      element: HTMLDivElement;
      buffer: { active: { cursorX: number; cursorY: number; baseY?: number } };
    };
    const rect = () =>
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
    const screenEl = document.createElement("div");
    screenEl.className = "xterm-screen";
    screenEl.getBoundingClientRect = rect;
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    terminal.element.appendChild(screenEl);
    terminal.element.appendChild(helper);
    container.getBoundingClientRect = rect;

    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
    });

    // 80x24 over 800x480 → 10x20 px cells. Column 80 is one past the last column.
    terminal.buffer.active.baseY = 0;
    terminal.buffer.active.cursorX = 80;
    terminal.buffer.active.cursorY = 4;
    await act(async () => {
      await oscHandlers.get("133")?.("B");
    });

    act(() => {
      helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      helper.value = "가";
      helper.selectionStart = 1;
      helper.selectionEnd = 1;
      helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "가" }));
      helper.dispatchEvent(new Event("input"));
    });

    await vi.waitFor(() => {
      const rows = preview.querySelectorAll(".terminal-composition-preview-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveTextContent("가");
      // Container and rows both come from the layout's normalized anchor, so the
      // container already sits on column 0 of row 5 and the row adds nothing. The
      // earlier form put the container on the raw column 80 and relied on the row to
      // translate back by -800px; deriving that normalization in the renderer as well
      // double-counted the row offset, which is what this test exists to pin.
      expect(preview.style.transform).toBe("translate(0px, 100px)");
      expect(rows[0]).toHaveStyle({ transform: "translate(0px, 0px)" });
      // The caret must land on the same row as the glyph it follows.
      expect(overlay.style.transform).toBe("translate(20px, 100px)");
    });
  });

  it("renders the IME composition preview in the alt buffer", async () => {
    // Issue #553: a fullscreen TUI drives its own cursor, so the alt buffer branch
    // stops laymux drawing a caret — but it also stopped the composition preview, and
    // xterm's own composition view is hidden unconditionally in index.css. In vim the
    // composing jamo was therefore invisible with no way to see it, before any
    // scrolling. Anchoring is simpler here than in the normal buffer: the alt buffer
    // has no scrollback, so `baseY` is 0 and the absolute-row conversion is identity.
    render(<TerminalView instanceId="t-ime-alt" profile="PowerShell" syncGroup="" isFocused />);

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-ime-alt", {
        activity: { type: "shell" },
      });
    });

    const container = screen.getByTestId("terminal-view-t-ime-alt");
    const preview = screen.getByTestId("terminal-composition-preview-t-ime-alt");
    const terminal = createdTerminals[0] as unknown as {
      element: HTMLDivElement;
      buffer: { active: { cursorX: number; cursorY: number; baseY?: number } };
    };
    const rect = () =>
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
    const screenEl = document.createElement("div");
    screenEl.className = "xterm-screen";
    screenEl.getBoundingClientRect = rect;
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    terminal.element.appendChild(screenEl);
    terminal.element.appendChild(helper);
    container.getBoundingClientRect = rect;

    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
    });

    // Enter the alt buffer the way a TUI does. Asserted rather than optional-chained so
    // a registration-key change names itself instead of surfacing as a wrong pixel.
    expect(csiHandlers.get("?:h")).toBeTypeOf("function");
    await act(async () => {
      await csiHandlers.get("?:h")?.([1049]);
    });

    terminal.buffer.active.baseY = 0;
    terminal.buffer.active.cursorX = 5;
    terminal.buffer.active.cursorY = 3;

    helper.value = "";
    helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    helper.value = "ㄱ";
    helper.selectionStart = 1;
    helper.selectionEnd = 1;
    helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ㄱ" }));
    helper.dispatchEvent(new Event("input"));

    await vi.waitFor(() => {
      expect(preview.textContent).toBe("ㄱ");
      // 80x24 over 800x480 → 10x20 px cells. Column 5, row 3 — the live buffer cursor,
      // which is where vim put it.
      expect(preview.style.transform).toBe("translate(50px, 60px)");
    });
  });
  it("anchors the alt-buffer preview on the buffer cursor even with a sync frame", async () => {
    // Issue #553 review: `baseY === 0` only makes the row conversion the identity, it
    // does not decide *which* cursor is read. A fullscreen TUI that emits DEC 2026
    // sets `hasSyncFramePosition`, so `computeUseShadowCursor` is true — while
    // `getShadowSyncEligibility` returns "alt-buffer" and skips the sync outright.
    // Anchoring on a value the shadow machine stopped maintaining is incoherent, so
    // the alt buffer makes the buffer cursor authoritative unconditionally. vim only
    // escaped this by emitting neither OSC 133 nor DEC 2026 — a property of vim.
    render(
      <TerminalView instanceId="t-ime-alt-sync" profile="PowerShell" syncGroup="" isFocused />,
    );

    const container = screen.getByTestId("terminal-view-t-ime-alt-sync");
    const preview = screen.getByTestId("terminal-composition-preview-t-ime-alt-sync");
    const terminal = createdTerminals[0] as unknown as {
      element: HTMLDivElement;
      buffer: { active: { cursorX: number; cursorY: number; baseY?: number } };
    };
    const rect = () =>
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
    const screenEl = document.createElement("div");
    screenEl.className = "xterm-screen";
    screenEl.getBoundingClientRect = rect;
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    terminal.element.appendChild(screenEl);
    terminal.element.appendChild(helper);
    container.getBoundingClientRect = rect;

    await vi.waitFor(() => {
      expect(mockCreateTerminalSession).toHaveBeenCalled();
    });

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-ime-alt-sync", {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });

    expect(csiHandlers.get("?:h")).toBeTypeOf("function");
    expect(csiHandlers.get("?:l")).toBeTypeOf("function");

    // Order matters: entering the alt buffer resets `hasSyncFramePosition`, so the
    // frame has to come *after* the switch — which is also what a real fullscreen TUI
    // does, alt buffer first and then render frames.
    terminal.buffer.active.baseY = 0;
    await act(async () => {
      await csiHandlers.get("?:h")?.([1049]);
    });

    // A DEC 2026 frame inside the alt buffer captures a shadow position, then the TUI
    // parks its cursor somewhere else while rendering.
    terminal.buffer.active.cursorX = 10;
    terminal.buffer.active.cursorY = 5;
    await act(async () => {
      await csiHandlers.get("?:h")?.([2026]);
    });
    terminal.buffer.active.cursorX = 40;
    terminal.buffer.active.cursorY = 20;
    await act(async () => {
      await csiHandlers.get("?:l")?.([2026]);
    });

    // The user types: the live buffer cursor is the only trustworthy position.
    terminal.buffer.active.cursorX = 5;
    terminal.buffer.active.cursorY = 3;

    helper.value = "";
    helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    helper.value = "ㄱ";
    helper.selectionStart = 1;
    helper.selectionEnd = 1;
    helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ㄱ" }));
    helper.dispatchEvent(new Event("input"));

    await vi.waitFor(() => {
      expect(preview.textContent).toBe("ㄱ");
      // Column 5, row 3 — the live buffer cursor. The captured shadow was (10, 5),
      // which would be translate(100px, 100px).
      expect(preview.style.transform).toBe("translate(50px, 60px)");
    });
  });

  it("hides the preview instead of mispainting it across a buffer switch", async () => {
    // Issue #553 review: the anchor captured in the normal buffer is an absolute row,
    // and the alt buffer resets `baseY` to 0, so the viewport row comes out past
    // `rows`. That reaches the viewport guard, which hides — it does not paint on the
    // wrong line. The next carry-over re-bases on the new buffer cursor, so the error
    // is one syllable of invisibility rather than a misplaced glyph.
    render(
      <TerminalView instanceId="t-ime-alt-switch" profile="PowerShell" syncGroup="" isFocused />,
    );

    const container = screen.getByTestId("terminal-view-t-ime-alt-switch");
    const preview = screen.getByTestId("terminal-composition-preview-t-ime-alt-switch");
    const terminal = createdTerminals[0] as unknown as {
      element: HTMLDivElement;
      buffer: { active: { cursorX: number; cursorY: number; baseY?: number } };
    };
    const rect = () =>
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
    const screenEl = document.createElement("div");
    screenEl.className = "xterm-screen";
    screenEl.getBoundingClientRect = rect;
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    terminal.element.appendChild(screenEl);
    terminal.element.appendChild(helper);
    container.getBoundingClientRect = rect;

    await waitForTerminalRendererOpen();

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-ime-alt-switch", {
        activity: { type: "shell" },
      });
    });

    // Compose in the normal buffer with scrollback above. `viewportY` matches `baseY`
    // so the viewport is at the live bottom — otherwise `isTerminalScrolledUp` hides the
    // preview for the unrelated scroll reason.
    (terminal.buffer.active as { viewportY?: number }).viewportY = 100;
    terminal.buffer.active.baseY = 100;
    terminal.buffer.active.cursorX = 5;
    terminal.buffer.active.cursorY = 20;
    helper.value = "";
    helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    helper.value = "ㄱ";
    helper.selectionStart = 1;
    helper.selectionEnd = 1;
    helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ㄱ" }));
    helper.dispatchEvent(new Event("input"));
    await vi.waitFor(() => {
      expect(preview.textContent).toBe("ㄱ");
    });

    // The TUI switches to the alt buffer: same absolute anchor, `baseY` now 0.
    expect(csiHandlers.get("?:h")).toBeTypeOf("function");
    await act(async () => {
      await csiHandlers.get("?:h")?.([1049]);
    });
    terminal.buffer.active.baseY = 0;
    await act(async () => {
      const frame = mockRequestAnimationFrame.mock.calls.at(-1)?.[0] as
        | FrameRequestCallback
        | undefined;
      frame?.(performance.now());
    });

    await vi.waitFor(() => {
      expect(preview.style.opacity).toBe("0");
    });
  });
  it("positions wrapped IME preview rows at the terminal left edge", async () => {
    render(<TerminalView instanceId="t-ime-wrap" profile="PowerShell" syncGroup="" isFocused />);

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-ime-wrap", {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });

    const container = screen.getByTestId("terminal-view-t-ime-wrap");
    const preview = screen.getByTestId("terminal-composition-preview-t-ime-wrap");
    const overlay = screen.getByTestId("terminal-overlay-caret-t-ime-wrap");
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
    terminal.buffer.active.cursorX = 78;
    terminal.buffer.active.cursorY = 4;
    await act(async () => {
      await oscHandlers.get("133")?.("B");
    });

    await act(async () => {
      helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      helper.value = "가나";
      helper.selectionStart = 2;
      helper.selectionEnd = 2;
      helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "가나" }));
      helper.dispatchEvent(new Event("input"));
    });

    await vi.waitFor(() => {
      const rows = preview.querySelectorAll(".terminal-composition-preview-row");
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent("가");
      expect(rows[0]).toHaveStyle({ transform: "translate(0px, 0px)" });
      expect(rows[1]).toHaveTextContent("나");
      expect(rows[1]).toHaveStyle({ transform: "translate(-780px, 20px)" });
      expect(overlay.style.transform).toBe("translate(20px, 100px)");
    });

    await act(async () => {
      helper.value = "가";
      helper.selectionStart = 1;
      helper.selectionEnd = 1;
      helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "가" }));
      helper.dispatchEvent(new Event("input"));
    });

    await vi.waitFor(() => {
      const rows = preview.querySelectorAll(".terminal-composition-preview-row");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toHaveTextContent("가");
      expect(rows[0]).toHaveStyle({ transform: "translate(0px, 0px)" });
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

    await waitForTerminalRendererOpen();

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

  // The class marks the DEC 2026 boundary and hides only the real helper
  // textarea caret. The painted cursor uses the raw renderer gate, which also
  // covers DOM focus/blur direct-render paths (issue #610, ADR-0079).
  it("marks the frame boundary on the host only while a synchronized output frame is open", async () => {
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

  it("rebuilds the shadow cursor when a sequence gap replaces the stream", async () => {
    // Issue #596: a sequence gap the ring can no longer bridge escalates to
    // `terminal.reset()` + a fresh snapshot (ADR-0072), which throws away the
    // bytes the pane's cursor beliefs were inferred from. If the frame that was
    // open when the gap hit never gets its `?2026l`, `isDec2026FrameOpen` stays
    // true forever: shadow syncs report `dec-2026-frame-open`, Codex's cursor
    // parks are demoted to visibility-only, and the overlay caret stays pinned
    // where the frame opened while the real cursor keeps advancing.
    //
    // This drives the *escalation* path deliberately: the trigger below is a
    // fully-formed delta (so it is a real sequence gap, not a validation
    // failure), and `resume` answers `null` so the ring cannot bridge it. The
    // repair path — where the reset must NOT happen — is the next test.
    mockResumeTerminalOutput.mockResolvedValue(null);
    localStorage.setItem("laymux:cursor-trace", "1");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const traces = (needle: string) =>
      logSpy.mock.calls.filter((call) => typeof call[0] === "string" && call[0].includes(needle));
    try {
      render(<TerminalView instanceId="t-gap-reattach" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockOnTerminalOutput).toHaveBeenCalled();
        expect(csiHandlers.get("?:h")).toBeTypeOf("function");
      });
      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array | Record<string, unknown>) => void)
        | undefined;
      expect(onOutput).toBeTypeOf("function");
      act(() => {
        useTerminalStore.getState().updateInstanceInfo("t-gap-reattach", {
          activity: { type: "interactiveApp", name: "Codex" },
        });
      });

      // A frame opens, and the gap swallows its `?2026l`.
      await act(async () => {
        await csiHandlers.get("?:h")?.([2026]);
      });
      await act(async () => {
        await csiHandlers.get("?:h")?.([25]);
      });
      expect(traces("dectcem-park")).toHaveLength(0);

      const resetsBefore = mockReset.mock.calls.length;
      mockResumeTerminalOutput.mockClear();
      act(() => {
        // seqStart far past what the coordinator expects, with valid generation
        // and geometry so the coordinator reports a sequence gap rather than
        // rejecting the payload — the exact shape a dropped delta event leaves.
        onOutput?.({
          generation: 1,
          seqStart: 4096,
          seqEnd: 4099,
          data: [0x61, 0x62, 0x63],
          geometry: { revision: 0, cols: 80, rows: 24 },
        });
      });
      // Proves the gap path ran: a validation failure would never ask the ring.
      await vi.waitFor(() => {
        expect(mockResumeTerminalOutput).toHaveBeenCalledWith("t-gap-reattach", 1, 0);
      });
      await vi.waitFor(() => {
        expect(mockReset.mock.calls.length).toBeGreaterThan(resetsBefore);
      });

      // The replacement stream owns the cursor beliefs now: the very next park
      // has to be recognized.
      await act(async () => {
        await csiHandlers.get("?:h")?.([25]);
      });
      expect(traces("dectcem-park").length).toBeGreaterThan(0);
    } finally {
      logSpy.mockRestore();
      localStorage.removeItem("laymux:cursor-trace");
    }
  });

  // ── issue #602: composition anchor across a stream rebuild ──────────────────
  // A rebuild is `terminal.reset()` plus the snapshot replay serialized behind
  // it. The reset emits `onScroll` synchronously with `baseY` already 0, and the
  // replay grows `baseY` back over many awaited writes. The scenarios below fix
  // that only the *net* scrollback shift may reach an open composition anchor:
  // charging the two halves separately parks the preview off the top of the
  // screen for the rest of the composition, because a Korean syllable commits
  // long before the replay finishes repaying the jump.
  describe("composition anchor across a stream rebuild (issue #602)", () => {
    const SCROLLBACK = 1000;
    /** The composing input line, as a viewport row. */
    const INPUT_ROW = 20;
    const INPUT_COL = 4;
    /** 800x480 over 80x24 cells => 10x20 per cell. */
    const anchorTransform = (screenRow: number) =>
      `translate(${INPUT_COL * 10}px, ${screenRow * 20}px)`;
    const REPLAY_MARKER = "rebuilt";
    // Ends past the escalating delta below, so the reattached coordinator does not
    // immediately report another gap and loop the pane through more rebuilds. The
    // range has to match the snapshot length exactly or the attachment is rejected.
    const REPLAY_END_SEQ = 8192;
    const rebuildAttachment = () => {
      const snapshot = Array.from(new TextEncoder().encode(REPLAY_MARKER));
      return {
        state: {
          version: 1,
          generation: 1,
          snapshotStartSeq: REPLAY_END_SEQ - snapshot.length,
          snapshotSeq: REPLAY_END_SEQ,
          sourceStartSeq: REPLAY_END_SEQ - snapshot.length,
          sourceSeq: REPLAY_END_SEQ,
          snapshotKind: "raw",
          protocolRevision: 0,
          modes: { bracketedPaste: false },
          geometry: { revision: 0, cols: 80, rows: 24 },
        },
        snapshot,
        flowControl: { token: "lease-rebuild", windowBytes: 524288 },
      };
    };

    /**
     * Drive one mid-composition rebuild and report what the anchor was charged.
     *
     * `restoredScrollback` is how tall the replayed snapshot leaves the
     * scrollback. The mocked `write` has no VT parser, so the replay's effect on
     * `baseY` is applied by the fixture — hooked on the snapshot write itself, so
     * it lands inside the rebuild window exactly where xterm's own scroll would.
     * That hook is also the only place the *intermediate* anchor state is
     * observable: React has not re-rendered yet, so the trace is read instead.
     */
    const runRebuild = async (
      terminalId: string,
      restoredScrollback: number,
    ): Promise<{
      deltasDuringRebuild: number[];
      deltasAfterRebuild: number[];
      transformBefore: string;
      transformAfter: string;
    }> => {
      mockResumeTerminalOutput.mockResolvedValue(null);
      localStorage.setItem("laymux:cursor-trace", "1");
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const anchorScrollDeltas = () =>
        logSpy.mock.calls
          .filter(
            (call) =>
              typeof call[0] === "string" && call[0].includes("ime-composition-anchor-scrolled"),
          )
          .map((call) => (call[1] as { rowDelta: number }).rowDelta);
      try {
        render(
          <TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" isFocused />,
        );
        act(() => {
          useTerminalStore.getState().updateInstanceInfo(terminalId, {
            activity: { type: "shell" },
          });
        });
        const container = screen.getByTestId(`terminal-view-${terminalId}`);
        const preview = screen.getByTestId(`terminal-composition-preview-${terminalId}`);
        const terminal = createdTerminals[0] as unknown as { element: HTMLDivElement };
        const rect = () =>
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
        const screenEl = document.createElement("div");
        screenEl.className = "xterm-screen";
        screenEl.getBoundingClientRect = rect;
        const helper = document.createElement("textarea");
        helper.className = "xterm-helper-textarea";
        terminal.element.append(screenEl, helper);
        container.getBoundingClientRect = rect;
        // The mount attach owns the first rebuild; the scrollback below has to be
        // seeded after its reset, not before.
        await waitForTerminalInputReady();
        const onOutput = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as
          | ((data: Uint8Array | Record<string, unknown>) => void)
          | undefined;
        expect(onOutput).toBeTypeOf("function");

        // Deep scrollback: the reset's `baseY → 0` is the whole defect, so it has
        // to be large enough that a mis-anchored preview is off-screen.
        mockBufferActive.baseY = SCROLLBACK;
        mockBufferActive.viewportY = SCROLLBACK;
        mockBufferActive.cursorX = INPUT_COL;
        mockBufferActive.cursorY = INPUT_ROW;
        act(() => {
          helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
          helper.value = "ㄱ";
          helper.selectionStart = 1;
          helper.selectionEnd = 1;
          helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ㄱ" }));
          helper.dispatchEvent(new Event("input"));
        });
        await vi.waitFor(() => expect(preview.textContent).toBe("ㄱ"));
        const transformBefore = preview.style.transform;

        let deltasDuringRebuild: number[] | undefined;
        const writeDefault = (data: string | Uint8Array, callback?: () => void) => {
          void data;
          callback?.();
        };
        mockAttachTerminalOutput.mockResolvedValueOnce(rebuildAttachment());
        mockWrite.mockImplementation((data: string | Uint8Array, callback?: () => void) => {
          const text = typeof data === "string" ? data : new TextDecoder().decode(data);
          if (deltasDuringRebuild === undefined && text.includes(REPLAY_MARKER)) {
            deltasDuringRebuild = anchorScrollDeltas();
            mockBufferActive.baseY = restoredScrollback;
            mockBufferActive.viewportY = restoredScrollback;
            mockBufferActive.cursorY = INPUT_ROW;
            capturedScrollHandler?.();
          }
          callback?.();
        });

        const resetsBefore = mockReset.mock.calls.length;
        act(() => {
          // A fully-formed delta far past the expected sequence: a real gap, and
          // `resume` answers `null` so the ring cannot bridge it — the escalation
          // that ends in a rebuild (ADR-0072).
          onOutput?.({
            generation: 1,
            seqStart: 4096,
            seqEnd: 4099,
            data: [0x61, 0x62, 0x63],
            geometry: { revision: 0, cols: 80, rows: 24 },
          });
        });
        await vi.waitFor(() => {
          expect(mockReset.mock.calls.length).toBeGreaterThan(resetsBefore);
        });
        await vi.waitFor(() => expect(deltasDuringRebuild).toBeDefined());
        // Let the anchor state the rebuild leaves behind reach the DOM.
        await act(async () => {
          await Promise.resolve();
        });
        mockWrite.mockImplementation(writeDefault);
        // The composition is still open — that is the point. A rebuild that hands
        // the anchor an intermediate row breaks the preview until it commits.
        expect(preview.textContent).toBe("ㄱ");
        return {
          deltasDuringRebuild: deltasDuringRebuild ?? [],
          deltasAfterRebuild: anchorScrollDeltas(),
          transformBefore,
          transformAfter: preview.style.transform,
        };
      } finally {
        logSpy.mockRestore();
        warnSpy.mockRestore();
        localStorage.removeItem("laymux:cursor-trace");
      }
    };

    it("hides the reset's scroll from the anchor when the replay restores the scrollback", async () => {
      const result = await runRebuild("t-ime-rebuild-even", SCROLLBACK);

      expect(result.transformBefore).toBe(anchorTransform(INPUT_ROW));
      // Nothing at all: the rebuild ends where it started, so there is no net.
      // Before the fix this read `[-1000]` — the reset's synchronous `onScroll`,
      // already charged by the time the replay began.
      expect(result.deltasDuringRebuild).toEqual([]);
      expect(result.deltasAfterRebuild).toEqual([]);
      expect(result.transformAfter).toBe(anchorTransform(INPUT_ROW));
    });

    it("charges only the net scrollback shift when the replay restores less", async () => {
      const restored = 400;
      const result = await runRebuild("t-ime-rebuild-shorter", restored);

      expect(result.transformBefore).toBe(anchorTransform(INPUT_ROW));
      expect(result.deltasDuringRebuild).toEqual([]);
      // One charge, once, and it is the shift that keeps the anchor on the screen
      // row the input line occupies — issue #570's rule applied to the rebuild as
      // a whole instead of to each of its halves.
      expect(result.deltasAfterRebuild).toEqual([restored - SCROLLBACK]);
      expect(result.transformAfter).toBe(anchorTransform(INPUT_ROW));
    });
  });

  it("carries an open composition anchor along with a live TUI scroll", async () => {
    // Issue #570 regression guard at the wiring level: the rebuild suppression
    // above must not swallow ordinary scrolls. A TUI that keeps its input box at
    // the bottom grows `baseY` as it prints, and a stationary anchor would drift
    // upward by exactly the rows emitted.
    localStorage.setItem("laymux:cursor-trace", "1");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const anchorScrollDeltas = () =>
      logSpy.mock.calls
        .filter(
          (call) =>
            typeof call[0] === "string" && call[0].includes("ime-composition-anchor-scrolled"),
        )
        .map((call) => (call[1] as { rowDelta: number }).rowDelta);
    try {
      render(
        <TerminalView instanceId="t-ime-tui-scroll" profile="PowerShell" syncGroup="" isFocused />,
      );
      act(() => {
        useTerminalStore.getState().updateInstanceInfo("t-ime-tui-scroll", {
          activity: { type: "shell" },
        });
      });
      const container = screen.getByTestId("terminal-view-t-ime-tui-scroll");
      const preview = screen.getByTestId("terminal-composition-preview-t-ime-tui-scroll");
      const terminal = createdTerminals[0] as unknown as { element: HTMLDivElement };
      const rect = () =>
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
      const screenEl = document.createElement("div");
      screenEl.className = "xterm-screen";
      screenEl.getBoundingClientRect = rect;
      const helper = document.createElement("textarea");
      helper.className = "xterm-helper-textarea";
      terminal.element.append(screenEl, helper);
      container.getBoundingClientRect = rect;
      await waitForTerminalInputReady();

      mockBufferActive.baseY = 100;
      mockBufferActive.viewportY = 100;
      mockBufferActive.cursorX = 4;
      mockBufferActive.cursorY = 20;
      act(() => {
        helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
        helper.value = "ㄱ";
        helper.selectionStart = 1;
        helper.selectionEnd = 1;
        helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ㄱ" }));
        helper.dispatchEvent(new Event("input"));
      });
      await vi.waitFor(() => expect(preview.textContent).toBe("ㄱ"));
      expect(preview.style.transform).toBe("translate(40px, 400px)");

      // Nine rows of agent output: the input box stays on its screen row.
      mockBufferActive.baseY = 109;
      mockBufferActive.viewportY = 109;
      await act(async () => {
        capturedScrollHandler?.();
      });

      expect(anchorScrollDeltas()).toEqual([9]);
      await vi.waitFor(() => expect(preview.style.transform).toBe("translate(40px, 400px)"));
    } finally {
      logSpy.mockRestore();
      localStorage.removeItem("laymux:cursor-trace");
    }
  });

  it("keeps the shadow cursor across a repaired sequence gap", async () => {
    // ADR-0072 vs issue #596: a repaired gap is the opposite case. The visible
    // buffer is untouched and the byte stream stays continuous, so every
    // stream-derived belief is still valid and rebuilding them would be wrong —
    // `cursorAbsY`, `commandStartLine` and the frame snapshot all still name
    // live rows, and `isDec2026FrameOpen` must stay open.
    //
    // What this test pins: the repair does not reset xterm, and the open-frame
    // latch survives it (a rebuild would clear the latch and promote the next
    // in-frame `?25h` to an authoritative park). That is the regression guard.
    //
    // What it does NOT pin: that the `?2026l` *inside the repair range* drives
    // the latch closed by being parsed. xterm is mocked here, so writes never
    // reach a parser and the handlers have to be invoked directly — asserting
    // "calling `?:l` closes the latch" would be a tautology, not the ADR claim.
    // The claim rests on the repair bytes going through `applyOutputSegments` →
    // `processLiveTerminalOutput`, the identical path a normal live delta takes.
    // Verifying it end-to-end needs a real xterm instance (issue #605).
    mockResumeTerminalOutput.mockResolvedValue(null);
    localStorage.setItem("laymux:cursor-trace", "1");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const traces = (needle: string) =>
      logSpy.mock.calls.filter((call) => typeof call[0] === "string" && call[0].includes(needle));
    try {
      render(<TerminalView instanceId="t-gap-repair-shadow" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockOnTerminalOutput).toHaveBeenCalled();
        expect(csiHandlers.get("?:h")).toBeTypeOf("function");
      });
      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array | Record<string, unknown>) => void)
        | undefined;
      expect(onOutput).toBeTypeOf("function");
      await waitForStreamAttachReset();
      act(() => {
        useTerminalStore.getState().updateInstanceInfo("t-gap-repair-shadow", {
          activity: { type: "interactiveApp", name: "Codex" },
        });
      });

      // A frame opens, and the gap swallows its `?2026l`.
      await act(async () => {
        await csiHandlers.get("?:h")?.([2026]);
      });
      await act(async () => {
        await csiHandlers.get("?:h")?.([25]);
      });
      expect(traces("dectcem-park")).toHaveLength(0);

      const resetsBefore = mockReset.mock.calls.length;
      const geometry = { revision: 0, cols: 80, rows: 24 };
      mockResumeTerminalOutput.mockClear();
      mockResumeTerminalOutput.mockResolvedValueOnce({
        generation: 1,
        seqStart: 0,
        seqEnd: 6,
        data: [0x61, 0x62, 0x63, 0x64, 0x65, 0x66],
        geometry,
      });
      act(() => {
        onOutput?.({ generation: 1, seqStart: 6, seqEnd: 9, data: [0x67, 0x68, 0x69], geometry });
      });
      await vi.waitFor(() => {
        expect(mockResumeTerminalOutput).toHaveBeenCalledWith("t-gap-repair-shadow", 1, 0);
      });

      // The stream was repaired in place: no reset, so the open frame is still
      // open and the in-frame show stays visibility-only. A rebuild here would
      // clear the latch and promote this show to an authoritative park.
      expect(mockReset.mock.calls.length).toBe(resetsBefore);
      await act(async () => {
        await csiHandlers.get("?:h")?.([25]);
      });
      expect(traces("dectcem-park")).toHaveLength(0);

      // Stands in for the `?2026l` the repair range carries (see the header:
      // the mocked xterm has no parser, so the handler is invoked directly).
      // What matters is that the latch is still closable — the repair neither
      // pre-closed it nor left it unreachable.
      await act(async () => {
        await csiHandlers.get("?:l")?.([2026]);
      });
      await act(async () => {
        await csiHandlers.get("?:h")?.([25]);
      });
      expect(traces("dectcem-park").length).toBeGreaterThan(0);
      expect(mockReset.mock.calls.length).toBe(resetsBefore);
    } finally {
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

  it("gates the renderer cursor for a DEC 2026 frame without option churn", async () => {
    render(<TerminalView instanceId="t-sync-cursor-gate" profile="PowerShell" syncGroup="" />);

    await waitForTerminalInputReady();
    const terminal = createdTerminals.find((candidate) => candidate.wasOpened);
    expect(terminal).toBeDefined();
    expect(terminal?._core.coreService.isCursorHidden).toBe(false);
    const cursorBlinkBefore = terminal?.options.cursorBlink;
    mockRefresh.mockClear();

    await act(async () => {
      await csiHandlers.get("?:h")?.([2026]);
    });

    expect(terminal?._core.coreService.isCursorHidden).toBe(true);
    expect(terminal?.options.cursorBlink).toBe(cursorBlinkBefore);
    expect(mockRefresh).not.toHaveBeenCalled();

    await act(async () => {
      await csiHandlers.get("?:l")?.([2026]);
    });

    // The parser hook runs before xterm's own reset handler. Releasing here lets
    // that handler's already-required full flush paint the final cursor once.
    expect(terminal?._core.coreService.isCursorHidden).toBe(false);
    expect(terminal?.options.cursorBlink).toBe(cursorBlinkBefore);
    expect(mockRefresh).not.toHaveBeenCalled();
  });

  it("repaints once when the xterm safety timeout releases the cursor gate", async () => {
    render(<TerminalView instanceId="t-sync-cursor-timeout" profile="PowerShell" syncGroup="" />);

    await waitForTerminalInputReady();
    const terminal = createdTerminals.find((candidate) => candidate.wasOpened);
    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;
    expect(terminal).toBeDefined();
    expect(onOutput).toBeTypeOf("function");

    mockModes.synchronizedOutputMode = true;
    await act(async () => {
      await csiHandlers.get("?:h")?.([2026]);
      onOutput?.(new TextEncoder().encode("frame"));
    });
    expect(terminal?._core.coreService.isCursorHidden).toBe(true);
    mockRefresh.mockClear();

    // No `?2026l` arrives. The monitor observes xterm's timeout mode release,
    // clears the raw gate, and requests exactly one recovery paint. Depending on
    // rAF ordering this may coalesce with xterm's own pending full render.
    mockModes.synchronizedOutputMode = false;
    await vi.waitFor(() => {
      expect(terminal?._core.coreService.isCursorHidden).toBe(false);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(mockRefresh).toHaveBeenCalledWith(0, 23);
  });

  it("does not let a base cursor transition clear the active sync-frame gate", async () => {
    render(<TerminalView instanceId="t-sync-base-gate" profile="PowerShell" syncGroup="" />);

    await waitForTerminalInputReady();
    const terminal = createdTerminals.find((candidate) => candidate.wasOpened);
    expect(terminal).toBeDefined();

    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-sync-base-gate", {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });
    await vi.waitFor(() => {
      expect(terminal?._core.coreService.isCursorHidden).toBe(true);
    });

    await act(async () => {
      await csiHandlers.get("?:h")?.([2026]);
    });
    act(() => {
      useTerminalStore.getState().updateInstanceInfo("t-sync-base-gate", {
        activity: { type: "shell" },
      });
    });

    // Base suppression is now false, but the independent frame reason remains.
    await vi.waitFor(() => {
      expect(screen.getByTestId("terminal-view-t-sync-base-gate")).not.toHaveClass(
        "terminal-native-cursor-hidden",
      );
    });
    expect(terminal?._core.coreService.isCursorHidden).toBe(true);

    await act(async () => {
      await csiHandlers.get("?:l")?.([2026]);
    });
    expect(terminal?._core.coreService.isCursorHidden).toBe(false);
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

  it("holds the global startup slot until both PTY creation and first render complete", async () => {
    let resolveSession!: (value: Awaited<ReturnType<typeof mockCreateTerminalSession>>) => void;
    mockCreateTerminalSession.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSession = resolve;
        }),
    );
    useTerminalStartupStore.getState().syncCandidates({
      knownPaneIds: ["pane-first", "pane-second"],
      eligiblePaneIds: ["pane-first", "pane-second"],
    });

    render(
      <TerminalView
        instanceId="terminal-pane-first"
        paneId="pane-first"
        profile="PowerShell"
        syncGroup=""
      />,
    );
    await vi.waitFor(() => expect(mockCreateTerminalSession).toHaveBeenCalled());

    const renderHandler = mockOnRender.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    act(() => renderHandler?.());
    expect(useTerminalStartupStore.getState().activePaneId).toBe("pane-first");

    await act(async () => {
      resolveSession({
        id: "terminal-pane-first",
        title: "Terminal",
        config: {
          profile: "PowerShell",
          cols: 80,
          rows: 24,
          sync_group: "",
          env: [],
          advertise_true_color: true,
        },
      });
      await Promise.resolve();
    });

    expect(useTerminalStartupStore.getState().activePaneId).toBe("pane-second");
    expect([...useTerminalStartupStore.getState().revealedPaneIds].sort()).toEqual([
      "pane-first",
      "pane-second",
    ]);
  });

  it("keeps the startup slot when PTY is ready before the first render", async () => {
    useTerminalStartupStore.getState().syncCandidates({
      knownPaneIds: ["pane-first", "pane-second"],
      eligiblePaneIds: ["pane-first", "pane-second"],
    });

    render(
      <TerminalView
        instanceId="terminal-pane-first"
        paneId="pane-first"
        profile="PowerShell"
        syncGroup=""
      />,
    );
    await vi.waitFor(() => {
      expect(
        useTerminalStore
          .getState()
          .instances.find((instance) => instance.id === "terminal-pane-first")?.sessionReady,
      ).toBe(true);
    });
    expect(useTerminalStartupStore.getState().activePaneId).toBe("pane-first");

    const renderHandler = mockOnRender.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    act(() => renderHandler?.());

    expect(useTerminalStartupStore.getState().activePaneId).toBe("pane-second");
  });

  it.each(["session", "status"] as const)(
    "reconciles the fitted grid when %s readiness resolves last",
    async (lastReadyGate) => {
      type Observer = {
        target: Element | null;
        callback: ResizeObserverCallback;
      };
      const observers: Observer[] = [];
      const originalResizeObserver = globalThis.ResizeObserver;
      globalThis.ResizeObserver = class {
        private readonly observer: Observer;

        constructor(callback: ResizeObserverCallback) {
          this.observer = { target: null, callback };
          observers.push(this.observer);
        }

        observe(target: Element) {
          this.observer.target = target;
        }

        unobserve() {}
        disconnect() {}
      } as unknown as typeof ResizeObserver;

      const resize = (observer: Observer, width: number, height: number) => {
        observer.callback(
          [
            {
              target: observer.target as Element,
              contentRect: { width, height },
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        );
      };

      let resolveSession!: (value: Awaited<ReturnType<typeof mockCreateTerminalSession>>) => void;
      mockCreateTerminalSession.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSession = resolve;
          }),
      );
      let resolveStatus!: (value: { active: boolean }) => void;
      mockGetRemoteControlStatus.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStatus = resolve;
          }),
      );

      try {
        render(
          <TerminalView
            instanceId="terminal-pane-zero-size"
            paneId="pane-zero-size"
            profile="PowerShell"
            syncGroup=""
          />,
        );
        expect(observers).toHaveLength(1);
        const observer = observers[0];
        const terminal = createdTerminals[0] as unknown as {
          open: ReturnType<typeof vi.fn>;
          cols: number;
          rows: number;
        };

        act(() => resize(observer, 0, 600));

        await vi.waitFor(() => {
          expect(mockCreateTerminalSession).toHaveBeenCalledWith(
            "terminal-pane-zero-size",
            "PowerShell",
            80,
            24,
            "",
            true,
            true,
            undefined,
            undefined,
          );
        });
        expect(terminal.open).not.toHaveBeenCalled();

        mockFit.mockImplementationOnce(() => {
          terminal.cols = 300;
          terminal.rows = 5;
          capturedResizeHandler?.({ cols: 300, rows: 5 });
        });
        act(() => resize(observer, 800, 600));

        expect(terminal.open).toHaveBeenCalledTimes(1);
        expect(mockCreateTerminalSession).toHaveBeenCalledTimes(1);
        expect(mockResizeTerminal).not.toHaveBeenCalled();

        const settleSession = async () => {
          await act(async () => {
            resolveSession({
              id: "terminal-pane-zero-size",
              title: "Terminal",
              initialExecutionHost: "unknown",
              config: {
                profile: "PowerShell",
                cols: 80,
                rows: 24,
                sync_group: "",
                env: [],
                advertise_true_color: true,
              },
            });
            await Promise.resolve();
          });
          await vi.waitFor(() => {
            expect(mockAttachTerminalOutput).toHaveBeenCalledWith("terminal-pane-zero-size");
          });
        };
        const settleStatus = async () => {
          await act(async () => {
            resolveStatus({ active: false });
            await Promise.resolve();
          });
        };

        if (lastReadyGate === "status") {
          await settleSession();
          expect(mockResizeTerminal).not.toHaveBeenCalled();
          await settleStatus();
        } else {
          await settleStatus();
          await act(async () => {
            await new Promise<void>((resolve) => {
              requestAnimationFrame(() => setTimeout(resolve, 0));
            });
          });
          expect(mockResizeTerminal).not.toHaveBeenCalled();
          await settleSession();
        }

        await vi.waitFor(() => {
          expect(mockResizeTerminal).toHaveBeenCalledWith("terminal-pane-zero-size", 300, 5);
        });
      } finally {
        globalThis.ResizeObserver = originalResizeObserver;
      }
    },
  );

  it("releases the global startup slot when PTY creation fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockCreateTerminalSession.mockRejectedValueOnce(new Error("spawn failed"));
    useTerminalStartupStore.getState().syncCandidates({
      knownPaneIds: ["pane-failed", "pane-next"],
      eligiblePaneIds: ["pane-failed", "pane-next"],
    });

    render(
      <TerminalView
        instanceId="terminal-pane-failed"
        paneId="pane-failed"
        profile="PowerShell"
        syncGroup=""
      />,
    );

    await vi.waitFor(() => {
      expect(useTerminalStartupStore.getState().activePaneId).toBe("pane-next");
    });
    consoleError.mockRestore();
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

  it("forwards legacy DEFAULT mouse bytes once without recording lastUserInput", async () => {
    const terminalId = "t-binary-mouse-input";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();
    mockWriteToTerminal.mockClear();
    mockWriteTerminalBinaryInput.mockClear();

    const report = "\x1b[M !!";
    act(() => createdTerminals.at(-1)!.emitBinary(report));

    await vi.waitFor(() => {
      expect(mockWriteTerminalBinaryInput).toHaveBeenCalledWith(terminalId, 1, report);
      expect(terminalInputDeliveryCounters(terminalId).succeeded).toBe(1);
    });
    expect(mockWriteTerminalBinaryInput).toHaveBeenCalledTimes(1);
    expect(mockWriteToTerminal).not.toHaveBeenCalled();
    expect(terminalInputDeliveryCounters(terminalId)).toEqual({
      attempts: 1,
      succeeded: 1,
      failed: 0,
      attemptedBytes: 6,
      succeededBytes: 6,
      failedBytes: 0,
    });
    expect(
      useTerminalStore.getState().instances.find((instance) => instance.id === terminalId)
        ?.lastUserInput,
    ).toBeUndefined();
  });

  it("reports a rejected binary mouse write once without resending it", async () => {
    const terminalId = "t-binary-mouse-rejected";
    mockWriteTerminalBinaryInput.mockRejectedValueOnce(new Error("IPC response lost"));
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();
    mockWriteTerminalBinaryInput.mockClear();

    const report = "\x1b[M !!";
    act(() => createdTerminals.at(-1)!.emitBinary(report));

    await vi.waitFor(() => {
      expect(terminalInputDeliveryCounters(terminalId).failed).toBe(1);
    });
    expect(mockWriteTerminalBinaryInput).toHaveBeenCalledTimes(1);
    expect(mockWriteTerminalBinaryInput).toHaveBeenCalledWith(terminalId, 1, report);
    expect(terminalInputDeliveryCounters(terminalId)).toEqual({
      attempts: 1,
      succeeded: 0,
      failed: 1,
      attemptedBytes: 6,
      succeededBytes: 0,
      failedBytes: 6,
    });
    expect(useNotificationStore.getState().notifications).toEqual([
      expect.objectContaining({ terminalId, requiresAction: true, level: "error" }),
    ]);
  });

  it("keeps binary mouse input fail-closed while Local control is unknown", async () => {
    mockGetRemoteControlStatus.mockReturnValueOnce(new Promise(() => {}));
    render(<TerminalView instanceId="t-binary-mouse-unknown" profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => expect(mockOnBinary).toHaveBeenCalled());
    mockWriteTerminalBinaryInput.mockClear();

    const terminal = createdTerminals.at(-1)!;
    expect(terminal.options.disableStdin).toBe(true);
    act(() => terminal.emitBinary("\x1b[M !!"));

    expect(mockWriteTerminalBinaryInput).not.toHaveBeenCalled();
    expect(terminalInputDeliveryCounters("t-binary-mouse-unknown").attempts).toBe(0);
  });

  it("records a successful human onData write with UTF-8 byte totals", async () => {
    const terminalId = "t-human-write-success";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForLocalTerminalControl();

    act(() => createdTerminals.at(-1)!.emitCoreData("가", true));
    await vi.waitFor(() => {
      expect(terminalInputDeliveryCounters(terminalId).succeeded).toBe(1);
    });

    expect(terminalInputDeliveryCounters(terminalId)).toEqual({
      attempts: 1,
      succeeded: 1,
      failed: 0,
      attemptedBytes: 3,
      succeededBytes: 3,
      failedBytes: 0,
    });
  });

  it("records a completed direct-mode agent input without exposing partial typing", async () => {
    const terminalId = "t-human-last-input";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForLocalTerminalControl();
    act(() => {
      useTerminalStore.getState().updateInstanceInfo(terminalId, {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });

    act(() => createdTerminals.at(-1)!.emitCoreData("마지막 질", true));
    await vi.waitFor(() =>
      expect(mockWriteToTerminal).toHaveBeenCalledWith(terminalId, "마지막 질"),
    );
    expect(
      useTerminalStore.getState().instances.find((instance) => instance.id === terminalId)
        ?.lastUserInput,
    ).toBeUndefined();

    act(() => createdTerminals.at(-1)!.emitCoreData("문\r", true));
    await vi.waitFor(() => {
      expect(
        useTerminalStore.getState().instances.find((instance) => instance.id === terminalId)
          ?.lastUserInput,
      ).toBe("마지막 질문");
    });
  });

  it("forwards TUI mouse reports without recording them as the last direct input", async () => {
    const terminalId = "t-human-last-input-mouse-report";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForLocalTerminalControl();

    const terminal = createdTerminals.at(-1)!;
    act(() => terminal.emitCoreData("\u001b[<35;118;41M\u001b[<35;119;41M", true));
    await vi.waitFor(() =>
      expect(mockWriteToTerminal).toHaveBeenCalledWith(
        terminalId,
        "\u001b[<35;118;41M\u001b[<35;119;41M",
      ),
    );
    expect(
      useTerminalStore.getState().instances.find((instance) => instance.id === terminalId)
        ?.lastUserInput,
    ).toBeUndefined();

    act(() => terminal.emitCoreData("실제 질문\r", true));
    await vi.waitFor(() => {
      expect(
        useTerminalStore.getState().instances.find((instance) => instance.id === terminalId)
          ?.lastUserInput,
      ).toBe("실제 질문");
    });
  });

  it("records a completed direct-mode shell command without waiting for OSC 133", async () => {
    const terminalId = "t-human-last-shell-command";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForLocalTerminalControl();

    act(() => createdTerminals.at(-1)!.emitCoreData("npm test", true));
    expect(
      useTerminalStore.getState().instances.find((instance) => instance.id === terminalId)
        ?.lastUserInput,
    ).toBeUndefined();

    act(() => createdTerminals.at(-1)!.emitCoreData("\r", true));
    await vi.waitFor(() => {
      expect(
        useTerminalStore.getState().instances.find((instance) => instance.id === terminalId)
          ?.lastUserInput,
      ).toBe("npm test");
    });
  });

  it("coalesces rejected human onData alerts while counting every exactly-once attempt", async () => {
    const terminalId = "t-human-write-rejected";
    mockWriteToTerminal.mockRejectedValue(new Error("IPC response lost"));
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForLocalTerminalControl();

    act(() => createdTerminals.at(-1)!.emitCoreData("x", true));
    act(() => createdTerminals.at(-1)!.emitCoreData("y", true));
    await vi.waitFor(() => {
      expect(terminalInputDeliveryCounters(terminalId).failed).toBe(2);
    });

    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    expect(mockWriteToTerminal).toHaveBeenCalledTimes(2);
    expect(mockWriteToTerminal).toHaveBeenCalledWith(terminalId, "x");
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      terminalId,
      requiresAction: true,
      level: "error",
    });
    expect(terminalInputDeliveryCounters(terminalId)).toEqual({
      attempts: 2,
      succeeded: 0,
      failed: 2,
      attemptedBytes: 2,
      succeededBytes: 0,
      failedBytes: 2,
    });
  });

  it("surfaces a rejected IME blur commit once without resending it", async () => {
    const terminalId = "t-ime-blur-write-rejected";
    mockWriteToTerminal.mockRejectedValue(new Error("IPC response lost"));
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    const host = screen.getByTestId(`terminal-xterm-host-${terminalId}`);
    const terminal = createdTerminals.at(-1) as unknown as { element: HTMLDivElement };
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    terminal.element.appendChild(helper);
    host.appendChild(terminal.element);
    await waitForLocalTerminalControl();

    act(() => {
      helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId(`terminal-view-${terminalId}`)).toHaveClass(
        "terminal-ime-composition-active",
      );
    });
    act(() => {
      helper.value = "가";
      helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "가" }));
      helper.dispatchEvent(new Event("blur"));
    });
    await vi.waitFor(() => {
      expect(terminalInputDeliveryCounters(terminalId).failed).toBe(1);
    });

    expect(mockWriteToTerminal).toHaveBeenCalledTimes(1);
    expect(mockWriteToTerminal).toHaveBeenCalledWith(terminalId, "가");
    expect(useNotificationStore.getState().notifications).toHaveLength(1);
    expect(terminalInputDeliveryCounters(terminalId)).toEqual({
      attempts: 1,
      succeeded: 0,
      failed: 1,
      attemptedBytes: 3,
      succeededBytes: 0,
      failedBytes: 3,
    });
  });

  it("does not republish human input diagnostics when a closed pane's write settles late", async () => {
    let settleWrite: (() => void) | undefined;
    mockWriteToTerminal.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          settleWrite = resolve;
        }),
    );
    mockCloseTerminalSession.mockImplementationOnce(async (terminalId: string) => {
      // The component mock replaces tauri-api's real close wrapper, whose
      // finally block drops session-scoped input diagnostics.
      forgetTerminalInputDeliveryCounters(terminalId);
    });
    const { unmount } = render(
      <TerminalView instanceId="t-human-write-late-close" profile="PowerShell" syncGroup="" />,
    );
    await waitForLocalTerminalControl();
    act(() => createdTerminals.at(-1)!.emitCoreData("x", true));
    expect(terminalInputDeliveryCounters("t-human-write-late-close").attempts).toBe(1);

    unmount();
    await vi.waitFor(() => expect(mockCloseTerminalSession).toHaveBeenCalled());
    await act(async () => {
      settleWrite?.();
      await Promise.resolve();
    });

    expect(allTerminalInputDeliveryCounters()).toEqual({});
  });

  describe("terminal protocol reply ownership", () => {
    const emitLive = (terminalId: string, value: string) => {
      const onOutput = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      act(() => onOutput?.(new TextEncoder().encode(value)));
    };

    it("sends replies produced by a live parser write through the protocol path", async () => {
      const terminalId = "t-live-protocol-reply";
      render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
      await waitForTerminalInputReady();
      mockWriteTerminalProtocolReply.mockClear();
      mockWriteToTerminal.mockClear();
      const terminal = createdTerminals.at(-1)!;
      const reply = "\x1b]10;rgb:ffff/ffff/ffff\x1b\\";
      mockWrite.mockImplementationOnce((_, callback?: () => void) => {
        terminal.emitCoreData(reply);
        callback?.();
      });

      emitLive(terminalId, "LIVE_QUERY");

      expect(mockWriteTerminalProtocolReply).toHaveBeenCalledWith(terminalId, 1, reply);
      expect(mockWriteToTerminal).not.toHaveBeenCalled();
      expect(terminalInputDeliveryCounters(terminalId)).toEqual({
        attempts: 0,
        succeeded: 0,
        failed: 0,
        attemptedBytes: 0,
        succeededBytes: 0,
        failedBytes: 0,
      });
    });

    it("suppresses replies produced by snapshot replay", async () => {
      const terminalId = "t-replay-protocol-reply";
      const snapshot = new TextEncoder().encode("REPLAY_QUERY");
      mockAttachTerminalOutput.mockResolvedValueOnce({
        state: {
          version: 1,
          generation: 1,
          snapshotStartSeq: 0,
          snapshotSeq: snapshot.length,
          sourceStartSeq: 0,
          sourceSeq: snapshot.length,
          snapshotKind: "raw",
          protocolRevision: 0,
          modes: { bracketedPaste: false },
          geometry: { revision: 0, cols: 80, rows: 24 },
        },
        snapshot: Array.from(snapshot),
        flowControl: { token: "lease-replay", windowBytes: 524288 },
      });
      const reply = "\x1b]11;rgb:0000/0000/0000\x1b\\";
      mockWrite.mockImplementationOnce((_, callback?: () => void) => {
        createdTerminals.at(-1)?.emitCoreData(reply);
        callback?.();
      });

      render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
      await waitForTerminalInputReady();

      expect(mockWriteTerminalProtocolReply).not.toHaveBeenCalled();
      expect(mockWriteToTerminal).not.toHaveBeenCalledWith(terminalId, reply);
    });

    it("offers the initial snapshot's primary device-attributes reply to the guarded bootstrap path", async () => {
      const terminalId = "t-bootstrap-da-reply";
      const snapshot = new TextEncoder().encode("\x1b[c");
      mockAttachTerminalOutput.mockResolvedValueOnce({
        state: {
          version: 1,
          generation: 1,
          snapshotStartSeq: 0,
          snapshotSeq: snapshot.length,
          sourceStartSeq: 0,
          sourceSeq: snapshot.length,
          snapshotKind: "raw",
          protocolRevision: 0,
          modes: { bracketedPaste: false },
          geometry: { revision: 0, cols: 80, rows: 24 },
        },
        snapshot: Array.from(snapshot),
        flowControl: { token: "lease-bootstrap-da", windowBytes: 524288 },
      });
      const reply = "\x1b[?1;2c";
      let replyEmitted = false;
      mockWrite.mockImplementation((data: string | Uint8Array, callback?: () => void) => {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        if (!replyEmitted && text === "\x1b[c") {
          replyEmitted = true;
          createdTerminals.at(-1)?.emitCoreData(reply);
        }
        callback?.();
      });

      render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
      await waitForTerminalInputReady();

      await vi.waitFor(() => expect(replyEmitted).toBe(true), { timeout: 3500 });
      await vi.waitFor(() =>
        expect(mockWriteTerminalBootstrapProtocolReply).toHaveBeenCalledWith(terminalId, 1, reply),
      );
      expect(mockWriteTerminalProtocolReply).not.toHaveBeenCalled();
      expect(mockWriteToTerminal).not.toHaveBeenCalledWith(terminalId, reply);
    });

    it("keeps live protocol replies flowing while local human control is unknown", async () => {
      const terminalId = "t-unknown-owner-protocol-reply";
      mockGetRemoteControlStatus.mockImplementationOnce(() => new Promise(() => {}));
      render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => expect(mockOnTerminalOutput).toHaveBeenCalled());
      const terminal = createdTerminals.at(-1)!;
      expect(terminal.options.disableStdin).toBe(true);
      const reply = "\x1b]10;rgb:aaaa/bbbb/cccc\x1b\\";
      mockWrite.mockImplementationOnce((_, callback?: () => void) => {
        terminal.emitCoreData(reply);
        callback?.();
      });

      emitLive(terminalId, "LIVE_QUERY");

      expect(mockWriteTerminalProtocolReply).toHaveBeenCalledWith(terminalId, 1, reply);
    });

    it("toggles xterm human stdin with the remote owner snapshot", async () => {
      const terminalId = "t-owner-disable-stdin";
      render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
      await waitForLocalTerminalControl();
      const terminal = createdTerminals.at(-1)!;
      expect(terminal.options.disableStdin).toBe(false);

      act(() => capturedRemoteControlChanged?.({ active: true }));
      expect(terminal.options.disableStdin).toBe(true);
      expect(capturedKeyHandler?.(new KeyboardEvent("keydown", { key: "a" }))).toBe(false);

      const reply = "\x1b]11;rgb:0000/0000/0000\x1b\\";
      mockWriteTerminalProtocolReply.mockClear();
      mockWriteToTerminal.mockClear();
      mockWrite.mockImplementationOnce((_, callback?: () => void) => {
        terminal.emitCoreData(reply);
        callback?.();
      });
      emitLive(terminalId, "LIVE_QUERY_WHILE_REMOTE");
      expect(mockWriteTerminalProtocolReply).toHaveBeenCalledWith(terminalId, 1, reply);
      terminal.emitCoreData("blocked-human", true);
      expect(mockWriteToTerminal).not.toHaveBeenCalled();
      expect(mockWriteTerminalProtocolReply).toHaveBeenCalledTimes(1);
    });

    it("enables human stdin for a terminal mounted after Local control is already known", async () => {
      render(<TerminalView instanceId="t-owner-seed" profile="PowerShell" syncGroup="" />);
      await waitForLocalTerminalControl();
      await vi.waitFor(() => expect(createdTerminals).toHaveLength(1));
      expect(createdTerminals[0].options.disableStdin).toBe(false);
      expect(mockGetRemoteControlStatus).toHaveBeenCalledTimes(1);

      render(<TerminalView instanceId="t-owner-late-mount" profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => expect(createdTerminals).toHaveLength(2));

      expect(mockGetRemoteControlStatus).toHaveBeenCalledTimes(1);
      expect(createdTerminals[1].options.disableStdin).toBe(false);
    });
  });

  describe("synchronized-output cursor transactions", () => {
    const sessionResult = (initialExecutionHost: string) => ({
      id: "t-native-stabilizer",
      title: "Terminal",
      initialExecutionHost,
      config: {
        profile: "PowerShell",
        cols: 80,
        rows: 24,
        sync_group: "",
        env: [],
        advertise_true_color: true,
      },
    });

    const setupWslCodexCompositionFrame = async (terminalId: string) => {
      mockCreateTerminalSession.mockResolvedValueOnce({
        ...sessionResult("wsl"),
        id: terminalId,
      });
      render(<TerminalView instanceId={terminalId} profile="WSL" syncGroup="" isFocused />);
      act(() => {
        useTerminalStore.getState().updateInstanceInfo(terminalId, {
          activity: { type: "interactiveApp", name: "Codex" },
        });
      });

      const terminal = createdTerminals.at(-1)! as MockTerminalInstance & {
        buffer: { active: typeof mockBufferActive };
      };
      const container = screen.getByTestId(`terminal-view-${terminalId}`);
      const overlay = screen.getByTestId(`terminal-overlay-caret-${terminalId}`);
      const preview = screen.getByTestId(`terminal-composition-preview-${terminalId}`);
      const rect = () =>
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
      const screenEl = document.createElement("div");
      screenEl.className = "xterm-screen";
      screenEl.getBoundingClientRect = rect;
      const helper = document.createElement("textarea");
      helper.className = "xterm-helper-textarea";
      terminal.element.append(screenEl, helper);
      container.getBoundingClientRect = rect;
      await waitForTerminalInputReady();
      await waitForStreamAttachReset();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      terminal.buffer.active.baseY = 0;
      terminal.buffer.active.viewportY = 0;
      terminal.buffer.active.cursorX = 10;
      terminal.buffer.active.cursorY = 4;
      act(() => {
        helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
        helper.value = "\ub2c8";
        helper.selectionStart = 1;
        helper.selectionEnd = 1;
        helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\ub2c8" }));
        helper.dispatchEvent(new Event("input"));
      });
      await vi.waitFor(() => {
        expect(preview.textContent).toBe("\ub2c8");
        expect(preview.style.transform).toBe("translate(100px, 80px)");
        expect(overlay.style.opacity).toBe("1");
        expect(overlay.style.transform).toBe("translate(120px, 80px)");
        expect(helper.style.left).toBe("120px");
        expect(helper.style.top).toBe("80px");
      });

      mockModes.synchronizedOutputMode = true;
      await act(async () => {
        await csiHandlers.get("?:h")?.([2026]);
        // A TUI repaint can park the public cursor on a footer while the
        // composition controller still owns the input-row anchor.
        terminal.buffer.active.cursorX = 40;
        terminal.buffer.active.cursorY = 10;
        const renderHandler = mockOnRender.mock.calls.at(-1)?.[0] as (() => void) | undefined;
        renderHandler?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(container).toHaveClass("terminal-sync-output-active");

      const closeFrame = async () => {
        mockModes.synchronizedOutputMode = false;
        await act(async () => {
          await csiHandlers.get("?:l")?.([2026]);
        });
      };
      return { container, helper, overlay, preview, closeFrame };
    };

    it("removes only the in-frame cursor show and refreshes after one atomic write", async () => {
      const terminalId = "t-native-stabilizer";
      mockCreateTerminalSession.mockResolvedValueOnce(sessionResult("nativeWindows"));
      render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
      await waitForTerminalInputReady();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      mockWrite.mockClear();
      mockRefresh.mockClear();
      const onOutput = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      const raw = "\x1b[?2026hbody\x1b[?25h\x1b[?2026l\x1b[?25l\x1b[3;4H\x1b[?25h";
      const expected = "\x1b[?2026hbody\x1b[?2026l\x1b[?25l\x1b[3;4H\x1b[?25h";

      act(() => onOutput?.(new TextEncoder().encode(raw)));

      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(new TextDecoder().decode(mockWrite.mock.calls[0][0] as Uint8Array)).toBe(expected);
      await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(2));
    });

    it.each([
      ["0.145", "\x1b[?2026hbody\x1b[26;58H\x1b[?25h\x1b[24;3H\x1b[?2026l"],
      ["0.150+", "\x1b[?2026hbody\x1b[26;58H\x1b[24;3H\x1b[?25h\x1b[?2026l"],
    ])("flushes Codex %s's in-frame cursor park in the same xterm write", async (_version, raw) => {
      const terminalId = "t-native-in-frame-park";
      mockCreateTerminalSession.mockResolvedValueOnce({
        ...sessionResult("nativeWindows"),
        id: terminalId,
      });
      render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
      await waitForTerminalInputReady();
      mockWrite.mockClear();
      const onOutput = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;

      act(() => onOutput?.(new TextEncoder().encode(raw)));

      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(new TextDecoder().decode(mockWrite.mock.calls[0][0] as Uint8Array)).toBe(raw);
    });

    it.each([
      ["0.145", "\x1b[?2026hbody\x1b[24;58H\x1b[?25h\x1b[6;5H\x1b[?2026l"],
      ["0.150+", "\x1b[?2026hbody\x1b[24;58H\x1b[6;5H\x1b[?25h\x1b[?2026l"],
    ])(
      "does not send WSL Codex %s's in-frame park through the legacy settle timeout",
      async (_version, raw) => {
        localStorage.setItem("laymux:cursor-trace", "1");
        const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
        const terminalId = "t-wsl-in-frame-park";
        try {
          mockCreateTerminalSession.mockResolvedValueOnce({
            ...sessionResult("wsl"),
            id: terminalId,
          });
          render(<TerminalView instanceId={terminalId} profile="WSL" syncGroup="" />);
          await waitForTerminalInputReady();
          act(() => {
            useTerminalStore.getState().updateInstanceInfo(terminalId, {
              activity: { type: "interactiveApp", name: "Codex" },
            });
          });

          const terminal = createdTerminals.at(-1)! as MockTerminalInstance & {
            buffer: { active: typeof mockBufferActive };
          };
          const rawSet = mockRegisterCsiHandler.mock.calls.find(
            (call) =>
              (call[0] as { prefix?: string; final: string }).prefix === "?" &&
              (call[0] as { prefix?: string; final: string }).final === "h",
          )?.[1] as ((params: readonly number[]) => boolean) | undefined;
          const rawReset = mockRegisterCsiHandler.mock.calls.find(
            (call) =>
              (call[0] as { prefix?: string; final: string }).prefix === "?" &&
              (call[0] as { prefix?: string; final: string }).final === "l",
          )?.[1] as ((params: readonly number[]) => boolean) | undefined;
          expect(rawSet).toBeTypeOf("function");
          expect(rawReset).toBeTypeOf("function");

          mockWrite.mockClear();
          mockWrite.mockImplementation(function (data, callback?: () => void) {
            const parsed =
              typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array);
            if (parsed.includes("\x1b[?2026h")) rawSet?.([2026]);
            if (parsed.includes("\x1b[?25h")) {
              terminal.buffer.active.cursorX = 58;
              terminal.buffer.active.cursorY = 23;
              rawSet?.([25]);
            }
            if (parsed.includes("\x1b[6;5H")) {
              terminal.buffer.active.cursorX = 4;
              terminal.buffer.active.cursorY = 5;
            }
            if (parsed.includes("\x1b[?2026l")) rawReset?.([2026]);
            callback?.();
          });
          const onOutput = mockOnTerminalOutput.mock.calls.find(
            ([id]) => id === terminalId,
          )?.[1] as ((data: Uint8Array) => void) | undefined;

          vi.useFakeTimers();
          act(() => {
            onOutput?.(new TextEncoder().encode(raw));
          });
          await act(async () => {
            vi.advanceTimersByTime(60);
          });

          const settleTraces = logSpy.mock.calls.filter(
            (call) => typeof call[0] === "string" && call[0].includes("park-settle-timeout"),
          );
          expect(settleTraces).toHaveLength(0);
        } finally {
          vi.useRealTimers();
          logSpy.mockRestore();
          localStorage.removeItem("laymux:cursor-trace");
        }
      },
    );

    it("keeps the painted WSL Codex caret frozen while a Working frame spans animation frames", async () => {
      const terminalId = "t-wsl-working-caret";
      mockCreateTerminalSession.mockResolvedValueOnce({
        ...sessionResult("wsl"),
        id: terminalId,
      });
      render(<TerminalView instanceId={terminalId} profile="WSL" syncGroup="" isFocused />);
      await waitForTerminalInputReady();
      await waitForStreamAttachReset();

      act(() => {
        useTerminalStore.getState().updateInstanceInfo(terminalId, {
          activity: { type: "interactiveApp", name: "Codex" },
        });
      });

      const terminal = createdTerminals.at(-1)! as MockTerminalInstance & {
        buffer: { active: typeof mockBufferActive };
      };
      const container = screen.getByTestId(`terminal-view-${terminalId}`);
      const overlay = screen.getByTestId(`terminal-overlay-caret-${terminalId}`);
      const screenEl = document.createElement("div");
      screenEl.className = "xterm-screen";
      const terminalRect = {
        left: 0,
        top: 0,
        width: 800,
        height: 480,
        right: 800,
        bottom: 480,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      } as DOMRect;
      screenEl.getBoundingClientRect = () => terminalRect;
      container.getBoundingClientRect = () => terminalRect;
      terminal.element.appendChild(screenEl);
      terminal.buffer.active.baseY = 0;
      terminal.buffer.active.viewportY = 0;
      terminal.buffer.active.cursorX = 2;
      terminal.buffer.active.cursorY = 17;

      await act(async () => {
        await oscHandlers.get("133")?.("B");
      });
      await vi.waitFor(() => {
        expect(overlay.style.opacity).toBe("1");
        expect(overlay.style.transform).toBe("translate(20px, 340px)");
      });

      // WSL passes bytes through instead of holding the whole DEC 2026
      // transaction. A PTY boundary can therefore leave frame-open visible to
      // an animation frame before the strict in-frame park/reset arrives.
      mockModes.synchronizedOutputMode = true;
      terminal.buffer.active.cursorX = 40;
      terminal.buffer.active.cursorY = 10;
      await act(async () => {
        await csiHandlers.get("?:h")?.([2026]);
        const renderHandler = mockOnRender.mock.calls.at(-1)?.[0] as (() => void) | undefined;
        renderHandler?.();
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(container).toHaveClass("terminal-sync-output-active");
      expect(overlay.style.opacity).toBe("1");
      expect(overlay.style.transform).toBe("translate(20px, 340px)");

      mockModes.synchronizedOutputMode = false;
      await act(async () => {
        await csiHandlers.get("?:l")?.([2026]);
      });
    });

    it("advances the live IME preview while a WSL Codex frame spans animation frames", async () => {
      const { container, helper, overlay, preview, closeFrame } =
        await setupWslCodexCompositionFrame("t-wsl-working-ime-advance");
      try {
        act(() => {
          helper.dispatchEvent(new CompositionEvent("compositionend", { data: "\ub2c8" }));
          helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
          helper.value = "\ub2c8\ub2e4";
          helper.selectionStart = 2;
          helper.selectionEnd = 2;
          helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\ub2e4" }));
          helper.dispatchEvent(new Event("input"));
        });
        await act(async () => {
          const renderHandler = mockOnRender.mock.calls.at(-1)?.[0] as (() => void) | undefined;
          renderHandler?.();
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        await vi.waitFor(() => {
          expect(container).toHaveClass("terminal-sync-output-active");
          expect(preview.textContent).toBe("\ub2e4");
          expect(preview.style.transform).toBe("translate(120px, 80px)");
          expect(overlay.style.opacity).toBe("1");
          expect(overlay.style.transform).toBe("translate(140px, 80px)");
          expect(helper.style.left).toBe("140px");
          expect(helper.style.top).toBe("80px");
        });
      } finally {
        await closeFrame();
      }
    });

    it("clears a finished IME preview while a WSL Codex frame spans animation frames", async () => {
      const { container, helper, overlay, preview, closeFrame } =
        await setupWslCodexCompositionFrame("t-wsl-working-ime-finish");
      try {
        const frozenOverlayOpacity = overlay.style.opacity;
        const frozenOverlayTransform = overlay.style.transform;
        act(() => {
          helper.dispatchEvent(new CompositionEvent("compositionend", { data: "\ub2c8" }));
        });
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 0));
        });

        await vi.waitFor(() => {
          expect(container).toHaveClass("terminal-sync-output-active");
          expect(preview.textContent).toBe("");
          expect(preview.style.opacity).toBe("0");
          expect(overlay.style.opacity).toBe(frozenOverlayOpacity);
          expect(overlay.style.transform).toBe(frozenOverlayTransform);
          expect(helper.style.left).toBe("");
          expect(helper.style.top).toBe("");
        });
      } finally {
        await closeFrame();
      }
    });

    it("lets an open IME composition adopt Codex 0.145's in-frame park", async () => {
      const terminalId = "t-native-in-frame-ime";
      mockCreateTerminalSession.mockResolvedValueOnce({
        ...sessionResult("nativeWindows"),
        id: terminalId,
      });
      render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" isFocused />);
      act(() => {
        useTerminalStore.getState().updateInstanceInfo(terminalId, {
          activity: { type: "interactiveApp", name: "Codex" },
        });
      });

      const terminal = createdTerminals.at(-1)! as MockTerminalInstance & {
        buffer: { active: typeof mockBufferActive };
      };
      const container = screen.getByTestId(`terminal-view-${terminalId}`);
      const preview = screen.getByTestId(`terminal-composition-preview-${terminalId}`);
      const rect = () =>
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
      const screenEl = document.createElement("div");
      screenEl.className = "xterm-screen";
      screenEl.getBoundingClientRect = rect;
      const helper = document.createElement("textarea");
      helper.className = "xterm-helper-textarea";
      terminal.element.append(screenEl, helper);
      container.getBoundingClientRect = rect;
      await waitForTerminalInputReady();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      // Start the active syllable at the last two cells of the input row. The
      // arithmetic preview remains there until a settled app redraw is observed.
      terminal.buffer.active.baseY = 0;
      terminal.buffer.active.cursorX = 78;
      terminal.buffer.active.cursorY = 4;
      act(() => {
        helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
        helper.value = "라";
        helper.selectionStart = 1;
        helper.selectionEnd = 1;
        helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "라" }));
        helper.dispatchEvent(new Event("input"));
      });
      await vi.waitFor(() => expect(preview.textContent).toBe("라"));

      const rawSet = mockRegisterCsiHandler.mock.calls.find(
        (call) =>
          (call[0] as { prefix?: string; final: string }).prefix === "?" &&
          (call[0] as { prefix?: string; final: string }).final === "h",
      )?.[1] as ((params: readonly number[]) => boolean) | undefined;
      const rawReset = mockRegisterCsiHandler.mock.calls.find(
        (call) =>
          (call[0] as { prefix?: string; final: string }).prefix === "?" &&
          (call[0] as { prefix?: string; final: string }).final === "l",
      )?.[1] as ((params: readonly number[]) => boolean) | undefined;
      const writeParsed = mockOnWriteParsed.mock.calls.at(-1)?.[0] as (() => void) | undefined;
      expect(rawSet).toBeTypeOf("function");
      expect(rawReset).toBeTypeOf("function");

      mockWrite.mockImplementationOnce(function (_data, callback?: () => void) {
        rawSet?.([2026]);
        // Footer show is still in-frame and therefore not a settled caret.
        terminal.buffer.active.cursorX = 58;
        terminal.buffer.active.cursorY = 23;
        rawSet?.([25]);
        // Final CUP after the show: Codex's indented continuation caret.
        terminal.buffer.active.cursorX = 4;
        terminal.buffer.active.cursorY = 5;
        rawReset?.([2026]);
        writeParsed?.();
        callback?.();
      });
      const onOutput = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;

      act(() => {
        onOutput?.(
          new TextEncoder().encode("\x1b[?2026hbody\x1b[24;58H\x1b[?25h\x1b[6;5H\x1b[?2026l"),
        );
      });

      await vi.waitFor(() => {
        // 80x24 over 800x480 => 10x20 cells. The measured app caret (4,5)
        // wins over the stale edge anchor (78,4), unblocking issue #569's path.
        expect(preview.style.transform).toBe("translate(40px, 100px)");
      });
    });

    it("keeps a large exact frame and restore in one xterm write", async () => {
      const terminalId = "t-native-large-stabilizer";
      mockCreateTerminalSession.mockResolvedValueOnce({
        ...sessionResult("nativeWindows"),
        id: terminalId,
      });
      render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
      await waitForTerminalInputReady();
      mockWrite.mockClear();
      mockRefresh.mockClear();
      const onOutput = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      const raw =
        "\x1b[?2026h" + "x".repeat(70_000) + "\x1b[?25h\x1b[?2026l\x1b[?25l\x1b[3;4H\x1b[?25h";

      act(() => onOutput?.(new TextEncoder().encode(raw)));

      expect(mockWrite).toHaveBeenCalledTimes(1);
      const written = new TextDecoder().decode(mockWrite.mock.calls[0][0] as Uint8Array);
      expect(written).toHaveLength(raw.length - "\x1b[?25h".length);
      expect(written.endsWith("\x1b[?2026l\x1b[?25l\x1b[3;4H\x1b[?25h")).toBe(true);
      await vi.waitFor(() => expect(mockRefresh).toHaveBeenCalledTimes(2));
    });

    it("preserves the native stabilizer deadline while visible xterm is backpressured", async () => {
      const terminalId = "t-native-stabilizer-backlog-deadline";
      mockCreateTerminalSession.mockResolvedValueOnce({
        ...sessionResult("nativeWindows"),
        id: terminalId,
      });
      render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
      await waitForTerminalInputReady();

      let finishBusyWrite: (() => void) | undefined;
      mockWrite.mockClear();
      mockWrite.mockImplementationOnce((_, callback?: () => void) => {
        finishBusyWrite = callback;
      });
      const onOutput = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      const frameStart = "\x1b[?2026hbody\x1b[?25h";
      const afterDeadline = "late\x1b[?2026l\x1b[?25l\x1b[3;4H\x1b[?25h";

      vi.useFakeTimers();
      try {
        act(() => onOutput?.(new TextEncoder().encode("busy")));
        act(() => onOutput?.(new TextEncoder().encode(frameStart)));
        // The logical frame expires while xterm is still parsing the preceding
        // write. Queueing above the stabilizer used to postpone the start marker,
        // making this timeout disappear and deleting the in-frame `?25h` byte.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(51);
        });
        act(() => onOutput?.(new TextEncoder().encode(afterDeadline)));
        act(() => finishBusyWrite?.());
        await act(async () => {
          await vi.runAllTimersAsync();
        });

        const stream = mockWrite.mock.calls
          .map(([data]) =>
            typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array),
          )
          .join("");
        expect(stream).toBe(`busy${frameStart}${afterDeadline}`);
      } finally {
        vi.useRealTimers();
      }
    });

    it("holds a split native CSI through completion before a deferred fit", async () => {
      const terminalId = "t-native-stabilizer-split-fit";
      const paneId = "pane-native-stabilizer-split-fit";
      const userAgent = vi
        .spyOn(window.navigator, "userAgent", "get")
        .mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
      mockCreateTerminalSession.mockResolvedValueOnce({
        ...sessionResult("nativeWindows"),
        id: terminalId,
      });
      render(
        <TerminalView instanceId={terminalId} paneId={paneId} profile="PowerShell" syncGroup="" />,
      );
      await waitForTerminalInputReady();
      const onOutput = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      const order: string[] = [];
      mockWrite.mockClear();
      mockFit.mockClear();
      mockWrite.mockImplementation((data, callback?: () => void) => {
        order.push(
          `write:${typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array)}`,
        );
        callback?.();
      });
      mockFit.mockImplementation(() => order.push("fit"));

      vi.useFakeTimers();
      try {
        act(() => {
          onOutput?.(new TextEncoder().encode("\x1b[1;"));
          useOverridesStore.getState().setViewOverride(paneId, { fontSize: 20 });
        });
        await act(async () => vi.advanceTimersByTimeAsync(0));
        expect(order).toEqual([]);

        // Correctness wins over a finite resize deadline: an incomplete CSI has
        // not executed on either grid yet, so even the 500ms quiet-window cap
        // cannot let fit cross it.
        await act(async () => vi.advanceTimersByTimeAsync(50));
        expect(order).toEqual([]);
        await act(async () => vi.advanceTimersByTimeAsync(70));
        expect(order).toEqual([]);
        await act(async () => vi.advanceTimersByTimeAsync(380));
        expect(order).toEqual([]);
        expect(mockFit).not.toHaveBeenCalled();

        act(() => onOutput?.(new TextEncoder().encode("70HX")));
        expect(order).toEqual(["write:\x1b[1;70HX"]);
        await act(async () => vi.advanceTimersByTimeAsync(120));
        expect(order).toEqual(["write:\x1b[1;70HX", "fit"]);
      } finally {
        vi.useRealTimers();
        userAgent.mockRestore();
        mockWrite.mockImplementation((_: string | Uint8Array, callback?: () => void) => {
          callback?.();
        });
        mockFit.mockImplementation(() => {});
      }
    });

    it("keeps an async IME commit human while a live parser write is pending", async () => {
      const terminalId = "t-native-ime-stabilizer";
      mockCreateTerminalSession.mockResolvedValueOnce({
        ...sessionResult("nativeWindows"),
        id: terminalId,
      });
      render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" isFocused />);
      const wrapper = screen.getByTestId(`terminal-view-${terminalId}`);
      const terminal = createdTerminals.at(-1)!;
      const helper = document.createElement("textarea");
      helper.className = "xterm-helper-textarea";
      terminal.element.appendChild(helper);
      wrapper.appendChild(terminal.element);
      await waitForTerminalInputReady();

      helper.focus();
      helper.value = "\u3131";
      helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "\u3131" }));
      helper.dispatchEvent(new Event("input", { bubbles: true }));
      mockWrite.mockClear();
      mockWriteToTerminal.mockClear();
      mockWriteTerminalProtocolReply.mockClear();
      let finishLiveWrite: (() => void) | undefined;
      mockWrite.mockImplementationOnce((_, callback?: () => void) => {
        finishLiveWrite = callback;
      });
      const onOutput = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;

      act(() => {
        onOutput?.(new TextEncoder().encode("\x1b[?2026hbody\x1b[?25h\x1b[?2026l"));
      });
      expect(mockWrite).not.toHaveBeenCalled();
      act(() => {
        onOutput?.(new TextEncoder().encode("\x1b[?25l\x1b[3;4H\x1b[?25h"));
      });

      expect(document.activeElement).toBe(helper);
      expect(helper.value).toBe("\u3131");
      expect(mockWrite).toHaveBeenCalledTimes(1);

      await act(async () => {
        helper.dispatchEvent(new CompositionEvent("compositionend", { data: "\uAC00" }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        terminal.emitCoreData("\uAC00", true);
      });

      expect(mockWriteToTerminal).toHaveBeenCalledTimes(1);
      expect(mockWriteToTerminal).toHaveBeenCalledWith(terminalId, "\uAC00");
      expect(mockWriteTerminalProtocolReply).not.toHaveBeenCalled();
      act(() => finishLiveWrite?.());
    });

    it("passes direct WSL sessions through byte-for-byte", async () => {
      const terminalId = "t-wsl-stabilizer-bypass";
      mockCreateTerminalSession.mockResolvedValueOnce({
        ...sessionResult("wsl"),
        id: terminalId,
      });
      render(<TerminalView instanceId={terminalId} profile="WSL" syncGroup="" />);
      await waitForTerminalInputReady();
      mockWrite.mockClear();
      const onOutput = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      const raw = "\x1b[?2026hbody\x1b[?25h\x1b[?2026l\x1b[?25l\x1b[3;4H\x1b[?25h";

      act(() => onOutput?.(new TextEncoder().encode(raw)));

      expect(new TextDecoder().decode(mockWrite.mock.calls[0][0] as Uint8Array)).toBe(raw);
    });
  });

  // --- Issue #365 follow-up: typing dismisses notifications by focus, not key ---
  // Entering a workspace clears its alerts; typing is an even stronger "I'm
  // responding here" signal, so onKey must clear unread alerts (including
  // requiresAction) with the *same granularity* as the focus/entry policy.
  describe("clears notifications on terminal input", () => {
    const latestOnKey = () => {
      const calls = mockOnKey.mock.calls;
      return calls[calls.length - 1]?.[0] as
        | ((event: { key: string; domEvent: KeyboardEvent }) => void)
        | undefined;
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
      const onKey = latestOnKey();
      expect(onKey).toBeTypeOf("function");
      act(() => onKey!({ key: "a", domEvent: new KeyboardEvent("keydown", { key: "a" }) }));

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
      act(() => latestOnKey()!({ key: "x", domEvent: new KeyboardEvent("keydown", { key: "x" }) }));

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
      act(() => latestOnKey()!({ key: "z", domEvent: new KeyboardEvent("keydown", { key: "z" }) }));

      expect(useNotificationStore.getState().notifications[0].readAt).toBeNull();
    });

    it("does not clear alerts for emulator-generated protocol responses", async () => {
      setDismiss("paneFocus");
      const wsId = useWorkspaceStore.getState().activeWorkspaceId;
      useNotificationStore.getState().addNotification({
        terminalId: "t-input-protocol",
        workspaceId: wsId,
        message: "Codex is waiting for your input",
        requiresAction: true,
      });

      render(<TerminalView instanceId="t-input-protocol" profile="PowerShell" syncGroup="" />);
      await waitForLocalControl();
      const onData = mockOnData.mock.calls.at(-1)?.[0] as ((data: string) => void) | undefined;
      expect(onData).toBeTypeOf("function");

      act(() => onData!("\x1b]10;rgb:ffff/ffff/ffff\x1b\\"));

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
    await waitForTerminalRendererOpen();

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

  it("preserves terminal focus metadata when a focused pane changes profile", async () => {
    const instanceId = "t-profile-focus";
    const { rerender } = render(
      <TerminalView instanceId={instanceId} profile="PowerShell" syncGroup="" isFocused />,
    );
    await vi.waitFor(() => {
      expect(useTerminalStore.getState().instances.find((item) => item.id === instanceId)).toEqual(
        expect.objectContaining({ profile: "PowerShell", isFocused: true }),
      );
    });

    rerender(<TerminalView instanceId={instanceId} profile="WSL" syncGroup="" isFocused />);

    await vi.waitFor(() => {
      expect(useTerminalStore.getState().instances.find((item) => item.id === instanceId)).toEqual(
        expect.objectContaining({ profile: "WSL", isFocused: true }),
      );
    });
  });

  it("calls terminal.blur() when isFocused becomes false", async () => {
    const { rerender } = render(
      <TerminalView instanceId="t-blur" profile="PowerShell" syncGroup="" isFocused={true} />,
    );

    await waitForTerminalRendererOpen();

    mockBlur.mockClear();

    rerender(
      <TerminalView instanceId="t-blur" profile="PowerShell" syncGroup="" isFocused={false} />,
    );

    expect(mockBlur).toHaveBeenCalled();
  });

  // -- issue #530: helper textarea focus ownership across app blur/focus --

  /**
   * Mount a focused pane and attach a live helper textarea inside the pane
   * surface (the xterm mock never builds real DOM), then hand DOM focus to it.
   * The helper is attached before the ResizeObserver tick so the mount effect
   * adopts it (composition binding) exactly like the real xterm helper.
   */
  async function mountPaneWithFocusedHelper(instanceId: string) {
    const view = render(
      <TerminalView instanceId={instanceId} profile="PowerShell" syncGroup="" isFocused />,
    );
    const host = screen.getByTestId(`terminal-xterm-host-${instanceId}`);
    const terminal = createdTerminals.at(-1) as unknown as { element: HTMLDivElement };
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    terminal.element.appendChild(helper);
    host.appendChild(terminal.element);

    await waitForTerminalRendererOpen();

    helper.focus();
    expect(document.activeElement).toBe(helper);
    return { ...view, helper, wrapper: screen.getByTestId(`terminal-view-${instanceId}`) };
  }

  /** Alt-Tab away: window blur + the webview dropping DOM focus to body. */
  async function deactivateApp(helper: HTMLTextAreaElement) {
    await act(async () => {
      fireEvent(window, new Event("blur"));
      helper.blur();
    });
    expect(document.activeElement).toBe(document.body);
  }

  /**
   * Run the frame the controller schedules on window focus.
   *
   * `TerminalView` does not inject `scheduleFrame`, so the restore is queued on
   * `requestAnimationFrame`. jsdom implements that as a ~16ms timer, which a
   * `setTimeout(0)` flush never reaches — a negative assertion made after one
   * would pass simply because the frame had not run yet.
   */
  async function flushRestoreFrame() {
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => setTimeout(resolve, 0));
      });
    });
  }

  /** Reactivate the app and flush both the microtask and frame restore phases. */
  async function reactivateApp(duringFocus?: () => void) {
    await act(async () => {
      fireEvent(window, new Event("focus"));
      duringFocus?.();
    });
    await flushRestoreFrame();
  }

  it("restores the same helper textarea focus after app blur/focus", async () => {
    const { helper } = await mountPaneWithFocusedHelper("t-focus-ownership");
    await deactivateApp(helper);

    await act(async () => {
      fireEvent(window, new Event("focus"));
    });

    await vi.waitFor(() => {
      expect(document.activeElement).toBe(helper);
    });
  });

  it("refreshes the helper focus cycle when app deactivation leaves it DOM-active", async () => {
    const userAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    try {
      const { helper } = await mountPaneWithFocusedHelper("t-focus-ownership-stale-active");
      const relay = screen.getByTestId(
        "terminal-ime-focus-relay-t-focus-ownership-stale-active",
      ) as HTMLTextAreaElement;
      const focusEvents: string[] = [];
      const relayAccessibilityDuringFocus: Array<{
        disabled: boolean;
        ariaHidden: string | null;
        ariaLabel: string | null;
      }> = [];
      expect(relay).toBeDisabled();
      expect(relay).toHaveAttribute("aria-hidden", "true");
      expect(relay).toHaveAttribute("aria-label", "Terminal input focus relay");
      helper.addEventListener("blur", () => focusEvents.push("helper-blur"));
      helper.addEventListener("focus", () => focusEvents.push("helper-focus"));
      relay.addEventListener("focus", () => {
        focusEvents.push("relay-focus");
        relayAccessibilityDuringFocus.push({
          disabled: relay.disabled,
          ariaHidden: relay.getAttribute("aria-hidden"),
          ariaLabel: relay.getAttribute("aria-label"),
        });
      });
      relay.addEventListener("blur", () => focusEvents.push("relay-blur"));

      // WebView2 may detach the native IME context without changing
      // document.activeElement. A plain helper.focus() on return is then a no-op.
      await act(async () => {
        fireEvent(window, new Event("blur"));
      });
      expect(document.activeElement).toBe(helper);

      await reactivateApp();

      expect(focusEvents).toEqual(["helper-blur", "relay-focus", "relay-blur", "helper-focus"]);
      expect(relayAccessibilityDuringFocus).toEqual([
        { disabled: false, ariaHidden: null, ariaLabel: "Terminal input focus relay" },
      ]);
      expect(relay).toBeDisabled();
      expect(relay).toHaveAttribute("aria-hidden", "true");
      expect(document.activeElement).toBe(helper);
    } finally {
      userAgent.mockRestore();
    }
  });

  it("does not blur a synthetic IME composition started inside the focus task", async () => {
    const userAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64)");
    try {
      const instanceId = "t-focus-ownership-ime-same-task";
      const { helper, wrapper } = await mountPaneWithFocusedHelper(instanceId);
      const focusEvents: string[] = [];
      helper.addEventListener("blur", () => focusEvents.push("blur"));
      helper.addEventListener("focus", () => focusEvents.push("focus"));

      await act(async () => {
        fireEvent(window, new Event("blur"));
        fireEvent(window, new Event("focus"));
        helper.value = "ㄱ";
        helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
        helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ㄱ" }));
        helper.dispatchEvent(new Event("input", { bubbles: true }));
      });

      await flushRestoreFrame();

      expect(focusEvents).toEqual([]);
      expect(document.activeElement).toBe(helper);
      expect(helper.value).toBe("ㄱ");
      expect(wrapper).toHaveClass("terminal-ime-composition-active");

      mockWriteToTerminal.mockClear();
      const terminal = createdTerminals.at(-1)!;
      await act(async () => {
        helper.dispatchEvent(new CompositionEvent("compositionend", { data: "가" }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        terminal.emitCoreData("가", true);
      });
      expect(mockWriteToTerminal).toHaveBeenCalledTimes(1);
      expect(mockWriteToTerminal).toHaveBeenCalledWith(instanceId, "가");
    } finally {
      userAgent.mockRestore();
    }
  });

  it("does not cycle a DOM-active helper on Linux", async () => {
    const userAgent = vi
      .spyOn(window.navigator, "userAgent", "get")
      .mockReturnValue("Mozilla/5.0 (X11; Linux x86_64)");
    try {
      const { helper } = await mountPaneWithFocusedHelper("t-focus-ownership-linux-active");
      const focusEvents: string[] = [];
      helper.addEventListener("blur", () => focusEvents.push("blur"));
      helper.addEventListener("focus", () => focusEvents.push("focus"));

      await act(async () => {
        fireEvent(window, new Event("blur"));
      });
      await reactivateApp();

      expect(focusEvents).toEqual([]);
      expect(document.activeElement).toBe(helper);
    } finally {
      userAgent.mockRestore();
    }
  });

  it("keeps the first IME composition after reactivation on the restored helper", async () => {
    const { helper, wrapper } = await mountPaneWithFocusedHelper("t-focus-ownership-ime");
    await deactivateApp(helper);

    await act(async () => {
      fireEvent(window, new Event("focus"));
    });
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(helper);
    });

    // First Korean composition after coming back must reach this pane's
    // composition pipeline (the restored helper is the bound one).
    await act(async () => {
      helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      helper.value = "가";
      helper.selectionStart = 1;
      helper.selectionEnd = 1;
      helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "가" }));
      helper.dispatchEvent(new Event("input"));
    });

    await vi.waitFor(() => {
      expect(wrapper).toHaveClass("terminal-ime-composition-active");
    });
  });

  it("does not steal focus back when another element gained it during reactivation", async () => {
    const { helper } = await mountPaneWithFocusedHelper("t-focus-ownership-steal");
    const searchInput = document.createElement("input");
    document.body.appendChild(searchInput);
    await deactivateApp(helper);

    await reactivateApp(() => searchInput.focus());

    expect(document.activeElement).toBe(searchInput);

    // Positive control: the same flush restores when nothing competes, so the
    // assertion above is about the guard and not about an unrun frame.
    searchInput.remove();
    helper.focus();
    await deactivateApp(helper);
    await reactivateApp();
    expect(document.activeElement).toBe(helper);
  });

  it("drops helper ownership when the pane loses focus while the app is inactive", async () => {
    const { helper, rerender } = await mountPaneWithFocusedHelper("t-focus-ownership-unfocus");
    await deactivateApp(helper);

    rerender(
      <TerminalView
        instanceId="t-focus-ownership-unfocus"
        profile="PowerShell"
        syncGroup=""
        isFocused={false}
      />,
    );

    await reactivateApp();

    expect(document.activeElement).toBe(document.body);

    // Positive control: with the pane focused again the same sequence restores,
    // so the assertion above is about `clear("pane-unfocused")`.
    rerender(
      <TerminalView instanceId="t-focus-ownership-unfocus" profile="PowerShell" syncGroup="" />,
    );
    helper.focus();
    await deactivateApp(helper);
    await reactivateApp();
    expect(document.activeElement).toBe(helper);
  });

  it("restores after a webview that blanks DOM focus before window blur", async () => {
    // The other ordering: `focusout` with no `relatedTarget` lands first and the
    // active element is already `body` by the time window `blur` arrives.
    const { helper } = await mountPaneWithFocusedHelper("t-focus-ownership-early-blank");

    await act(async () => {
      helper.blur();
      fireEvent(window, new Event("blur"));
    });
    expect(document.activeElement).toBe(document.body);

    await reactivateApp();
    expect(document.activeElement).toBe(helper);
  });

  it("does not adopt a helper whose focusout handed focus to another element", async () => {
    await mountPaneWithFocusedHelper("t-focus-ownership-handoff");
    const composer = document.createElement("input");
    document.body.appendChild(composer);

    // Focus moves helper -> composer, then the app is deactivated. The pane owns
    // nothing, so reactivation must not pull focus back into the terminal.
    await act(async () => {
      composer.focus();
    });
    await act(async () => {
      composer.blur();
      fireEvent(window, new Event("blur"));
    });
    expect(document.activeElement).toBe(document.body);

    await reactivateApp();
    expect(document.activeElement).toBe(document.body);
    composer.remove();
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
    await waitForLocalTerminalControl();

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
    await waitForLocalTerminalControl();

    // Regular key should pass through
    const event = new KeyboardEvent("keydown", { key: "a" });
    const result = capturedKeyHandler!(event);
    expect(result).toBe(true);
    expect(mockSmartPaste).not.toHaveBeenCalled();
  });

  // -- terminal.osInputSourceSwitch (issue #533) --

  describe("OS input source switch chord", () => {
    function keyEvent(
      type: "keydown" | "keypress" | "keyup",
      init: { key: string; code: string; shiftKey?: boolean; ctrlKey?: boolean },
    ): KeyboardEvent {
      const event = new KeyboardEvent(type, {
        key: init.key,
        code: init.code,
        shiftKey: !!init.shiftKey,
        ctrlKey: !!init.ctrlKey,
      });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });
      return event;
    }

    function bindChord(keys: string) {
      useSettingsStore.setState({
        keybindings: [{ keys, command: "terminal.osInputSourceSwitch" }],
      });
    }

    async function mountForChord(instanceId: string) {
      render(<TerminalView instanceId={instanceId} profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => {
        expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
        expect(mockCreateTerminalSession).toHaveBeenCalled();
      });
      await waitForLocalTerminalControl();
      expect(capturedKeyHandler).not.toBeNull();
    }

    it("leaves the whole Shift+Space sequence with the terminal when unassigned", async () => {
      // Default is deliberately unassigned, so terminal input must be untouched.
      await mountForChord("t-chord-unassigned");

      const down = keyEvent("keydown", { key: " ", code: "Space", shiftKey: true });
      const press = keyEvent("keypress", { key: " ", code: "Space", shiftKey: true });
      const up = keyEvent("keyup", { key: " ", code: "Space", shiftKey: true });

      expect(capturedKeyHandler!(down)).toBe(true);
      expect(capturedKeyHandler!(press)).toBe(true);
      expect(capturedKeyHandler!(up)).toBe(true);
      expect(down.preventDefault).not.toHaveBeenCalled();
    });

    it("blocks keydown, keypress and keyup of a bound chord without preventDefault", async () => {
      bindChord("Shift+Space");
      await mountForChord("t-chord-bound");

      const down = keyEvent("keydown", { key: " ", code: "Space", shiftKey: true });
      const press = keyEvent("keypress", { key: " ", code: "Space", shiftKey: true });
      const up = keyEvent("keyup", { key: " ", code: "Space", shiftKey: true });

      // false = xterm never sees it, so no PTY byte is produced.
      expect(capturedKeyHandler!(down)).toBe(false);
      expect(capturedKeyHandler!(press)).toBe(false);
      expect(capturedKeyHandler!(up)).toBe(false);
      // The OS must still perform the input-source switch.
      expect(down.preventDefault).not.toHaveBeenCalled();
      expect(press.preventDefault).not.toHaveBeenCalled();
      expect(up.preventDefault).not.toHaveBeenCalled();
    });

    it("keeps blocking when the modifier is released before the chord key", async () => {
      // The DOM always emits the modifier's own keyup. Treating that as "another
      // key released" disarmed the guard and let the Space companions reach the
      // PTY — the exact symptom issue #533 is about.
      bindChord("Shift+Space");
      await mountForChord("t-chord-modifier-first");

      capturedKeyHandler!(keyEvent("keydown", { key: "Shift", code: "ShiftLeft", shiftKey: true }));
      expect(
        capturedKeyHandler!(keyEvent("keydown", { key: " ", code: "Space", shiftKey: true })),
      ).toBe(false);

      // Shift goes up first: not ours to block, and not a release signal.
      expect(capturedKeyHandler!(keyEvent("keyup", { key: "Shift", code: "ShiftLeft" }))).toBe(
        true,
      );

      // The rest of the chord press is still swallowed.
      expect(capturedKeyHandler!(keyEvent("keypress", { key: " ", code: "Space" }))).toBe(false);
      expect(capturedKeyHandler!(keyEvent("keyup", { key: " ", code: "Space" }))).toBe(false);
    });

    it("keeps blocking through auto-repeat after the modifier is released", async () => {
      bindChord("Shift+Space");
      await mountForChord("t-chord-repeat");

      expect(
        capturedKeyHandler!(keyEvent("keydown", { key: " ", code: "Space", shiftKey: true })),
      ).toBe(false);
      // Holding Space and letting go of Shift repeats the keydown without shift.
      const repeat = keyEvent("keydown", { key: " ", code: "Space" });
      Object.defineProperty(repeat, "repeat", { value: true });
      expect(capturedKeyHandler!(repeat)).toBe(false);
      expect(capturedKeyHandler!(keyEvent("keypress", { key: " ", code: "Space" }))).toBe(false);
    });

    it("does not cancel an IME commit that overlaps the chord press", async () => {
      // A Korean IME can commit the in-flight syllable when the toggle is hit.
      // Cancelling that insertion would delete the user's text.
      bindChord("Shift+Space");

      render(<TerminalView instanceId="t-chord-imecommit" profile="PowerShell" syncGroup="" />);
      const host = screen.getByTestId("terminal-xterm-host-t-chord-imecommit");
      const terminal = createdTerminals.at(-1) as unknown as { element: HTMLDivElement };
      const helper = document.createElement("textarea");
      helper.className = "xterm-helper-textarea";
      terminal.element.appendChild(helper);
      host.appendChild(terminal.element);

      await vi.waitFor(() => {
        expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
        expect(mockCreateTerminalSession).toHaveBeenCalled();
      });
      await waitForLocalTerminalControl();

      capturedKeyHandler!(keyEvent("keydown", { key: " ", code: "Space", shiftKey: true }));

      const commit = new Event("beforeinput", { cancelable: true, bubbles: true });
      Object.defineProperty(commit, "isComposing", { value: false });
      Object.defineProperty(commit, "inputType", { value: "insertText" });
      Object.defineProperty(commit, "data", { value: "가" });
      helper.dispatchEvent(commit);
      expect(commit.defaultPrevented).toBe(false);

      // The chord's own character is still cancelled.
      const leak = new Event("beforeinput", { cancelable: true, bubbles: true });
      Object.defineProperty(leak, "isComposing", { value: false });
      Object.defineProperty(leak, "inputType", { value: "insertText" });
      Object.defineProperty(leak, "data", { value: " " });
      helper.dispatchEvent(leak);
      expect(leak.defaultPrevented).toBe(true);
    });

    it("keeps an ordinary Space typed after the chord", async () => {
      bindChord("Shift+Space");
      await mountForChord("t-chord-then-space");

      capturedKeyHandler!(keyEvent("keydown", { key: " ", code: "Space", shiftKey: true }));
      capturedKeyHandler!(keyEvent("keyup", { key: " ", code: "Space", shiftKey: true }));

      // A plain Space is a different combo and must reach the shell.
      expect(capturedKeyHandler!(keyEvent("keydown", { key: " ", code: "Space" }))).toBe(true);
      expect(capturedKeyHandler!(keyEvent("keypress", { key: " ", code: "Space" }))).toBe(true);
    });

    it("keeps a plain Shift+Space when a different chord is bound", async () => {
      bindChord("Ctrl+Space");
      await mountForChord("t-chord-other");

      expect(
        capturedKeyHandler!(keyEvent("keydown", { key: " ", code: "Space", shiftKey: true })),
      ).toBe(true);
      expect(
        capturedKeyHandler!(keyEvent("keypress", { key: " ", code: "Space", shiftKey: true })),
      ).toBe(true);
    });

    it("blocks the non-composition text insertion from the bound chord", async () => {
      bindChord("Shift+Space");

      // The helper must exist before the view binds it, same as the focus
      // ownership tests above.
      render(<TerminalView instanceId="t-chord-textinput" profile="PowerShell" syncGroup="" />);
      const host = screen.getByTestId("terminal-xterm-host-t-chord-textinput");
      const terminal = createdTerminals.at(-1) as unknown as { element: HTMLDivElement };
      const helper = document.createElement("textarea");
      helper.className = "xterm-helper-textarea";
      terminal.element.appendChild(helper);
      host.appendChild(terminal.element);

      await vi.waitFor(() => {
        expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
        expect(mockCreateTerminalSession).toHaveBeenCalled();
      });
      await waitForLocalTerminalControl();

      capturedKeyHandler!(keyEvent("keydown", { key: " ", code: "Space", shiftKey: true }));

      const insertion = new Event("beforeinput", { cancelable: true, bubbles: true });
      Object.defineProperty(insertion, "isComposing", { value: false });
      Object.defineProperty(insertion, "inputType", { value: "insertText" });
      Object.defineProperty(insertion, "data", { value: " " });
      helper.dispatchEvent(insertion);
      expect(insertion.defaultPrevented).toBe(true);

      // Composition input is the IME's and must survive.
      const composing = new Event("beforeinput", { cancelable: true, bubbles: true });
      Object.defineProperty(composing, "isComposing", { value: true });
      Object.defineProperty(composing, "inputType", { value: "insertCompositionText" });
      helper.dispatchEvent(composing);
      expect(composing.defaultPrevented).toBe(false);

      // After the press ends, insertions flow again.
      capturedKeyHandler!(keyEvent("keyup", { key: " ", code: "Space", shiftKey: true }));
      const after = new Event("beforeinput", { cancelable: true, bubbles: true });
      Object.defineProperty(after, "isComposing", { value: false });
      Object.defineProperty(after, "inputType", { value: "insertText" });
      Object.defineProperty(after, "data", { value: " " });
      helper.dispatchEvent(after);
      expect(after.defaultPrevented).toBe(false);
    });

    it("releases the guard when a different physical key arrives", async () => {
      bindChord("Shift+Space");
      await mountForChord("t-chord-otherkey");

      capturedKeyHandler!(keyEvent("keydown", { key: " ", code: "Space", shiftKey: true }));
      // The other key is not swallowed...
      expect(capturedKeyHandler!(keyEvent("keydown", { key: "a", code: "KeyA" }))).toBe(true);
      // ...and the abandoned press stops swallowing its companions.
      expect(capturedKeyHandler!(keyEvent("keypress", { key: "a", code: "KeyA" }))).toBe(true);
    });
  });

  // -- native IME candidate window anchor (issue #532) --

  describe("native IME candidate window anchor", () => {
    /**
     * Build a pane whose DOM matches what xterm produces: a `.xterm-screen`
     * containing the render canvas and the helper textarea. jsdom reports zero
     * rects, so both are stubbed — the geometry itself is covered by
     * `ime-anchor.test.ts`; here we only assert the wiring and the restore.
     */
    async function mountPaneWithScreen(instanceId: string) {
      render(<TerminalView instanceId={instanceId} profile="PowerShell" syncGroup="" isFocused />);
      const host = screen.getByTestId(`terminal-xterm-host-${instanceId}`);
      const terminal = createdTerminals.at(-1) as unknown as { element: HTMLDivElement };

      const screenEl = document.createElement("div");
      screenEl.className = "xterm-screen";
      const canvas = document.createElement("canvas");
      const helper = document.createElement("textarea");
      helper.className = "xterm-helper-textarea";
      screenEl.appendChild(canvas);
      screenEl.appendChild(helper);
      terminal.element.appendChild(screenEl);
      host.appendChild(terminal.element);

      const rect = (left: number, top: number, width: number, height: number) =>
        ({
          left,
          top,
          width,
          height,
          right: left + width,
          bottom: top + height,
          x: left,
          y: top,
          toJSON: () => ({}),
        }) as DOMRect;
      // 80x25 grid over an 800x400 canvas → 10x16 cells.
      canvas.getBoundingClientRect = () => rect(0, 0, 800, 400);
      screenEl.getBoundingClientRect = () => rect(0, 0, 800, 400);

      // The overlay caret path only runs for a stabilized interactive app —
      // same setup the existing shadow-cursor/IME overlay tests use.
      act(() => {
        useTerminalStore.getState().updateInstanceInfo(instanceId, {
          activity: { type: "interactiveApp", name: "Codex" },
        });
      });

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
      });
      return { helper, screenEl };
    }

    /** Drive a composition so the preview owns the caret. */
    function startComposition(helper: HTMLTextAreaElement) {
      helper.focus();
      helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      helper.value = "가";
      helper.selectionStart = 1;
      helper.selectionEnd = 1;
      helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "가" }));
      helper.dispatchEvent(new Event("input"));
    }

    afterEach(() => {
      mockBufferActive.cursorX = 0;
      mockBufferActive.cursorY = 0;
      mockBufferActive.baseY = 0;
      mockBufferActive.viewportY = 0;
    });

    it("leaves the helper where xterm put it while no composition is active", async () => {
      const { helper } = await mountPaneWithScreen("t-anchor-idle");
      expect(helper.style.left).toBe("");
      expect(helper.style.top).toBe("");
    });

    it("moves the helper to the composition anchor when the cursors diverge, then restores", async () => {
      const { helper } = await mountPaneWithScreen("t-anchor-diverge");
      // xterm placed the helper on the public buffer cursor. Distinct values so
      // both the move and the restore are observable.
      helper.style.left = "400px";
      helper.style.top = "320px";
      // A TUI repaint parked the public cursor on the footer row; the shadow
      // cursor (and therefore the composition anchor) is still at 0,0.
      //
      // Drive the DEC 2026 frame that actually produces that state instead of
      // assuming it: the frame open snapshots the true input position, the TUI
      // parks the public cursor, the frame close makes the snapshot authoritative
      // (`hasSyncFramePosition`). That flag is what `computeUseShadowCursor` reads,
      // and the real Codex trace in issue #551 shows it set here. Without it the
      // shadow cursor is not trustworthy and the buffer cursor is the better anchor.
      //
      // Assert the handler is there: the call below is optional-chained, so a change
      // in the registration key would make it a silent no-op and this test would
      // fail as "helper at the wrong pixel" instead of naming the real cause.
      expect(csiHandlers.get("?:h")).toBeTypeOf("function");
      expect(csiHandlers.get("?:l")).toBeTypeOf("function");
      mockBufferActive.cursorX = 0;
      mockBufferActive.cursorY = 0;
      await act(async () => {
        await csiHandlers.get("?:h")?.([2026]);
      });
      mockBufferActive.cursorX = 40;
      mockBufferActive.cursorY = 20;
      await act(async () => {
        await csiHandlers.get("?:l")?.([2026]);
      });

      startComposition(helper);

      // Moved onto the **composition caret** cell, which is the same cell the
      // preview paints its caret on — the shared anchor contract. The composition
      // is a 2-cell Hangul syllable starting at column 0, so the caret is at
      // column 2 → 2 * 10px cell width. Row 0 → top 0.
      await vi.waitFor(() => {
        expect(helper.style.left).toBe("20px");
        expect(helper.style.top).toBe("0px");
      });

      helper.dispatchEvent(new CompositionEvent("compositionend", { data: "가" }));

      // Restored to xterm own inline values — never left at the moved offset.
      await vi.waitFor(() => {
        expect(helper.style.left).toBe("400px");
        expect(helper.style.top).toBe("320px");
      });
    });

    it("does not move the helper when the two cursors agree", async () => {
      const { helper } = await mountPaneWithScreen("t-anchor-agree");
      // xterm own placement, deliberately NOT the anchor pixel so a stray move
      // would be visible.
      helper.style.left = "0px";
      helper.style.top = "0px";
      // Same DEC 2026 frame as the diverging case, so the shadow cursor at 0,0 is
      // the authoritative anchor (see that test for why the frame is driven, and why
      // the handlers are asserted rather than optional-chained blindly).
      expect(csiHandlers.get("?:h")).toBeTypeOf("function");
      expect(csiHandlers.get("?:l")).toBeTypeOf("function");
      mockBufferActive.cursorX = 0;
      mockBufferActive.cursorY = 0;
      await act(async () => {
        await csiHandlers.get("?:h")?.([2026]);
      });
      // Public cursor already sits on the composition caret cell (column 2 —
      // after the 2-cell Hangul syllable), so there is nothing to correct.
      mockBufferActive.cursorX = 2;
      mockBufferActive.cursorY = 0;
      await act(async () => {
        await csiHandlers.get("?:l")?.([2026]);
      });

      startComposition(helper);
      // Give the overlay update the same number of frames the diverging case
      // needed, so "no move" is a real observation and not just an early read.
      await act(async () => {
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => setTimeout(resolve, 0));
        });
      });

      expect(helper.style.left).toBe("0px");
      expect(helper.style.top).toBe("0px");
    });
  });

  // -- Linux IME candidate key guard (issue #528) --

  describe("Linux IME candidate key guard", () => {
    function keyEvent(
      type: "keydown" | "keypress" | "keyup",
      init: { key: string; code: string; keyCode: number },
    ): KeyboardEvent {
      const event = new KeyboardEvent(type, { key: init.key, code: init.code });
      // jsdom ignores `keyCode` in the event init, and `keyCode === 229` is the
      // IME-consumed marker the guard keys off — define it explicitly.
      Object.defineProperty(event, "keyCode", { value: init.keyCode });
      Object.defineProperty(event, "preventDefault", { value: vi.fn() });
      return event;
    }

    /** Mount with a helper textarea attached and a spoofed user agent. */
    async function mountWithHelper(instanceId: string, ua: string) {
      const userAgent = vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ua);
      render(<TerminalView instanceId={instanceId} profile="PowerShell" syncGroup="" />);
      const host = screen.getByTestId(`terminal-xterm-host-${instanceId}`);
      const terminal = createdTerminals.at(-1) as unknown as { element: HTMLDivElement };
      const helper = document.createElement("textarea");
      helper.className = "xterm-helper-textarea";
      terminal.element.appendChild(helper);
      host.appendChild(terminal.element);

      await vi.waitFor(() => {
        expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
      });
      await waitForLocalTerminalControl();
      expect(capturedKeyHandler).not.toBeNull();

      if (ua.includes("Linux")) {
        // Helper binding (and with it the guard's composition listeners) happens
        // asynchronously after the terminal opens. Probe until the wiring is
        // live, then close the probe window so the test starts from a clean
        // state — otherwise the first test in this block races the binding.
        await vi.waitFor(() => {
          helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
          helper.dispatchEvent(new CompositionEvent("compositionend", { data: "x" }));
          const probe = keyEvent("keyup", { key: " ", code: "Space", keyCode: 229 });
          expect(capturedKeyHandler!(probe)).toBe(false);
        });
        helper.dispatchEvent(new Event("blur"));
      }
      return { helper, userAgent };
    }

    /** Composition that ends by picking a candidate. */
    function runComposition(helper: HTMLTextAreaElement) {
      helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ni" }));
      helper.dispatchEvent(new CompositionEvent("compositionend", { data: "你" }));
    }

    const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";
    const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

    it("blocks the IME-consumed candidate trio on Linux without touching the PTY", async () => {
      const { helper, userAgent } = await mountWithHelper("t-cand-linux", LINUX_UA);
      try {
        runComposition(helper);

        const down = keyEvent("keydown", { key: " ", code: "Space", keyCode: 229 });
        const press = keyEvent("keypress", { key: " ", code: "Space", keyCode: 229 });
        const up = keyEvent("keyup", { key: " ", code: "Space", keyCode: 229 });

        expect(capturedKeyHandler!(down)).toBe(false);
        expect(capturedKeyHandler!(press)).toBe(false);
        expect(capturedKeyHandler!(up)).toBe(false);
        // Only the events that could insert into the textarea are cancelled.
        expect(down.preventDefault).toHaveBeenCalled();
        expect(press.preventDefault).toHaveBeenCalled();
        expect(up.preventDefault).not.toHaveBeenCalled();
      } finally {
        userAgent.mockRestore();
      }
    });

    it("blocks an orphan digit keyup on Linux", async () => {
      const { helper, userAgent } = await mountWithHelper("t-cand-orphan", LINUX_UA);
      try {
        runComposition(helper);
        const up = keyEvent("keyup", { key: "2", code: "Digit2", keyCode: 50 });
        expect(capturedKeyHandler!(up)).toBe(false);
      } finally {
        userAgent.mockRestore();
      }
    });

    it("keeps a real Space the user types right after confirming", async () => {
      const { helper, userAgent } = await mountWithHelper("t-cand-real", LINUX_UA);
      try {
        runComposition(helper);
        // A genuine press: own keyCode, and it starts with a keydown.
        const down = keyEvent("keydown", { key: " ", code: "Space", keyCode: 32 });
        expect(capturedKeyHandler!(down)).toBe(true);
        expect(down.preventDefault).not.toHaveBeenCalled();
        expect(
          capturedKeyHandler!(keyEvent("keypress", { key: " ", code: "Space", keyCode: 32 })),
        ).toBe(true);
        expect(
          capturedKeyHandler!(keyEvent("keyup", { key: " ", code: "Space", keyCode: 32 })),
        ).toBe(true);
      } finally {
        userAgent.mockRestore();
      }
    });

    it("keeps the window open across the composition commit input", async () => {
      // Chromium can deliver the commit beforeinput/input AFTER compositionend,
      // where isComposing is already false. Reading that as "the user typed
      // something new" closed the window in the frame it opened and made this
      // guard a no-op on exactly the platforms it targets.
      const { helper, userAgent } = await mountWithHelper("t-cand-commit", LINUX_UA);
      try {
        runComposition(helper);

        const commit = new Event("input", { bubbles: true });
        Object.defineProperty(commit, "isComposing", { value: false });
        Object.defineProperty(commit, "inputType", { value: "insertFromComposition" });
        helper.dispatchEvent(commit);

        // Window still open: the candidate tail is blocked.
        expect(
          capturedKeyHandler!(keyEvent("keyup", { key: " ", code: "Space", keyCode: 229 })),
        ).toBe(false);
      } finally {
        userAgent.mockRestore();
      }
    });

    it("closes the window on a real text insertion", async () => {
      const { helper, userAgent } = await mountWithHelper("t-cand-input", LINUX_UA);
      try {
        runComposition(helper);
        const insertion = new Event("input", { bubbles: true });
        Object.defineProperty(insertion, "isComposing", { value: false });
        Object.defineProperty(insertion, "inputType", { value: "insertText" });
        helper.dispatchEvent(insertion);
        // Window closed: even an IME-marked leftover now reaches the terminal.
        expect(
          capturedKeyHandler!(keyEvent("keyup", { key: " ", code: "Space", keyCode: 229 })),
        ).toBe(true);
      } finally {
        userAgent.mockRestore();
      }
    });

    it("does nothing on Windows — Korean input is unaffected", async () => {
      const { helper, userAgent } = await mountWithHelper("t-cand-windows", WINDOWS_UA);
      try {
        // This assertion is deliberately about the wiring in `TerminalView`;
        // that the guard itself blocks nothing when disabled is covered
        // exhaustively at unit level (every fixture replayed with
        // `enabled: false` blocks nothing).
        helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
        helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "가" }));
        helper.dispatchEvent(new CompositionEvent("compositionend", { data: "가" }));

        // The exact sequence that is blocked on Linux must pass here.
        const down = keyEvent("keydown", { key: " ", code: "Space", keyCode: 229 });
        expect(capturedKeyHandler!(down)).toBe(true);
        expect(down.preventDefault).not.toHaveBeenCalled();
        expect(
          capturedKeyHandler!(keyEvent("keyup", { key: " ", code: "Space", keyCode: 229 })),
        ).toBe(true);
      } finally {
        userAgent.mockRestore();
      }
    });

    it("does not open a window for an empty compositionupdate", async () => {
      const { helper, userAgent } = await mountWithHelper("t-cand-empty", LINUX_UA);
      try {
        helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
        helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "" }));
        // Still composing — xterm's own guard owns this key, so it passes here.
        expect(
          capturedKeyHandler!(keyEvent("keydown", { key: " ", code: "Space", keyCode: 229 })),
        ).toBe(true);
      } finally {
        userAgent.mockRestore();
      }
    });
  });

  // -- terminal.copy keybinding --

  it("Ctrl+C with selection copies via clipboardWriteText (smartRemoveIndent default on)", async () => {
    mockHasSelection.mockReturnValue(true);
    mockGetSelection.mockReturnValue("copied text");

    render(<TerminalView instanceId="t-copy1" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockAttachCustomKeyEventHandler).toHaveBeenCalled();
    });
    await waitForLocalTerminalControl();

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
    await waitForLocalTerminalControl();

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
    await waitForLocalTerminalControl();

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

  it("validates a selected path only once after the pointer drag ends", async () => {
    mockGetSelection.mockReturnValue(String.raw`C:\work\src\main.ts`);
    mockGetSelectionPosition.mockReturnValue({
      start: { x: 0, y: 0 },
      end: { x: 19, y: 0 },
    });
    mockStatPaths.mockResolvedValue([{ exists: true, isDirectory: false }]);

    render(
      <TerminalView instanceId="t-path-selection-release" profile="PowerShell" syncGroup="" />,
    );

    const outer = screen.getByTestId("terminal-view-t-path-selection-release");
    outer.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, clientX: 0, clientY: 0 }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 30, clientY: 0 }),
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    expect(mockStatPaths).not.toHaveBeenCalled();

    // Browser order is pointerup, then xterm's document mouseup finalizes the
    // selection and fires onSelectionChange, then mouseup reaches window.
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 30, clientY: 0 }),
    );
    const selectionCallback = mockOnSelectionChange.mock.calls[0][0];
    selectionCallback();
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 30, clientY: 0 }));

    await vi.waitFor(() => {
      expect(mockStatPaths).toHaveBeenCalledTimes(1);
      expect(outer).toHaveClass("terminal-path-link-clickable");
    });
    expect(mockStatPaths).toHaveBeenCalledWith([String.raw`C:\work\src\main.ts`]);
  });

  it("invalidates the previous path link as soon as a new pointer drag moves", async () => {
    mockGetSelection.mockReturnValue(String.raw`C:\work\src\main.ts`);
    mockGetSelectionPosition.mockReturnValue({
      start: { x: 0, y: 0 },
      end: { x: 19, y: 0 },
    });
    mockStatPaths.mockResolvedValue([{ exists: true, isDirectory: false }]);

    render(
      <TerminalView instanceId="t-path-selection-reselect" profile="PowerShell" syncGroup="" />,
    );

    const outer = screen.getByTestId("terminal-view-t-path-selection-reselect");
    const selectionCallback = mockOnSelectionChange.mock.calls[0][0];
    outer.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 2, clientX: 0, clientY: 0 }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 2, clientX: 30, clientY: 0 }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 2, clientX: 30, clientY: 0 }),
    );
    selectionCallback();
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 30, clientY: 0 }));

    await vi.waitFor(() => expect(outer).toHaveClass("terminal-path-link-clickable"));

    outer.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 3, clientX: 0, clientY: 0 }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 3, clientX: 30, clientY: 0 }),
    );

    expect(outer).not.toHaveClass("terminal-path-link-clickable");
    window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 3 }));
  });

  it("discards an in-flight path stat when a new pointer gesture starts", async () => {
    mockGetSelection.mockReturnValue(String.raw`C:\work\src\main.ts`);
    mockGetSelectionPosition.mockReturnValue({
      start: { x: 0, y: 0 },
      end: { x: 19, y: 0 },
    });
    let resolveStat:
      | ((value: Array<{ exists: boolean; isDirectory: boolean }>) => void)
      | undefined;
    mockStatPaths.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveStat = resolve;
        }),
    );

    render(<TerminalView instanceId="t-path-selection-stale" profile="PowerShell" syncGroup="" />);

    const outer = screen.getByTestId("terminal-view-t-path-selection-stale");
    const selectionCallback = mockOnSelectionChange.mock.calls[0][0];
    outer.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 5, clientX: 0, clientY: 0 }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 5, clientX: 30, clientY: 0 }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 5, clientX: 30, clientY: 0 }),
    );
    selectionCallback();
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 30, clientY: 0 }));
    expect(mockStatPaths).toHaveBeenCalledTimes(1);

    outer.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 6, clientX: 0, clientY: 0 }),
    );
    await act(async () => {
      resolveStat?.([{ exists: true, isDirectory: false }]);
      await Promise.resolve();
    });

    expect(outer).not.toHaveClass("terminal-path-link-clickable");
    window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 6 }));
  });

  // -- ADR-0188: 포인터 지점(point) 트리거 — hover dwell 과 이동 없는 클릭 --

  it("validates the token under a stopped pointer once (hover dwell)", async () => {
    // 화면: "cat C:\work\src\main.ts" — 토큰은 셀 5~23.
    setMockBufferLine(String.raw`cat C:\work\src\main.ts`);
    mockGetSelection.mockReturnValue("");
    mockStatPaths.mockResolvedValue([{ exists: true, isDirectory: false }]);

    render(<TerminalView instanceId="t-path-hover-dwell" profile="PowerShell" syncGroup="" />);

    const outer = screen.getByTestId("terminal-view-t-path-hover-dwell");
    // clientX 100 → 셀 11(토큰 안), clientY 0 → 뷰포트 첫 행.
    outer.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 100, clientY: 0 }));

    // dwell 이 끝나기 전에는 조회가 없다.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(mockStatPaths).not.toHaveBeenCalled();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    await vi.waitFor(() => {
      expect(mockStatPaths).toHaveBeenCalledTimes(1);
    });
    expect(mockStatPaths).toHaveBeenCalledWith([String.raw`C:\work\src\main.ts`]);
    expect(outer).toHaveClass("terminal-path-link-clickable");
  });

  it("keeps a verified path decoration through a split synchronized-output repaint", async () => {
    const originalLine = String.raw`cat C:\work\src\main.ts`;
    setMockBufferLine(originalLine);
    mockGetSelection.mockReturnValue("");
    mockStatPaths.mockResolvedValue([{ exists: true, isDirectory: false }]);

    render(<TerminalView instanceId="t-path-sync-frame" profile="PowerShell" syncGroup="" />);

    const outer = screen.getByTestId("terminal-view-t-path-sync-frame");
    outer.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 100, clientY: 0 }));
    await vi.waitFor(
      () => {
        expect(mockStatPaths).toHaveBeenCalledTimes(1);
        expect(mockPathLinkDecorations).toHaveLength(1);
      },
      { timeout: 2_000 },
    );
    const originalDecoration = mockPathLinkDecorations[0];
    expect(originalDecoration.element.isConnected).toBe(true);

    // Codex can split one DEC 2026 repaint across PTY output chunks. xterm's
    // buffer already contains this cleared intermediate row, while the renderer
    // deliberately continues showing the previous complete frame.
    mockModes.synchronizedOutputMode = true;
    await act(async () => {
      await csiHandlers.get("?:h")?.([2026]);
    });
    setMockBufferLine("");
    const writeParsed = mockOnWriteParsed.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    act(() => writeParsed?.());

    expect(originalDecoration.dispose).not.toHaveBeenCalled();
    expect(originalDecoration.element.isConnected).toBe(true);
    expect(outer).toHaveClass("terminal-path-link-clickable");

    // The closing chunk restores the same path before DEC 2026 reset. The
    // stable-frame validation must retain the exact decoration, not recreate it.
    setMockBufferLine(originalLine);
    mockModes.synchronizedOutputMode = false;
    await act(async () => {
      await csiHandlers.get("?:l")?.([2026]);
    });
    act(() => writeParsed?.());

    expect(originalDecoration.dispose).not.toHaveBeenCalled();
    expect(mockPathLinkDecorations).toEqual([originalDecoration]);
    expect(originalDecoration.element.isConnected).toBe(true);
  });

  it("settles deferred path validation when synchronized output times out", async () => {
    const originalLine = String.raw`cat C:\work\src\main.ts`;
    setMockBufferLine(originalLine);
    mockGetSelection.mockReturnValue("");
    mockStatPaths.mockResolvedValue([{ exists: true, isDirectory: false }]);

    render(<TerminalView instanceId="t-path-sync-timeout" profile="PowerShell" syncGroup="" />);

    const outer = screen.getByTestId("terminal-view-t-path-sync-timeout");
    outer.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 100, clientY: 0 }));
    await vi.waitFor(
      () => {
        expect(mockStatPaths).toHaveBeenCalledTimes(1);
        expect(mockPathLinkDecorations).toHaveLength(1);
      },
      { timeout: 2_000 },
    );
    const originalDecoration = mockPathLinkDecorations[0];

    mockModes.synchronizedOutputMode = true;
    await act(async () => {
      await csiHandlers.get("?:h")?.([2026]);
    });
    setMockBufferLine("");
    const writeParsed = mockOnWriteParsed.mock.calls.at(-1)?.[0] as (() => void) | undefined;
    act(() => writeParsed?.());
    expect(originalDecoration.dispose).not.toHaveBeenCalled();

    // A write that opened synchronized output arms TerminalView's mode monitor.
    // The xterm mock does not parse bytes, so the parser hook above establishes
    // the matching component state explicitly.
    await vi.waitFor(() => expect(mockOnTerminalOutput).toHaveBeenCalled());
    const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
      | ((data: Uint8Array) => void)
      | undefined;
    act(() => onOutput?.(new TextEncoder().encode("\x1b[?2026hframe")));
    await vi.waitFor(() => expect(mockWrite).toHaveBeenCalled());

    // xterm releases a malformed/open frame after its safety timeout without a
    // parser reset or another onWriteParsed event. The mode monitor owns this
    // final stable-buffer comparison.
    mockModes.synchronizedOutputMode = false;
    await vi.waitFor(() => expect(originalDecoration.dispose).toHaveBeenCalledTimes(1));
    expect(originalDecoration.element.isConnected).toBe(false);
    expect(outer).not.toHaveClass("terminal-path-link-clickable");
  });

  it("does not validate while the pointer keeps moving", async () => {
    setMockBufferLine(String.raw`cat C:\work\src\main.ts`);
    mockGetSelection.mockReturnValue("");
    mockStatPaths.mockResolvedValue([{ exists: true, isDirectory: false }]);

    render(<TerminalView instanceId="t-path-hover-moving" profile="PowerShell" syncGroup="" />);

    const outer = screen.getByTestId("terminal-view-t-path-hover-moving");
    for (const clientX of [60, 80, 100, 120]) {
      outer.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX, clientY: 0 }));
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 120));
      });
    }
    expect(mockStatPaths).not.toHaveBeenCalled();
  });

  it("does not validate on hover while a selection drag is in progress", async () => {
    setMockBufferLine(String.raw`cat C:\work\src\main.ts`);
    mockGetSelection.mockReturnValue("");

    render(<TerminalView instanceId="t-path-hover-drag" profile="PowerShell" syncGroup="" />);

    const outer = screen.getByTestId("terminal-view-t-path-hover-drag");
    outer.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 11, clientX: 100, clientY: 0 }),
    );
    // buttons=1 → 누른 상태의 이동은 dwell 을 잡지 않는다.
    outer.dispatchEvent(
      new MouseEvent("mousemove", { bubbles: true, clientX: 110, clientY: 0, buttons: 1 }),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
    });

    expect(mockStatPaths).not.toHaveBeenCalled();
    window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 11 }));
  });

  it("validates the clicked token once and does not open it on that click", async () => {
    setMockBufferLine(String.raw`cat C:\work\src\main.ts`);
    mockGetSelection.mockReturnValue("");
    mockStatPaths.mockResolvedValue([{ exists: true, isDirectory: false }]);

    render(<TerminalView instanceId="t-path-click-detect" profile="PowerShell" syncGroup="" />);

    const outer = screen.getByTestId("terminal-view-t-path-click-detect");
    outer.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 12, clientX: 100, clientY: 0 }),
    );
    outer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100, clientY: 0 }));
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 12, clientX: 100, clientY: 0 }),
    );
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 100, clientY: 0 }));

    await vi.waitFor(() => {
      expect(mockStatPaths).toHaveBeenCalledTimes(1);
    });
    expect(mockStatPaths).toHaveBeenCalledWith([String.raw`C:\work\src\main.ts`]);
    // 발견은 열기가 아니다 — 아직 밑줄이 없던 문구의 클릭은 viewer 를 열지 않는다.
    const { useFileViewerStore } = await import("@/stores/file-viewer-store");
    expect(useFileViewerStore.getState().open).toBe(false);
  });

  it("opens the file on a click that lands on an already verified underline", async () => {
    setMockBufferLine(String.raw`cat C:\work\src\main.ts`);
    mockGetSelection.mockReturnValue("");
    mockStatPaths.mockResolvedValue([{ exists: true, isDirectory: false }]);

    render(<TerminalView instanceId="t-path-click-open" profile="PowerShell" syncGroup="" />);

    const outer = screen.getByTestId("terminal-view-t-path-click-open");
    // 1st click: discovery only.
    outer.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 21, clientX: 100, clientY: 0 }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 21, clientX: 100, clientY: 0 }),
    );
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 100, clientY: 0 }));
    await vi.waitFor(() => {
      expect(mockStatPaths).toHaveBeenCalledTimes(1);
    });
    const { useFileViewerStore } = await import("@/stores/file-viewer-store");
    expect(useFileViewerStore.getState().open).toBe(false);

    // 2nd click on the same spot: the verified target is captured on mousedown
    // and opened on mouseup.
    outer.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 22, clientX: 100, clientY: 0 }),
    );
    outer.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 100, clientY: 0 }));
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 22, clientX: 100, clientY: 0 }),
    );
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 100, clientY: 0 }));

    await vi.waitFor(() => {
      expect(useFileViewerStore.getState().open).toBe(true);
    });
    expect(useFileViewerStore.getState().path).toBe(String.raw`C:\work\src\main.ts`);
    // The second click reuses the verified target instead of re-parsing it.
    expect(mockStatPaths).toHaveBeenCalledTimes(1);
  });

  it("keeps a drag on the selection path instead of the point path", async () => {
    setMockBufferLine(String.raw`cat C:\work\src\main.ts`);
    mockGetSelection.mockReturnValue(String.raw`C:\work\src\main.ts`);
    mockGetSelectionPosition.mockReturnValue({
      start: { x: 4, y: 0 },
      end: { x: 23, y: 0 },
    });
    mockStatPaths.mockResolvedValue([{ exists: true, isDirectory: false }]);

    render(<TerminalView instanceId="t-path-drag-selection" profile="PowerShell" syncGroup="" />);

    const outer = screen.getByTestId("terminal-view-t-path-drag-selection");
    outer.dispatchEvent(
      // 컬럼 4 는 "cat" 뒤 공백이다. point 분기를 타면 후보가 없어 stat 0회가
      // 되므로, 아래 1회 단정이 두 분기를 실제로 구별한다.
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 13, clientX: 30, clientY: 0 }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 13, clientX: 200, clientY: 0 }),
    );
    window.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 13, clientX: 200, clientY: 0 }),
    );
    mockOnSelectionChange.mock.calls[0][0]();
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 200, clientY: 0 }));

    await vi.waitFor(() => {
      expect(mockStatPaths).toHaveBeenCalledTimes(1);
    });
  });

  it("does not validate a path after the pointer selection gesture is cancelled", async () => {
    mockGetSelection.mockReturnValue(String.raw`C:\work\src\main.ts`);
    mockGetSelectionPosition.mockReturnValue({
      start: { x: 0, y: 0 },
      end: { x: 19, y: 0 },
    });

    render(<TerminalView instanceId="t-path-selection-cancel" profile="PowerShell" syncGroup="" />);

    const outer = screen.getByTestId("terminal-view-t-path-selection-cancel");
    outer.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 4, clientX: 0, clientY: 0 }),
    );
    window.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, pointerId: 4, clientX: 30, clientY: 0 }),
    );
    window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 4 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 4 }));

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(mockStatPaths).not.toHaveBeenCalled();
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
    await waitForLocalTerminalControl();

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
    await waitForLocalTerminalControl();

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
    await waitForLocalTerminalControl();

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
    await waitForLocalTerminalControl();

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
    await waitForLocalTerminalControl();

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
    await waitForLocalTerminalControl();

    fireTerminalKey({ key: "=", ctrlKey: true });

    expect(useOverridesStore.getState().getViewOverride("pane-zoom-max")?.fontSize).toBe(72);
  });

  it("zoom on one pane does not affect another pane with the same profile", async () => {
    render(<TerminalView instanceId="t-zoomA" paneId="pane-A" profile="PowerShell" syncGroup="" />);
    await waitForLocalTerminalControl();
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
    await waitForLocalTerminalControl();

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

  // The texture atlas is shared by every terminal on the same render config, but
  // xterm re-syncs only the render model of the terminal that cleared it. The
  // others keep vertex data pointing into atlas regions that now hold different
  // glyphs, and a plain repaint cannot repair it — `_updateModel` skips cells
  // whose contents are unchanged, so only clearing their model rewrites the
  // stale coordinates (issue #571).
  it("rebuilds other terminals' renderers when one clears the shared texture atlas (issue #571)", async () => {
    const foreignRebuild = vi.fn();
    registerAtlasRebuilder("t-atlas-bystander", foreignRebuild);

    try {
      render(
        <TerminalView
          instanceId="t-atlas-share"
          paneId="pane-atlas-share"
          profile="PowerShell"
          syncGroup=""
        />,
      );

      mockClearTextureAtlas.mockClear();
      foreignRebuild.mockClear();

      act(() => {
        useOverridesStore.getState().setViewOverride("pane-atlas-share", { fontSize: 20 });
      });

      await vi.waitFor(() => {
        expect(mockClearTextureAtlas).toHaveBeenCalled();
        expect(foreignRebuild).toHaveBeenCalled();
      });
    } finally {
      unregisterAtlasRebuilder("t-atlas-bystander");
    }
  });

  // The rebuild sent to the other terminals has to clear their atlas, not just
  // repaint them: `_updateModel` skips cells whose contents are unchanged, so a
  // refresh rewrites none of the stale vertices (issue #571).
  it("clears the other terminal's atlas, not merely repaints it (issue #571)", async () => {
    render(
      <TerminalView
        instanceId="t-atlas-a"
        paneId="pane-atlas-a"
        profile="PowerShell"
        syncGroup=""
      />,
    );
    render(
      <TerminalView
        instanceId="t-atlas-b"
        paneId="pane-atlas-b"
        profile="PowerShell"
        syncGroup=""
      />,
    );

    // Both mounts do their own atlas rebuild; let that settle before measuring,
    // otherwise the bystander looks cleared when nothing reached it.
    await vi.waitFor(() => {
      expect(new Set(mockClearTextureAtlas.mock.calls.map(([term]) => term)).size).toBe(2);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    mockClearTextureAtlas.mockClear();

    act(() => {
      useOverridesStore.getState().setViewOverride("pane-atlas-a", { fontSize: 20 });
    });

    // Both terminals must have had their atlas cleared: the one whose font
    // changed, and the bystander reached through the coordinator. A
    // refresh-only fan-out would only ever clear the first.
    await vi.waitFor(() => {
      const cleared = new Set(mockClearTextureAtlas.mock.calls.map(([term]) => term));
      expect(cleared.size).toBe(2);
    });
  });

  // A pane in a `display: none` workspace must not be touched by the fan-out
  // (issue #573). §8.4 already forbids working on a hidden terminal, and the
  // hide→show return owns that rebuild — doing it from the fan-out too would
  // pay for a pane nobody can see, twice.
  it("skips hidden panes in the atlas fan-out and rebuilds once on return (issue #573)", async () => {
    type Observer = {
      target: Element | null;
      callback: (entries: ResizeObserverEntry[], obs: ResizeObserver) => void;
    };
    const observers: Observer[] = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    const resize = (obs: Observer, width: number, height: number) => {
      obs.callback(
        [{ target: obs.target as Element, contentRect: { width, height } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    };
    globalThis.ResizeObserver = class {
      private obs: Observer;
      constructor(cb: (entries: ResizeObserverEntry[], obs: ResizeObserver) => void) {
        this.obs = { target: null, callback: cb };
        observers.push(this.obs);
      }
      observe(target: Element) {
        this.obs.target = target;
        setTimeout(() => resize(this.obs, 800, 600), 0);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    try {
      render(
        <TerminalView
          instanceId="t-atlas-hidden"
          paneId="pane-atlas-hidden"
          profile="PowerShell"
          syncGroup=""
        />,
      );
      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalled();
        expect(observers[0]?.target).toBeTruthy();
      });
      await waitForTerminalRendererOpen();
      const obs = observers[0];

      // The workspace goes away: PaneGrid collapses the box to 0×0.
      act(() => resize(obs, 0, 0));
      mockClearTextureAtlas.mockClear();

      // Another pane clears the shared atlas while this one is hidden.
      await act(async () => {
        notifyTextureAtlasCleared("t-atlas-foreign", true);
        await Promise.resolve();
      });
      expect(mockClearTextureAtlas).not.toHaveBeenCalled();

      // Coming back is what repairs it — exactly once, through the hide→show
      // path that would have run anyway.
      await act(async () => resize(obs, 800, 600));
      await vi.waitFor(() => {
        expect(mockClearTextureAtlas).toHaveBeenCalledTimes(1);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(mockClearTextureAtlas).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it("waits for write drain before font and DPR geometry reflows", async () => {
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
    await waitForTerminalRendererOpen();

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

  it("preserves bundled output for a same-size remote-return backend resize", async () => {
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

      const redraw = "\x1b[?25l\x1b[Hremote repaint\x1b[?25h";
      act(() => {
        onOutput?.(new TextEncoder().encode(redraw));
      });
      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(new TextDecoder().decode(mockWrite.mock.calls[0][0] as Uint8Array)).toBe(redraw);
    } finally {
      userAgent.mockRestore();
    }
  });

  it("sends one unfiltered backend resize when remote-return fit changes geometry", async () => {
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

      const redraw = "\x1b[?25l\x1b[Hremote repaint\x1b[?25h";
      act(() => {
        onOutput?.(new TextEncoder().encode(redraw));
      });
      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(new TextDecoder().decode(mockWrite.mock.calls[0][0] as Uint8Array)).toBe(redraw);
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
    await waitForTerminalRendererOpen();
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
    await waitForTerminalRendererOpen();
    await vi.waitFor(() => {
      expect(mockResizeTerminal).toHaveBeenCalledWith("t-remote-latest-geometry", 80, 24);
    });
    mockResizeTerminal.mockClear();
    let resolveFirstResize: (() => void) | undefined;
    mockResizeTerminal.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveFirstResize = resolve;
        }),
    );
    mockResizeTerminal.mockResolvedValue(undefined);

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
    await waitForTerminalRendererOpen();
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

  it("preserves remote-return sync and bundled redraw after a deferred fit becomes hidden", async () => {
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
      const redraw = "\x1b[?25l\x1b[Hremote repaint\x1b[?25h";
      act(() => {
        onOutput?.(new TextEncoder().encode(redraw));
      });
      expect(mockWrite).toHaveBeenCalledTimes(writesBeforeRepaint + 1);
      expect(
        new TextDecoder().decode(mockWrite.mock.calls[writesBeforeRepaint][0] as Uint8Array),
      ).toBe(redraw);
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

  it("blocks local keys and resize while remote control is active but forwards xterm protocol data", async () => {
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
    mockWriteTerminalProtocolReply.mockClear();
    mockResizeTerminal.mockClear();

    const terminal = createdTerminals.at(-1)!;
    const onOutput = mockOnTerminalOutput.mock.calls.find(
      ([id]) => id === "t-remote-owned",
    )?.[1] as ((data: Uint8Array) => void) | undefined;
    const resizeHandler = mockOnResize.mock.calls.at(-1)?.[0] as
      | ((size: { cols: number; rows: number }) => void)
      | undefined;
    expect(onOutput).toBeDefined();
    expect(resizeHandler).toBeDefined();
    expect(capturedKeyHandler).toBeTypeOf("function");

    const reply = "\x1b]10;rgb:ffff/ffff/ffff\x1b\\";
    mockWrite.mockImplementationOnce((_, callback?: () => void) => {
      terminal.emitCoreData(reply);
      callback?.();
    });
    act(() => {
      onOutput?.(new TextEncoder().encode("LIVE_QUERY"));
      resizeHandler?.({ cols: 120, rows: 40 });
    });

    expect(capturedKeyHandler?.(new KeyboardEvent("keydown", { key: "x" }))).toBe(false);
    expect(capturedKeyHandler?.(new KeyboardEvent("keypress", { key: "x" }))).toBe(false);
    expect(mockWriteTerminalProtocolReply).toHaveBeenCalledWith("t-remote-owned", 1, reply);
    expect(mockWriteToTerminal).not.toHaveBeenCalled();
    expect(mockResizeTerminal).not.toHaveBeenCalled();
  });

  it("forwards xterm protocol responses before the initial remote status is known", async () => {
    mockGetRemoteControlStatus.mockReturnValueOnce(new Promise(() => {}));

    render(<TerminalView instanceId="t-protocol-pending" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockGetRemoteControlStatus).toHaveBeenCalled();
      expect(mockOnData).toHaveBeenCalled();
      expect(capturedKeyHandler).toBeTypeOf("function");
    });

    const terminal = createdTerminals.at(-1)!;
    const onOutput = mockOnTerminalOutput.mock.calls.find(
      ([id]) => id === "t-protocol-pending",
    )?.[1] as ((data: Uint8Array) => void) | undefined;
    expect(onOutput).toBeTypeOf("function");
    expect(capturedKeyHandler?.(new KeyboardEvent("keydown", { key: "x" }))).toBe(false);
    expect(capturedKeyHandler?.(new KeyboardEvent("keypress", { key: "x" }))).toBe(false);

    mockWriteToTerminal.mockClear();
    mockWriteTerminalProtocolReply.mockClear();
    const replies = ["\x1b]10;rgb:ffff/ffff/ffff\x1b\\", "\x1b]11;rgb:0000/0000/0000\x1b\\"];
    mockWrite.mockImplementationOnce((_, callback?: () => void) => {
      for (const reply of replies) terminal.emitCoreData(reply);
      callback?.();
    });
    act(() => {
      onOutput?.(new TextEncoder().encode("LIVE_COLOR_QUERIES"));
    });

    expect(mockWriteTerminalProtocolReply).toHaveBeenNthCalledWith(
      1,
      "t-protocol-pending",
      1,
      "\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
    );
    expect(mockWriteTerminalProtocolReply).toHaveBeenNthCalledWith(
      2,
      "t-protocol-pending",
      1,
      "\x1b]11;rgb:0000/0000/0000\x1b\\",
    );
    expect(mockWriteToTerminal).not.toHaveBeenCalled();
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
      await waitForTerminalRendererOpen();

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
      await waitForTerminalRendererOpen();

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
        // A new ConPTY chunk can arrive while the first parse is pending. Its
        // cursor-addressing sequences still target the old width, so the fit
        // must wait for both the batched write and a short output-quiet window.
        onOutput?.(new TextEncoder().encode("latest streaming output"));
        finishWrites[0]?.();
      });
      expect(mockFit).not.toHaveBeenCalled();

      await vi.waitFor(() => expect(finishWrites).toHaveLength(2));
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

      // Three restore writes drain in order: cached content, the marker, and
      // the bracketed-paste mode reset. Each must clear before the deferred
      // reflow runs.
      for (let index = 0; index < 3; index += 1) {
        const finish = finishWrites.shift();
        expect(finish).toBeTypeOf("function");
        act(() => finish?.());
        if (index < 2) {
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

  it("preserves a bundled ConPTY TUI redraw after widening normal-buffer scrollback", async () => {
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

      const redraw = "\x1b[?25l\x1b[Happlication redraw\x1b[19;19H\x1b[?25h";
      act(() => {
        onOutput?.(new TextEncoder().encode(redraw));
      });
      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(new TextDecoder().decode(mockWrite.mock.calls[0][0] as Uint8Array)).toBe(redraw);

      act(() => {
        onOutput?.(new TextEncoder().encode("real output after repaint"));
      });
      expect(mockWrite).toHaveBeenCalledTimes(2);
      expect(new TextDecoder().decode(mockWrite.mock.calls[1][0] as Uint8Array)).toBe(
        "real output after repaint",
      );
    } finally {
      userAgent.mockRestore();
    }
  });

  it("preserves a window-size-shaped TUI redraw after narrowing bundled ConPTY", async () => {
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

      const redraw = "\x1b[?25l\x1b[8;24;60t\x1b[Happlication narrow redraw\x1b[24;7H\x1b[?25h";
      act(() => {
        onOutput?.(new TextEncoder().encode(redraw));
      });
      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(new TextDecoder().decode(mockWrite.mock.calls[0][0] as Uint8Array)).toBe(redraw);
    } finally {
      userAgent.mockRestore();
    }
  });

  it("preserves a bundled redraw when shallow scrollback reflows to baseY zero", async () => {
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

      const redraw = "\x1b[?25l\x1b[Happlication redraw\x1b[?25h";
      act(() => {
        onOutput?.(new TextEncoder().encode(redraw));
      });
      expect(mockWrite).toHaveBeenCalledTimes(1);
      expect(new TextDecoder().decode(mockWrite.mock.calls[0][0] as Uint8Array)).toBe(redraw);
    } finally {
      mockFit.mockImplementation(() => {});
      userAgent.mockRestore();
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it("does not arm legacy repaint expectations across bundled width changes", async () => {
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

      const first = "\x1b[?25l\x1b[Hfirst frame";
      const second = " tail\x1b[?25hbetween\x1b[?25l\x1b[Hsecond frame\x1b[?25hafter";
      act(() => {
        capturedResizeHandler?.({ cols: 100, rows: 24 });
        onOutput?.(new TextEncoder().encode(first));
        capturedResizeHandler?.({ cols: 120, rows: 24 });
        onOutput?.(new TextEncoder().encode(second));
      });

      expect(mockWrite).toHaveBeenCalledTimes(2);
      expect(new TextDecoder().decode(mockWrite.mock.calls[0][0] as Uint8Array)).toBe(first);
      expect(new TextDecoder().decode(mockWrite.mock.calls[1][0] as Uint8Array)).toBe(second);
    } finally {
      userAgent.mockRestore();
    }
  });

  it("does not buffer a split legacy start marker on bundled ConPTY", async () => {
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

      const first = "\x1b[?25";
      const second =
        "l\x1b[Hfirst frame\x1b[?25hbetween" + "\x1b[?25l\x1b[Hsecond frame\x1b[?25hafter";
      act(() => {
        capturedResizeHandler?.({ cols: 100, rows: 24 });
        onOutput?.(new TextEncoder().encode(first));
        capturedResizeHandler?.({ cols: 120, rows: 24 });
        onOutput?.(new TextEncoder().encode(second));
      });

      expect(mockWrite).toHaveBeenCalledTimes(2);
      expect(new TextDecoder().decode(mockWrite.mock.calls[0][0] as Uint8Array)).toBe(first);
      expect(new TextDecoder().decode(mockWrite.mock.calls[1][0] as Uint8Array)).toBe(second);
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
      await waitForTerminalInputReady();
      const onOutput = mockOnTerminalOutput.mock.calls.at(-1)?.[1] as
        | ((data: Uint8Array) => void)
        | undefined;
      const countersBefore = terminalOutputPipelineCounters("t-write-throw");
      mockWrite.mockClear();
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
      const countersAfter = terminalOutputPipelineCounters("t-write-throw");
      expect(countersAfter.xtermWrites - countersBefore.xtermWrites).toBe(1);
      expect(countersAfter.xtermWriteBytes - countersBefore.xtermWriteBytes).toBe(
        "overloaded output".length,
      );
      expect(countersAfter.writeBackpressure - countersBefore.writeBackpressure).toBe(1);

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
      await waitForTerminalRendererOpen();

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
  // DPR reflow effects run for every mounted TerminalView, so
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
      await waitForTerminalRendererOpen();
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
      await waitForTerminalRendererOpen();
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
      await waitForTerminalRendererOpen();
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
      await waitForTerminalRendererOpen();

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

  // -- Fixed scrollbar layout --

  it("keeps the overview ruler disabled without scrollbar mode classes", async () => {
    render(<TerminalView instanceId="t-sb1" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(createdTerminals.length).toBeGreaterThan(0);
    });

    const term = createdTerminals[createdTerminals.length - 1];
    expect(term.options.overviewRuler).toEqual({ width: 0 });
    const container = screen.getByTestId("terminal-view-t-sb1");
    expect(container.classList.contains("scrollbar-overlay")).toBe(false);
    expect(container.classList.contains("scrollbar-separate")).toBe(false);
  });

  // -- Wheel scroll sensitivity --

  it("creates xterm with the configured wheel sensitivities", async () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      terminal: {
        ...useSettingsStore.getState().terminal,
        scrollSensitivity: 3.5,
        fastScrollSensitivity: 12,
      },
    });

    render(<TerminalView instanceId="t-wheel1" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(createdTerminals.length).toBeGreaterThan(0);
    });
    const term = createdTerminals[createdTerminals.length - 1];
    expect(term.options.scrollSensitivity).toBe(3.5);
    expect(term.options.fastScrollSensitivity).toBe(12);
  });

  it("clamps an out-of-band wheel sensitivity instead of handing it to xterm", async () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      terminal: {
        ...useSettingsStore.getState().terminal,
        scrollSensitivity: 0,
        fastScrollSensitivity: 1000,
      },
    });

    render(<TerminalView instanceId="t-wheel2" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(createdTerminals.length).toBeGreaterThan(0);
    });
    const term = createdTerminals[createdTerminals.length - 1];
    // 0 falls back to the default (xterm throws on a non-positive value).
    expect(term.options.scrollSensitivity).toBe(1);
    expect(term.options.fastScrollSensitivity).toBe(20);
  });

  it("applies a wheel sensitivity change to the running terminal", async () => {
    render(<TerminalView instanceId="t-wheel3" profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(createdTerminals.length).toBeGreaterThan(0);
    });
    const term = createdTerminals[createdTerminals.length - 1];

    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      terminal: {
        ...useSettingsStore.getState().terminal,
        scrollSensitivity: 5,
        fastScrollSensitivity: 8,
      },
    });

    await vi.waitFor(() => {
      expect(term.options.scrollSensitivity).toBe(5);
      expect(term.options.fastScrollSensitivity).toBe(8);
    });
  });

  it("routes wheel rows to a visible normal-buffer Codex transcript pager", async () => {
    const terminalId = "t-codex-transcript-wheel";
    setMockBufferLine("/ T R A N S C R I P T / / / / / /");
    mockConsumeWheelEvent.mockReturnValueOnce(3);
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForLocalTerminalControl();
    act(() => {
      useTerminalStore.getState().updateInstanceInfo(terminalId, {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaY: 1,
    });

    expect(capturedWheelHandler).not.toBeNull();
    expect(capturedWheelHandler?.(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
    expect(mockConsumeWheelEvent).toHaveBeenCalledWith(event, 20, 1);
    expect(mockTerminalInput.mock.calls).toEqual(Array(3).fill(["\x1b[B", true]));

    act(() => {
      useTerminalStore.getState().updateInstanceInfo(terminalId, { activity: { type: "shell" } });
    });
    expect(
      capturedWheelHandler?.(
        new WheelEvent("wheel", {
          cancelable: true,
          deltaMode: WheelEvent.DOM_DELTA_LINE,
          deltaY: 1,
        }),
      ),
    ).toBe(true);
    expect(mockTerminalInput).toHaveBeenCalledTimes(3);
  });

  it("leaves a normal-buffer Codex transcript on xterm scrollback when the convenience is off", async () => {
    const terminalId = "t-codex-transcript-wheel-disabled";
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      codex: {
        ...useSettingsStore.getState().codex,
        transcriptScrollEnabled: false,
      },
    });
    setMockBufferLine("/ T R A N S C R I P T / / / / / /");
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForLocalTerminalControl();
    act(() => {
      useTerminalStore.getState().updateInstanceInfo(terminalId, {
        activity: { type: "interactiveApp", name: "Codex" },
      });
    });

    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      deltaY: 1,
    });
    expect(capturedWheelHandler?.(event)).toBe(true);
    expect(event.defaultPrevented).toBe(false);
    expect(mockConsumeWheelEvent).not.toHaveBeenCalled();
    expect(mockTerminalInput).not.toHaveBeenCalled();
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

    it("seeds the store CWD from the create reply", async () => {
      // A pane restored into `codex resume` never emits an accepted OSC 7, so
      // the create reply is the only CWD its sync group ever sees.
      mockCreateTerminalSession.mockResolvedValueOnce({
        id: "t-restore-seed",
        title: "Terminal",
        initialExecutionHost: "unknown",
        cwd: "/mnt/d/PycharmProjects/laymux",
        config: {
          profile: "PowerShell",
          cols: 80,
          rows: 24,
          sync_group: "default",
          env: [],
          advertise_true_color: true,
        },
      });

      render(
        <TerminalView
          instanceId="t-restore-seed"
          paneId="pane-seed"
          profile="PowerShell"
          syncGroup="default"
          lastCwd="/mnt/d/PycharmProjects/laymux"
        />,
      );

      await vi.waitFor(() => {
        const instance = useTerminalStore
          .getState()
          .instances.find((i) => i.id === "t-restore-seed");
        expect(instance?.cwd).toBe("/mnt/d/PycharmProjects/laymux");
      });
    });

    it("leaves the store CWD unset when the create reply carries none", async () => {
      render(
        <TerminalView
          instanceId="t-restore-noseed"
          paneId="pane-noseed"
          profile="PowerShell"
          syncGroup="default"
        />,
      );

      await vi.waitFor(() => {
        const instance = useTerminalStore
          .getState()
          .instances.find((i) => i.id === "t-restore-noseed");
        expect(instance?.sessionReady).toBe(true);
      });
      expect(
        useTerminalStore.getState().instances.find((i) => i.id === "t-restore-noseed")?.cwd,
      ).toBeUndefined();
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

    it("restores with the configured claude command and its flags", async () => {
      useSettingsStore.setState({
        claude: {
          ...useSettingsStore.getState().claude,
          command: "claude --dangerously-skip-permissions",
        },
      });

      render(
        <TerminalView
          instanceId="t-claude-flagged"
          paneId="pane-claude-flagged"
          profile="PowerShell"
          syncGroup="default"
          lastClaudeSession="abc123-session-id"
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-claude-flagged",
          "PowerShell",
          80,
          24,
          "default",
          true,
          true,
          undefined,
          "claude --dangerously-skip-permissions --resume abc123-session-id",
        );
      });
    });

    it("falls back to the default command when the configured one is unsafe", async () => {
      useSettingsStore.setState({
        claude: { ...useSettingsStore.getState().claude, command: "claude; rm -rf /" },
      });

      render(
        <TerminalView
          instanceId="t-claude-unsafe"
          paneId="pane-claude-unsafe"
          profile="PowerShell"
          syncGroup="default"
          lastClaudeSession="abc123-session-id"
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-claude-unsafe",
          "PowerShell",
          80,
          24,
          "default",
          true,
          true,
          undefined,
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

    it("passes codex resume when lastCodexSession is set", async () => {
      render(
        <TerminalView
          instanceId="t-codex-restore"
          paneId="pane-codex"
          profile="PowerShell"
          syncGroup="default"
          lastCwd="/home/user/project"
          lastCodexSession="019fc0d8-a862-7241-a0f5-b6a66ef4ef6f"
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-codex-restore",
          "PowerShell",
          80,
          24,
          "default",
          true,
          true,
          "/home/user/project",
          "codex resume 019fc0d8-a862-7241-a0f5-b6a66ef4ef6f",
        );
      });
    });

    it("restores with the configured codex command and its flags", async () => {
      useSettingsStore.setState({
        codex: { ...useSettingsStore.getState().codex, command: "codex --yolo" },
      });

      render(
        <TerminalView
          instanceId="t-codex-flagged"
          paneId="pane-codex-flagged"
          profile="PowerShell"
          syncGroup="default"
          lastCodexSession="019fc0d8-a862-7241-a0f5-b6a66ef4ef6f"
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-codex-flagged",
          "PowerShell",
          80,
          24,
          "default",
          true,
          true,
          undefined,
          "codex --yolo resume 019fc0d8-a862-7241-a0f5-b6a66ef4ef6f",
        );
      });
    });

    it("does not restore a Codex session when the setting is disabled", async () => {
      useSettingsStore.setState({
        codex: {
          ...useSettingsStore.getState().codex,
          restoreSession: false,
        },
      });

      render(
        <TerminalView
          instanceId="t-codex-no-restore"
          paneId="pane-codex-no"
          profile="PowerShell"
          syncGroup="default"
          lastCodexSession="019fc0d8-a862-7241-a0f5-b6a66ef4ef6f"
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-codex-no-restore",
          "PowerShell",
          80,
          24,
          "default",
          true,
          true,
          undefined,
          undefined,
        );
      });
    });

    it("fails closed when both Claude and Codex session IDs are present", async () => {
      render(
        <TerminalView
          instanceId="t-ambiguous-agent-restore"
          paneId="pane-ambiguous-agent"
          profile="PowerShell"
          syncGroup="default"
          lastClaudeSession="claude-session"
          lastCodexSession="codex-session"
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-ambiguous-agent-restore",
          "PowerShell",
          80,
          24,
          "default",
          true,
          true,
          undefined,
          undefined,
        );
      });
    });

    it("passes grok --resume as startupCommandOverride when lastGrokSession is set", async () => {
      render(
        <TerminalView
          instanceId="t-grok-restore"
          paneId="pane-grok"
          profile="PowerShell"
          syncGroup="default"
          lastCwd="/home/user/project"
          lastGrokSession="019ffa7f-b8c1-7511-872f-911e8dc8d179"
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-grok-restore",
          "PowerShell",
          80,
          24,
          "default",
          true,
          true,
          "/home/user/project",
          "grok --resume 019ffa7f-b8c1-7511-872f-911e8dc8d179",
        );
      });
    });

    it("restores with the configured grok command and its flags", async () => {
      useSettingsStore.setState({
        grok: {
          ...useSettingsStore.getState().grok,
          command: "grok --yolo",
        },
      });

      render(
        <TerminalView
          instanceId="t-grok-flagged"
          paneId="pane-grok-flagged"
          profile="PowerShell"
          syncGroup="default"
          lastGrokSession="019ffa7f-b8c1-7511-872f-911e8dc8d179"
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-grok-flagged",
          "PowerShell",
          80,
          24,
          "default",
          true,
          true,
          undefined,
          "grok --yolo --resume 019ffa7f-b8c1-7511-872f-911e8dc8d179",
        );
      });
    });

    it("fails closed when an invalid Claude key shares the pane with Grok", async () => {
      render(
        <TerminalView
          instanceId="t-invalid-claude-valid-grok"
          paneId="pane-invalid-claude-valid-grok"
          profile="PowerShell"
          syncGroup="default"
          lastClaudeSession="bad; rm -rf /"
          lastGrokSession="019ffa7f-b8c1-7511-872f-911e8dc8d179"
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-invalid-claude-valid-grok",
          "PowerShell",
          80,
          24,
          "default",
          true,
          true,
          undefined,
          undefined,
        );
      });
    });

    it("fails closed when Claude and Grok session IDs are present", async () => {
      render(
        <TerminalView
          instanceId="t-ambiguous-claude-grok"
          paneId="pane-ambiguous-claude-grok"
          profile="PowerShell"
          syncGroup="default"
          lastClaudeSession="claude-session"
          lastGrokSession="019ffa7f-b8c1-7511-872f-911e8dc8d179"
        />,
      );

      await vi.waitFor(() => {
        expect(mockCreateTerminalSession).toHaveBeenCalledWith(
          "t-ambiguous-claude-grok",
          "PowerShell",
          80,
          24,
          "default",
          true,
          true,
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

    it("moves the restored block behind a homed live PTY screen", async () => {
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

      // Writes: cached content, then marker + one viewport of scrollback
      // advancement + CUP home. The live PTY owns the fresh screen from row 1.
      await vi.waitFor(() => {
        const calls = mockWrite.mock.calls.map((c: unknown[]) => c[0]);
        expect(calls).toContain("cached-terminal-output");
        expect(calls).toContain(
          `\r\n\x1b[90m--- session restored ---\x1b[0m\r\n${"\r\n".repeat(24)}\x1b[H`,
        );
      });

      // The boundary is one atomic tracked write and must finish at home. A
      // standalone newline write would leave the frontend cursor at the bottom
      // while ConPTY continues addressing its own first row.
      const calls = mockWrite.mock.calls.map((c: unknown[]) => c[0]);
      expect(calls.some((data) => typeof data === "string" && /^(?:\r\n){4,}$/.test(data))).toBe(
        false,
      );
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
        range: { start: 0, end: 0 },
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
    // The attach reset empties the buffer and emits its own scroll (issue #602),
    // so the viewport state below has to be seeded after it lands.
    await waitForStreamAttachReset();

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
      await waitForStreamAttachReset();

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
    await waitForStreamAttachReset();

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
    //
    // The attach is parked for the whole test on purpose. Its `terminal.reset()`
    // empties the buffer and emits a scroll of its own (issue #602), which would
    // answer the question being asked here; what this pins is the refresh inside
    // `terminal.open()`, which runs before any stream attach.
    const attachPayload = await mockAttachTerminalOutput();
    mockAttachTerminalOutput.mockClear();
    let releaseAttach = () => {};
    const attachHeld = new Promise<void>((resolve) => {
      releaseAttach = resolve;
    });
    mockAttachTerminalOutput.mockImplementationOnce(async () => {
      await attachHeld;
      return attachPayload;
    });
    // This `describe` does not clear mocks between tests, so count from here.
    const resetsBefore = mockReset.mock.calls.length;
    mockBufferActive.baseY = 100;
    mockBufferActive.viewportY = 30;
    render(<TerminalView instanceId="t-jump-init" profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => {
      expect(capturedScrollHandler).not.toBeNull();
    });

    await vi.waitFor(() => {
      expect(screen.getByTestId("terminal-scroll-to-bottom-t-jump-init")).toBeInTheDocument();
    });
    expect(mockReset.mock.calls.length).toBe(resetsBefore);
    await act(async () => {
      releaseAttach();
      await attachHeld;
    });
  });

  it("hides the button again when the viewport returns to the bottom", async () => {
    render(<TerminalView instanceId="t-jump3" profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => {
      expect(capturedScrollHandler).not.toBeNull();
    });
    await waitForStreamAttachReset();

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

  // Issue #361: 14px scrollbar slider + 12px clearance.
  it("uses a 26px right offset for the fixed scrollbar", () => {
    render(<TerminalView instanceId="t-sb-fixed" profile="PowerShell" syncGroup="" />);
    const wrapper = screen.getByTestId("terminal-view-t-sb-fixed");
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
    mockBufferActive.type = "normal";
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

  // Feed raw output so OSC 133 flips the prompt/program phase ↑/↓ routing depends on.
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
    expect(terminal._core.coreService.isCursorHidden).toBe(false);
    toggleInputMode(terminalId);

    await vi.waitFor(() => {
      expect(terminal.options.cursorInactiveStyle).toBe("none");
      expect(screen.getByTestId(`terminal-view-${terminalId}`)).toHaveClass(
        "terminal-native-cursor-hidden",
      );
      // `cursorInactiveStyle` only covers the unfocused cursor; the active one is
      // off at the renderer gate (issue #598).
      expect(terminal._core.coreService.isCursorHidden).toBe(true);
    });

    toggleInputMode(terminalId);
    await vi.waitFor(() => {
      expect(terminal.options.cursorInactiveStyle).toBe("outline");
      expect(screen.getByTestId(`terminal-view-${terminalId}`)).not.toHaveClass(
        "terminal-native-cursor-hidden",
      );
      expect(terminal._core.coreService.isCursorHidden).toBe(false);
    });
  });

  it("re-suppresses the native cursor when the xterm instance is replaced", async () => {
    // Issue #598. A replaced xterm arrives with a fresh gate (`suppressed: false`)
    // and a fresh dedupe baseline, while `inputMode`/`activity`/`stabilize` are
    // unchanged by the swap — so without the xterm generation in the poke effect's
    // deps nobody re-applies, and Composer mode gets the native cursor back under
    // the overlay caret (the doubled caret this suppression removes).
    const terminalId = "t-composer-regen-cursor";
    const { rerender } = render(
      <TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />,
    );
    await waitForTerminalInputReady();

    toggleInputMode(terminalId);
    const first = createdTerminals.at(-1)!;
    await vi.waitFor(() => {
      expect(first._core.coreService.isCursorHidden).toBe(true);
    });

    // A profile change rebuilds the xterm instance. Composer mode persists.
    const before = createdTerminals.length;
    rerender(<TerminalView instanceId={terminalId} profile="WSL" syncGroup="" />);
    await vi.waitFor(() => {
      expect(createdTerminals.length).toBeGreaterThan(before);
    });

    const replaced = createdTerminals.at(-1)!;
    expect(replaced).not.toBe(first);
    await vi.waitFor(() => {
      expect(replaced._core.coreService.isCursorHidden).toBe(true);
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

  // issue #600: a lost `terminal-output-v2` event used to cost screen cells for
  // good, because recovery reset xterm and replayed a ring window that a
  // differential-render TUI never repaints. The ring still holds those bytes, so
  // the gap is repaired in place (ADR-0072).
  const geometry = { revision: 0, cols: 80, rows: 24 };
  const outputDelta = (seqStart: number, text: string) => ({
    generation: 1,
    seqStart,
    seqEnd: seqStart + text.length,
    data: Array.from(new TextEncoder().encode(text)),
    geometry,
  });
  async function attachedOutputEmitter(terminalId: string) {
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();
    const registered = mockOnTerminalOutput.mock.calls.find(
      ([registeredTerminalId]) => registeredTerminalId === terminalId,
    );
    const emitOutput = registered?.[1] as
      | ((data: Uint8Array | Record<string, unknown>) => void)
      | undefined;
    expect(emitOutput).toBeDefined();
    return emitOutput as (data: Uint8Array | Record<string, unknown>) => void;
  }
  const decodedWrites = () =>
    mockWrite.mock.calls.map((call: unknown[]) =>
      typeof call[0] === "string" ? call[0] : new TextDecoder().decode(call[0] as Uint8Array),
    );

  /**
   * Everything xterm was asked to parse, concatenated in write order.
   *
   * Recovery assertions are about the **exact byte stream**, not about how many
   * `write()` calls it took. The renderer FIFO may batch compatible live writes
   * (issue #606, ADR-0080), so entry-level assertions would pin an implementation
   * detail while allowing duplication or omission to slip through.
   */
  const writtenStream = () => decodedWrites().join("");

  const v3Attachment = (nextEnvelopeId = 1) => ({
    state: {
      version: 1,
      generation: 7,
      snapshotStartSeq: 0,
      snapshotSeq: 0,
      sourceStartSeq: 0,
      sourceSeq: 0,
      snapshotKind: "raw" as const,
      protocolRevision: 3,
      modes: { bracketedPaste: false },
      geometry,
    },
    snapshot: [],
    flowControl: {
      token: "lease-v3",
      windowBytes: 524288,
      nextEnvelopeId,
    },
  });
  const v3Envelope = (
    envelopeId: number,
    seqStart: number,
    text: string,
    grantId: string | null = null,
  ) => {
    const data = new TextEncoder().encode(text);
    return {
      version: 3,
      generation: 7,
      leaseToken: "lease-v3",
      envelopeId,
      grantId,
      seqStart,
      seqEnd: seqStart + data.byteLength,
      data,
      deltaEnds: [data.byteLength],
      geometryRuns: [{ deltaIndex: 0, geometry }],
    };
  };

  it("registers v3 before attach and applies one buffered envelope without v2 duplication", async () => {
    const terminalId = "t-output-v3-listener-first";
    let resolveAttach!: (value: ReturnType<typeof v3Attachment>) => void;
    const pendingAttach = new Promise<ReturnType<typeof v3Attachment>>((resolve) => {
      resolveAttach = resolve;
    });
    mockAttachTerminalOutput.mockReturnValueOnce(pendingAttach);
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);

    await vi.waitFor(() => {
      expect(mockOnTerminalOutputV3).toHaveBeenCalledWith(terminalId, expect.any(Function));
      expect(mockAttachTerminalOutput).toHaveBeenCalled();
    });
    expect(mockOnTerminalOutputV3.mock.invocationCallOrder[0]).toBeLessThan(
      mockAttachTerminalOutput.mock.invocationCallOrder[0],
    );
    const emitV3 = mockOnTerminalOutputV3.mock.calls.find(([id]) => id === terminalId)?.[1] as (
      payload: unknown,
    ) => void;
    const snapshot = new TextEncoder().encode("SNAP");
    const backing = new TextEncoder().encode("buffered-v3");
    act(() => emitV3(v3Envelope(17, snapshot.byteLength, "buffered-v3")));

    const attachment = v3Attachment(17);
    resolveAttach({
      ...attachment,
      state: {
        ...attachment.state,
        snapshotSeq: snapshot.byteLength,
        sourceSeq: snapshot.byteLength,
      },
      snapshot: Array.from(snapshot),
    });
    await waitForTerminalInputReady();
    await vi.waitFor(() => expect(mockAcknowledgeTerminalOutputEnvelope).toHaveBeenCalled());
    expect(mockAcknowledgeTerminalOutputEnvelope).toHaveBeenCalledWith(
      terminalId,
      7,
      "lease-v3",
      17,
      null,
      snapshot.byteLength + backing.byteLength,
    );
    expect(mockAcknowledgeTerminalOutput.mock.invocationCallOrder[0]).toBeLessThan(
      mockAcknowledgeTerminalOutputEnvelope.mock.invocationCallOrder[0],
    );
    expect(writtenStream().indexOf("SNAP")).toBeLessThan(writtenStream().indexOf("buffered-v3"));
    expect(screen.queryByTestId(`terminal-output-stopped-${terminalId}`)).toBeNull();
    await vi.waitFor(() =>
      expect(allTerminalOutputV3Diagnostics()[terminalId]).toMatchObject({
        state: "active",
        generation: 7,
        leaseToken: "lease-v3",
        nextEnvelopeId: 18,
      }),
    );

    const writesBeforeV2 = writtenStream();
    const emitV2 = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as (
      payload: unknown,
    ) => void;
    act(() => emitV2(outputDelta(snapshot.byteLength, "buffered-v3")));
    await Promise.resolve();
    expect(writtenStream()).toBe(writesBeforeV2);
  });

  it("pulls one exact missing v3 envelope before admitting its observed successor", async () => {
    const terminalId = "t-output-v3-exact-repair";
    mockAttachTerminalOutput.mockResolvedValueOnce(v3Attachment());
    const repaired = v3Envelope(2, 1, "B");
    mockRepairTerminalOutputEnvelope.mockResolvedValueOnce({
      status: "exact",
      envelope: repaired,
    });
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();
    const emitV3 = mockOnTerminalOutputV3.mock.calls.find(([id]) => id === terminalId)?.[1] as (
      payload: unknown,
    ) => void;
    mockWrite.mockClear();
    mockResumeTerminalOutput.mockClear();

    act(() => emitV3(v3Envelope(1, 0, "A")));
    await vi.waitFor(() =>
      expect(mockAcknowledgeTerminalOutputEnvelope).toHaveBeenCalledWith(
        terminalId,
        7,
        "lease-v3",
        1,
        null,
        1,
      ),
    );
    act(() => emitV3(v3Envelope(3, 2, "C")));

    await vi.waitFor(() => expect(writtenStream()).toContain("ABC"));
    expect(mockRepairTerminalOutputEnvelope).toHaveBeenCalledWith(
      terminalId,
      7,
      "lease-v3",
      2,
      null,
      1,
    );
    expect(mockResumeTerminalOutput).not.toHaveBeenCalled();
    expect(allTerminalOutputV3Diagnostics()[terminalId]).toMatchObject({
      state: "active",
      admittedSeq: 3,
      nextEnvelopeId: 4,
      repairCount: 1,
      lastRepairReason: "event-gap:exact",
    });
    expect(screen.queryByTestId(`terminal-output-stopped-${terminalId}`)).toBeNull();
  });

  it("retries the next watchdog tick after eventPending and applies the exact envelope", async () => {
    vi.useFakeTimers();
    try {
      const terminalId = "t-output-v3-event-pending";
      mockAttachTerminalOutput.mockResolvedValueOnce(v3Attachment());
      mockRepairTerminalOutputEnvelope
        .mockResolvedValueOnce({ status: "eventPending", envelope: null })
        .mockResolvedValueOnce({ status: "exact", envelope: v3Envelope(1, 0, "A") });
      render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
      await waitForTerminalInputReady();
      mockWrite.mockClear();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      expect(mockRepairTerminalOutputEnvelope).toHaveBeenCalledTimes(1);
      expect(writtenStream()).toBe("");
      expect(allTerminalOutputV3Diagnostics()[terminalId]).toMatchObject({
        state: "active",
        repairCount: 0,
        lastRepairReason: null,
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      expect(mockRepairTerminalOutputEnvelope).toHaveBeenCalledTimes(2);
      expect(writtenStream()).toBe("A");
      expect(allTerminalOutputV3Diagnostics()[terminalId]).toMatchObject({
        state: "active",
        admittedSeq: 1,
        nextEnvelopeId: 2,
        repairCount: 1,
        lastRepairReason: "watchdog:exact",
      });
      expect(screen.queryByTestId(`terminal-output-stopped-${terminalId}`)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds an active DECSET frame across a control delay above 50ms", async () => {
    const terminalId = "t-output-v3-hold-delay";
    mockAttachTerminalOutput.mockResolvedValueOnce(v3Attachment(3));
    let resolveHold!: (accepted: boolean) => void;
    const pendingHold = new Promise<boolean>((resolve) => {
      resolveHold = resolve;
    });
    mockHoldTerminalOutputContinuation.mockReturnValueOnce(pendingHold);
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();
    const emitV3 = mockOnTerminalOutputV3.mock.calls.find(([id]) => id === terminalId)?.[1] as (
      payload: unknown,
    ) => void;

    act(() => emitV3(v3Envelope(3, 0, "\x1b[?2026hframe")));
    await vi.waitFor(() => expect(mockHoldTerminalOutputContinuation).toHaveBeenCalledOnce());
    expect(mockWrite.mock.invocationCallOrder.at(-1)).toBeLessThan(
      mockHoldTerminalOutputContinuation.mock.invocationCallOrder[0],
    );
    await new Promise((resolve) => realSetTimeout(resolve, 75));
    expect(mockCloseTerminalOutputContinuation).not.toHaveBeenCalled();
    expect(mockAcknowledgeTerminalOutputEnvelope).not.toHaveBeenCalled();

    resolveHold(true);
    await vi.waitFor(() => expect(mockAcknowledgeTerminalOutputEnvelope).toHaveBeenCalledOnce());
    const grantId = mockHoldTerminalOutputContinuation.mock.calls[0][4] as string;
    const seq = new TextEncoder().encode("\x1b[?2026hframe").byteLength;
    act(() => emitV3(v3Envelope(4, seq, "\x1b[?2026l", grantId)));
    await vi.waitFor(() => expect(mockCloseTerminalOutputContinuation).toHaveBeenCalledOnce());
    expect(mockCloseTerminalOutputContinuation.mock.invocationCallOrder[0]).toBeLessThan(
      mockAcknowledgeTerminalOutputEnvelope.mock.invocationCallOrder[1],
    );
  });

  it("arms one deadline timer only for an active frame and expires at 5 seconds", async () => {
    vi.useFakeTimers();
    try {
      const terminalId = "t-output-v3-frame-deadline";
      mockAttachTerminalOutput.mockResolvedValueOnce(v3Attachment());
      render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
      await waitForTerminalInputReady();
      const emitV3 = mockOnTerminalOutputV3.mock.calls.find(([id]) => id === terminalId)?.[1] as (
        payload: unknown,
      ) => void;
      mockCloseTerminalOutputContinuation.mockClear();

      act(() => emitV3(v3Envelope(1, 0, "\x1b[?2026h")));
      for (
        let turn = 0;
        turn < 10 && mockHoldTerminalOutputContinuation.mock.calls.length === 0;
        turn += 1
      ) {
        await act(async () => Promise.resolve());
      }
      expect(mockHoldTerminalOutputContinuation).toHaveBeenCalledOnce();
      await act(async () => vi.advanceTimersByTimeAsync(4_999));
      expect(mockCloseTerminalOutputContinuation).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTimeAsync(1));
      await vi.waitFor(() =>
        expect(mockCloseTerminalOutputContinuation).toHaveBeenCalledWith(
          terminalId,
          7,
          "lease-v3",
          1,
          expect.any(String),
          8,
          "abort:timeout",
        ),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("advances v3 parsed credit only at the visible/checkpoint intersection", async () => {
    const terminalId = "t-output-v3-parsed-intersection";
    mockAttachTerminalOutput.mockResolvedValueOnce(v3Attachment(5));
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();
    const emitV3 = mockOnTerminalOutputV3.mock.calls.find(([id]) => id === terminalId)?.[1] as (
      payload: unknown,
    ) => void;
    let finishVisible!: () => void;
    let finishCheckpoint!: () => void;
    const checkpoint = new Promise<void>((resolve) => {
      finishCheckpoint = resolve;
    });
    mockTerminalRenderCheckpointApply.mockImplementationOnce(() => checkpoint);
    mockWrite.mockImplementationOnce((_data, callback?: () => void) => {
      finishVisible = callback ?? (() => {});
    });
    mockAcknowledgeTerminalOutput.mockClear();

    act(() => emitV3(v3Envelope(5, 0, "intersection")));
    await vi.waitFor(() => expect(mockAcknowledgeTerminalOutputEnvelope).toHaveBeenCalled());
    expect(mockAcknowledgeTerminalOutput).not.toHaveBeenCalled();
    act(() => finishVisible());
    await Promise.resolve();
    expect(mockAcknowledgeTerminalOutput).not.toHaveBeenCalled();

    await act(async () => {
      finishCheckpoint();
      await checkpoint;
    });
    await vi.waitFor(() =>
      expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledWith(
        terminalId,
        7,
        "lease-v3",
        new TextEncoder().encode("intersection").byteLength,
      ),
    );
  });

  it("waits for normal v3 ACK capacity without reset, replay, or a replacement lease", async () => {
    const holders = Array.from({ length: 6 }, (_, index) => {
      const scope = terminalOutputControlOperationRegistry.mount(`ack-holder-${index}`);
      const operation = scope.tryStart("ack");
      expect(operation).toBeDefined();
      return { scope, operation };
    });
    const terminalId = "t-output-v3-ack-capacity-wait";
    mockAttachTerminalOutput.mockResolvedValueOnce(v3Attachment(5));
    const view = render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);

    try {
      await waitForTerminalInputReady();
      const emitV3 = mockOnTerminalOutputV3.mock.calls.find(([id]) => id === terminalId)?.[1] as (
        payload: unknown,
      ) => void;
      const attachCount = mockAttachTerminalOutput.mock.calls.length;
      const resetCount = mockReset.mock.calls.length;
      mockAcknowledgeTerminalOutput.mockClear();

      act(() => emitV3(v3Envelope(5, 0, "capacity")));
      await vi.waitFor(() => expect(mockAcknowledgeTerminalOutputEnvelope).toHaveBeenCalledOnce());
      await act(async () => Promise.resolve());
      expect(mockAcknowledgeTerminalOutput).not.toHaveBeenCalled();
      expect(mockFailStopTerminalOutputSurface).not.toHaveBeenCalled();

      holders[0].operation?.settle();
      await vi.waitFor(() =>
        expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledWith(
          terminalId,
          7,
          "lease-v3",
          new TextEncoder().encode("capacity").byteLength,
        ),
      );
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachCount);
      expect(mockReset).toHaveBeenCalledTimes(resetCount);
      expect(mockResumeTerminalOutput).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      for (const holder of holders) {
        holder.operation?.settle();
        holder.scope.dispose();
      }
    }
  });

  it("fail-stops a v3 ACK waiter when real timed-out orphans reach the hard cap", async () => {
    const holders = Array.from({ length: 6 }, (_, index) => {
      const scope = terminalOutputControlOperationRegistry.mount(`ack-orphan-${index}`);
      const operation = scope.tryStart("ack");
      expect(operation).toBeDefined();
      return { scope, operation };
    });
    const terminalId = "t-output-v3-ack-orphan-cap";
    mockAttachTerminalOutput.mockResolvedValueOnce(v3Attachment(7));
    const view = render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);

    try {
      await waitForTerminalInputReady();
      const emitV3 = mockOnTerminalOutputV3.mock.calls.find(([id]) => id === terminalId)?.[1] as (
        payload: unknown,
      ) => void;
      const attachCount = mockAttachTerminalOutput.mock.calls.length;
      const resetCount = mockReset.mock.calls.length;
      mockAcknowledgeTerminalOutput.mockClear();

      act(() => emitV3(v3Envelope(7, 0, "orphan-cap")));
      await vi.waitFor(() => expect(mockAcknowledgeTerminalOutputEnvelope).toHaveBeenCalledOnce());
      await act(async () => Promise.resolve());
      expect(mockAcknowledgeTerminalOutput).not.toHaveBeenCalled();

      act(() => {
        for (const holder of holders) holder.operation?.markTimedOut();
      });
      await vi.waitFor(() =>
        expect(mockFailStopTerminalOutputSurface).toHaveBeenCalledWith(
          terminalId,
          7,
          "lease-v3",
          "control_orphan_cap",
        ),
      );
      expect(screen.getByTestId(`terminal-output-stopped-${terminalId}`)).toBeInTheDocument();
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachCount);
      expect(mockReset).toHaveBeenCalledTimes(resetCount);
      expect(mockResumeTerminalOutput).not.toHaveBeenCalled();
    } finally {
      view.unmount();
      for (const holder of holders) {
        holder.operation?.settle();
        holder.scope.dispose();
      }
    }
  });

  it("retries a timed-out v3 parsed ACK on the same lease without fail-stopping", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const terminalId = "t-output-v3-ack-timeout-retry";
      mockAttachTerminalOutput.mockResolvedValueOnce(v3Attachment(5));
      render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
      await waitForTerminalInputReady();
      const emitV3 = mockOnTerminalOutputV3.mock.calls.find(([id]) => id === terminalId)?.[1] as (
        payload: unknown,
      ) => void;
      const attachCount = mockAttachTerminalOutput.mock.calls.length;
      const resetCount = mockReset.mock.calls.length;
      let resolveStalledAck!: (accepted: boolean) => void;
      const stalledAck = new Promise<boolean>((resolve) => {
        resolveStalledAck = resolve;
      });
      mockAcknowledgeTerminalOutput.mockClear();
      mockAcknowledgeTerminalOutput.mockReturnValueOnce(stalledAck).mockResolvedValue(true);

      act(() => emitV3(v3Envelope(5, 0, "stalled")));
      await vi.waitFor(() =>
        expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledWith(terminalId, 7, "lease-v3", 7),
      );

      // The exact 5s boundary is pinned by the flow-control unit tests;
      // vi.waitFor advances fake timers, so only the retry outcome is
      // asserted here.
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      await vi.waitFor(() => expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledTimes(2));
      expect(mockAcknowledgeTerminalOutput).toHaveBeenLastCalledWith(terminalId, 7, "lease-v3", 7);
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachCount);
      expect(mockReset).toHaveBeenCalledTimes(resetCount);
      expect(mockFailStopTerminalOutputSurface).not.toHaveBeenCalled();
      expect(screen.queryByTestId(`terminal-output-stopped-${terminalId}`)).toBeNull();
      expect(terminalOutputRecoveryCounters(terminalId)).toMatchObject({ ackTimeout: 1 });

      resolveStalledAck(true);
      await act(async () => {
        await stalledAck;
        await Promise.resolve();
      });

      act(() => emitV3(v3Envelope(6, 7, "resumed")));
      await vi.waitFor(() =>
        expect(mockAcknowledgeTerminalOutput).toHaveBeenLastCalledWith(
          terminalId,
          7,
          "lease-v3",
          14,
        ),
      );
      expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledTimes(3);
      expect(mockFailStopTerminalOutputSurface).not.toHaveBeenCalled();
      expect(screen.queryByTestId(`terminal-output-stopped-${terminalId}`)).toBeNull();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("fail-stops a rejected v3 receipt without reset, repair, or replacement attach", async () => {
    const terminalId = "t-output-v3-fail-stop";
    const restart = vi.fn();
    mockAttachTerminalOutput.mockResolvedValueOnce(v3Attachment(9));
    mockAcknowledgeTerminalOutputEnvelope.mockResolvedValueOnce(false);
    mockFailStopTerminalOutputSurface.mockRejectedValueOnce(new Error("diagnostics bridge down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = render(
      <TerminalView
        instanceId={terminalId}
        profile="PowerShell"
        syncGroup=""
        onRestart={restart}
      />,
    );
    await waitForTerminalInputReady();
    const emitV3 = mockOnTerminalOutputV3.mock.calls.find(([id]) => id === terminalId)?.[1] as (
      payload: unknown,
    ) => void;
    const attaches = mockAttachTerminalOutput.mock.calls.length;
    const resets = mockReset.mock.calls.length;
    mockResumeTerminalOutput.mockClear();

    act(() => emitV3(v3Envelope(9, 0, "stops-here")));
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("close/recreate required"),
        expect.objectContaining({ reason: expect.stringContaining("control:receipt") }),
      ),
    );
    expect(screen.getByTestId(`terminal-output-stopped-${terminalId}`)).toHaveTextContent(
      "Close and recreate this pane",
    );
    fireEvent.click(screen.getByRole("button", { name: "Restart terminal" }));
    expect(restart).toHaveBeenCalledOnce();
    expect(allTerminalOutputV3Diagnostics()[terminalId]).toMatchObject({
      state: "fail-stopped",
      generation: 7,
      leaseToken: "lease-v3",
      reason: expect.stringContaining("control:receipt"),
    });
    expect(mockFailStopTerminalOutputSurface).toHaveBeenCalledOnce();
    expect(mockFailStopTerminalOutputSurface).toHaveBeenCalledWith(
      terminalId,
      7,
      "lease-v3",
      "surface_unavailable",
    );
    const emitV2 = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as (
      payload: unknown,
    ) => void;
    act(() => emitV2(outputDelta(0, "must-not-replay")));
    await new Promise((resolve) => realSetTimeout(resolve, 75));

    expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attaches);
    expect(mockReset).toHaveBeenCalledTimes(resets);
    expect(mockResumeTerminalOutput).not.toHaveBeenCalled();
    view.unmount();
    expect(mockFailStopTerminalOutputSurface).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("accepts only a current backend v3 fail-stop without echo or recovery", async () => {
    const terminalId = "t-output-v3-backend-fail-stop";
    mockAttachTerminalOutput.mockResolvedValueOnce(v3Attachment(4));
    const view = render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();
    const attaches = mockAttachTerminalOutput.mock.calls.length;
    const resets = mockReset.mock.calls.length;

    act(() => {
      capturedTerminalOutputFailStopped?.({
        terminalId: "other-terminal",
        generation: 7,
        leaseToken: "lease-v3",
        reason: "surface_unavailable",
      });
      capturedTerminalOutputFailStopped?.({
        terminalId,
        generation: 6,
        leaseToken: "old-lease",
        reason: "surface_unavailable",
      });
      capturedTerminalOutputFailStopped?.({
        terminalId,
        generation: 7,
        leaseToken: "wrong-current-generation-lease",
        reason: "receipt_timeout",
      });
    });
    expect(screen.queryByTestId(`terminal-output-stopped-${terminalId}`)).toBeNull();
    expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attaches);
    expect(mockReset).toHaveBeenCalledTimes(resets);
    expect(mockResumeTerminalOutput).not.toHaveBeenCalled();

    act(() =>
      capturedTerminalOutputFailStopped?.({
        terminalId,
        generation: 7,
        leaseToken: "lease-v3",
        reason: "receipt_timeout",
      }),
    );

    expect(screen.getByTestId(`terminal-output-stopped-${terminalId}`)).toHaveTextContent(
      "Close and recreate this pane",
    );
    expect(allTerminalOutputV3Diagnostics()[terminalId]).toMatchObject({
      state: "fail-stopped",
      reason: "backend:receipt_timeout",
    });
    expect(mockFailStopTerminalOutputSurface).not.toHaveBeenCalled();
    expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attaches);
    expect(mockReset).toHaveBeenCalledTimes(resets);
    expect(mockResumeTerminalOutput).not.toHaveBeenCalled();
    view.unmount();
    expect(mockFailStopTerminalOutputSurface).not.toHaveBeenCalled();
  });

  it("buffers a backend fail-stop until the listener-first attach reveals its identity", async () => {
    const terminalId = "t-output-v3-buffered-backend-fail-stop";
    let resolveAttach!: (attachment: ReturnType<typeof v3Attachment>) => void;
    mockAttachTerminalOutput.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAttach = resolve;
      }),
    );
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => {
      expect(mockOnTerminalOutputFailStopped).toHaveBeenCalled();
      expect(mockAttachTerminalOutput).toHaveBeenCalled();
    });

    act(() =>
      capturedTerminalOutputFailStopped?.({
        terminalId,
        generation: 7,
        leaseToken: "lease-v3",
        reason: "surface_unavailable",
      }),
    );
    expect(screen.queryByTestId(`terminal-output-stopped-${terminalId}`)).toBeNull();

    await act(async () => resolveAttach(v3Attachment(6)));
    await vi.waitFor(() =>
      expect(screen.getByTestId(`terminal-output-stopped-${terminalId}`)).toBeInTheDocument(),
    );
    expect(mockFailStopTerminalOutputSurface).not.toHaveBeenCalled();
    expect(mockReset).not.toHaveBeenCalled();
  });

  it("settles a pre-attach null-token backend failure without replacement attach", async () => {
    const terminalId = "t-output-v3-pre-attach-fail-stop";
    let resolveAttach!: (value: {
      kind: "failStopped";
      terminalId: string;
      generation: number;
      reason: string;
    }) => void;
    mockAttachTerminalOutput.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAttach = resolve;
      }),
    );
    const view = render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => {
      expect(mockOnTerminalOutputFailStopped).toHaveBeenCalled();
      expect(mockAttachTerminalOutput).toHaveBeenCalledOnce();
    });
    const resetCount = mockReset.mock.calls.length;

    act(() =>
      capturedTerminalOutputFailStopped?.({
        terminalId,
        generation: 7,
        leaseToken: null,
        reason: "parsed_progress_expired",
      }),
    );
    expect(screen.queryByTestId(`terminal-output-stopped-${terminalId}`)).toBeNull();

    await act(async () =>
      resolveAttach({
        kind: "failStopped",
        terminalId,
        generation: 7,
        reason: "parsed_progress_expired",
      }),
    );
    await vi.waitFor(() =>
      expect(screen.getByTestId(`terminal-output-stopped-${terminalId}`)).toHaveTextContent(
        "Close and recreate this pane",
      ),
    );
    await new Promise((resolve) => realSetTimeout(resolve, 75));

    expect(mockAttachTerminalOutput).toHaveBeenCalledOnce();
    expect(mockReset).toHaveBeenCalledTimes(resetCount);
    expect(mockResumeTerminalOutput).not.toHaveBeenCalled();
    expect(mockRepairTerminalOutputEnvelope).not.toHaveBeenCalled();
    expect(mockFailStopTerminalOutputSurface).not.toHaveBeenCalled();
    view.unmount();
    expect(mockFailStopTerminalOutputSurface).not.toHaveBeenCalled();
  });

  it("uses the typed current attach failure instead of a stale null-token notice", async () => {
    const terminalId = "t-output-v3-stale-pre-attach-failure";
    let resolveAttach!: (value: {
      kind: "failStopped";
      terminalId: string;
      generation: number;
      reason: string;
    }) => void;
    mockAttachTerminalOutput.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAttach = resolve;
      }),
    );
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => expect(mockAttachTerminalOutput).toHaveBeenCalledOnce());

    act(() =>
      capturedTerminalOutputFailStopped?.({
        terminalId,
        generation: 6,
        leaseToken: null,
        reason: "stale_failure",
      }),
    );
    await act(async () =>
      resolveAttach({
        kind: "failStopped",
        terminalId,
        generation: 7,
        reason: "continuation_expired",
      }),
    );

    expect(screen.getByTestId(`terminal-output-stopped-${terminalId}`)).toBeInTheDocument();
    expect(screen.getByTestId(`terminal-output-stopped-${terminalId}`)).toHaveTextContent(
      "continuation_expired",
    );
    expect(mockAttachTerminalOutput).toHaveBeenCalledOnce();
    expect(mockFailStopTerminalOutputSurface).not.toHaveBeenCalled();
  });

  it("ignores a stale hold completion after the v3 surface unmounts", async () => {
    const terminalId = "t-output-v3-unmount";
    mockAttachTerminalOutput.mockResolvedValueOnce(v3Attachment(12));
    mockFailStopTerminalOutputSurface.mockResolvedValueOnce(false);
    let resolveHold!: (accepted: boolean) => void;
    const hold = new Promise<boolean>((resolve) => {
      resolveHold = resolve;
    });
    mockHoldTerminalOutputContinuation.mockReturnValueOnce(hold);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();
    const emitV3 = mockOnTerminalOutputV3.mock.calls.find(([id]) => id === terminalId)?.[1] as (
      payload: unknown,
    ) => void;
    act(() => emitV3(v3Envelope(12, 0, "\x1b[?2026h")));
    await vi.waitFor(() => expect(mockHoldTerminalOutputContinuation).toHaveBeenCalledOnce());

    view.unmount();
    expect(mockFailStopTerminalOutputSurface).toHaveBeenCalledOnce();
    expect(mockFailStopTerminalOutputSurface).toHaveBeenCalledWith(
      terminalId,
      7,
      "lease-v3",
      "surface_unavailable",
    );
    expect(allTerminalOutputV3Diagnostics()[terminalId]).toBeUndefined();
    resolveHold(true);
    await hold;
    await Promise.resolve();
    expect(mockAcknowledgeTerminalOutputEnvelope).not.toHaveBeenCalled();
    expect(allTerminalOutputV3Diagnostics()[terminalId]).toBeUndefined();
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("close/recreate required"),
      expect.anything(),
    );
    warn.mockRestore();
  });

  it("does not publish an old runtime settlement after profile replacement", async () => {
    const terminalId = "t-output-v3-profile-late-settle";
    mockAttachTerminalOutput
      .mockResolvedValueOnce(v3Attachment(14))
      .mockResolvedValueOnce(v3Attachment(20));
    let resolveHold!: (accepted: boolean) => void;
    const hold = new Promise<boolean>((resolve) => {
      resolveHold = resolve;
    });
    mockHoldTerminalOutputContinuation.mockReturnValueOnce(hold);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();
    const oldEmit = mockOnTerminalOutputV3.mock.calls.find(([id]) => id === terminalId)?.[1] as (
      payload: unknown,
    ) => void;
    act(() => oldEmit(v3Envelope(14, 0, "\x1b[?2026h")));
    await vi.waitFor(() => expect(mockHoldTerminalOutputContinuation).toHaveBeenCalledOnce());

    view.rerender(<TerminalView instanceId={terminalId} profile="WSL" syncGroup="" />);
    await vi.waitFor(() =>
      expect(allTerminalOutputV3Diagnostics()[terminalId]).toMatchObject({
        state: "active",
        nextEnvelopeId: 20,
      }),
    );
    resolveHold(true);
    await hold;
    await Promise.resolve();
    await Promise.resolve();

    expect(allTerminalOutputV3Diagnostics()[terminalId]).toMatchObject({
      state: "active",
      reason: null,
      nextEnvelopeId: 20,
    });
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("close/recreate required"),
      expect.anything(),
    );
    warn.mockRestore();
  });

  it("does not revive runtime, diagnostics, or timers when a v3 import settles after unmount", async () => {
    const terminalId = "t-output-v3-import-unmount";
    type RuntimeModule = typeof import("@/lib/terminal-output-v3-runtime");
    let resolveRuntime!: (module: RuntimeModule) => void;
    const pendingRuntime = new Promise<RuntimeModule>((resolve) => {
      resolveRuntime = resolve;
    });
    const loadRuntime = vi.fn(() => pendingRuntime);
    class FakeRuntime {
      static constructions = 0;
      constructor() {
        FakeRuntime.constructions += 1;
      }
    }
    setTerminalOutputV3RuntimeLoaderForTest(loadRuntime);
    mockAttachTerminalOutput.mockResolvedValueOnce(v3Attachment(20));
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const view = render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => expect(loadRuntime).toHaveBeenCalledOnce());

    view.unmount();
    const intervalsAfterUnmount = intervalSpy.mock.calls.length;
    await act(async () => {
      resolveRuntime({
        TerminalOutputV3Runtime: FakeRuntime as unknown as RuntimeModule["TerminalOutputV3Runtime"],
      });
      await pendingRuntime;
      await Promise.resolve();
    });

    expect(FakeRuntime.constructions).toBe(0);
    expect(intervalSpy).toHaveBeenCalledTimes(intervalsAfterUnmount);
    expect(allTerminalOutputV3Diagnostics()[terminalId]).toBeUndefined();
    intervalSpy.mockRestore();
    setTerminalOutputV3RuntimeLoaderForTest();
  });

  it("uses the v3 exact watchdog without invoking the legacy v2 resume path", async () => {
    vi.useFakeTimers();
    type RuntimeModule = typeof import("@/lib/terminal-output-v3-runtime");
    const pollExactRepair = vi.fn(() => Promise.resolve(undefined));
    const flushExpired = vi.fn(() => Promise.resolve());
    class FakeRuntime {
      get continuationDeadline() {
        return undefined;
      }
      receive() {
        return Promise.resolve({ kind: "accepted" as const, envelopeId: 1 });
      }
      pollExactRepair = pollExactRepair;
      flushExpired = flushExpired;
      diagnostics() {
        return {
          admittedSeq: 0,
          parsedSeq: 0,
          nextEnvelopeId: 1,
          activeGrantId: null,
          repairCount: 0,
          lastRepairReason: null,
        };
      }
      dispose() {}
    }
    setTerminalOutputV3RuntimeLoaderForTest(() =>
      Promise.resolve({
        TerminalOutputV3Runtime: FakeRuntime as unknown as RuntimeModule["TerminalOutputV3Runtime"],
      }),
    );
    mockAttachTerminalOutput.mockResolvedValueOnce(v3Attachment());
    try {
      render(<TerminalView instanceId="t-output-v3-watchdog" profile="PowerShell" syncGroup="" />);
      await waitForTerminalInputReady();
      mockResumeTerminalOutput.mockClear();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });

      expect(pollExactRepair).toHaveBeenCalledTimes(1);
      expect(flushExpired).not.toHaveBeenCalled();
      expect(mockResumeTerminalOutput).not.toHaveBeenCalled();
    } finally {
      setTerminalOutputV3RuntimeLoaderForTest();
      vi.useRealTimers();
    }
  });

  it("does not revive the old v3 epoch when its import settles after profile replacement", async () => {
    const terminalId = "t-output-v3-import-epoch";
    type RuntimeModule = typeof import("@/lib/terminal-output-v3-runtime");
    let resolveOld!: (module: RuntimeModule) => void;
    let resolveCurrent!: (module: RuntimeModule) => void;
    const oldRuntime = new Promise<RuntimeModule>((resolve) => {
      resolveOld = resolve;
    });
    const currentRuntime = new Promise<RuntimeModule>((resolve) => {
      resolveCurrent = resolve;
    });
    const loadRuntime = vi
      .fn<() => Promise<RuntimeModule>>()
      .mockReturnValueOnce(oldRuntime)
      .mockReturnValueOnce(currentRuntime);
    class FakeRuntime {
      static constructions = 0;
      constructor() {
        FakeRuntime.constructions += 1;
      }
    }
    const fakeModule = {
      TerminalOutputV3Runtime: FakeRuntime as unknown as RuntimeModule["TerminalOutputV3Runtime"],
    };
    setTerminalOutputV3RuntimeLoaderForTest(loadRuntime);
    mockAttachTerminalOutput
      .mockResolvedValueOnce(v3Attachment(30))
      .mockResolvedValueOnce(v3Attachment(40));
    const intervalSpy = vi.spyOn(globalThis, "setInterval");
    const view = render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => expect(loadRuntime).toHaveBeenCalledTimes(1));
    view.rerender(<TerminalView instanceId={terminalId} profile="WSL" syncGroup="" />);
    await vi.waitFor(() => expect(loadRuntime).toHaveBeenCalledTimes(2));
    const intervalsBeforeOldSettlement = intervalSpy.mock.calls.length;

    await act(async () => {
      resolveOld(fakeModule);
      await oldRuntime;
      await Promise.resolve();
    });
    expect(FakeRuntime.constructions).toBe(0);
    expect(intervalSpy).toHaveBeenCalledTimes(intervalsBeforeOldSettlement);
    expect(allTerminalOutputV3Diagnostics()[terminalId]).toBeUndefined();

    view.unmount();
    resolveCurrent(fakeModule);
    await currentRuntime;
    await Promise.resolve();
    expect(FakeRuntime.constructions).toBe(0);
    intervalSpy.mockRestore();
    setTerminalOutputV3RuntimeLoaderForTest();
  });

  it("ACKs only after visible and checkpoint parse while detectors run immediately", async () => {
    const terminalId = "t-output-parsed-credit-intersection";
    const emitOutput = await attachedOutputEmitter(terminalId);
    let resolveCheckpoint!: () => void;
    const checkpointHeld = new Promise<void>((resolve) => {
      resolveCheckpoint = resolve;
    });
    let finishVisible!: () => void;
    mockTerminalRenderCheckpointApply.mockImplementationOnce(() => checkpointHeld);
    mockWrite.mockClear();
    mockAcknowledgeTerminalOutput.mockClear();
    mockWrite.mockImplementationOnce((_, callback?: () => void) => {
      finishVisible = callback ?? (() => {});
    });
    const enterAlt = "\x1b[?1049h";

    try {
      act(() => emitOutput(outputDelta(0, enterAlt)));

      expect(
        useTerminalStore.getState().instances.find(({ id }) => id === terminalId)?.activity,
      ).toEqual({ type: "interactiveApp", name: "app" });
      expect(mockAcknowledgeTerminalOutput).not.toHaveBeenCalled();

      act(() => finishVisible());
      await Promise.resolve();
      expect(mockAcknowledgeTerminalOutput).not.toHaveBeenCalled();

      await act(async () => {
        resolveCheckpoint();
        await checkpointHeld;
      });
      await vi.waitFor(() =>
        expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledWith(
          terminalId,
          1,
          "lease-1",
          enterAlt.length,
        ),
      );
    } finally {
      mockWrite.mockImplementation((_: string | Uint8Array, callback?: () => void) => callback?.());
    }
  });

  it("keeps parsed credit moving while the pane is hidden", async () => {
    const originalResizeObserver = globalThis.ResizeObserver;
    let observerCallback!: ResizeObserverCallback;
    let observedTarget!: Element;
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        observerCallback = callback;
      }
      observe(target: Element) {
        observedTarget = target;
        queueMicrotask(() =>
          observerCallback(
            [
              {
                target,
                contentRect: { width: 800, height: 600 },
              } as unknown as ResizeObserverEntry,
            ],
            this as unknown as ResizeObserver,
          ),
        );
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const terminalId = "t-output-hidden-credit";
    try {
      const emitOutput = await attachedOutputEmitter(terminalId);
      act(() =>
        observerCallback(
          [
            {
              target: observedTarget,
              contentRect: { width: 0, height: 0 },
            } as unknown as ResizeObserverEntry,
          ],
          {} as ResizeObserver,
        ),
      );
      mockAcknowledgeTerminalOutput.mockClear();

      act(() => emitOutput(outputDelta(0, "hidden-output")));

      await vi.waitFor(() =>
        expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledWith(
          terminalId,
          1,
          "lease-1",
          "hidden-output".length,
        ),
      );
    } finally {
      globalThis.ResizeObserver = originalResizeObserver;
    }
  });

  it("holds ACK when the native stabilizer suppresses every visible byte", async () => {
    const terminalId = "t-output-stabilizer-credit";
    mockCreateTerminalSession.mockResolvedValueOnce({
      id: terminalId,
      title: "Terminal",
      initialExecutionHost: "nativeWindows",
      config: {
        profile: "PowerShell",
        cols: 80,
        rows: 24,
        sync_group: "",
        env: [],
        advertise_true_color: true,
      },
    });
    const emitOutput = await attachedOutputEmitter(terminalId);
    mockWrite.mockClear();
    mockAcknowledgeTerminalOutput.mockClear();
    const held = "\x1b[?2026hbody";
    const release = "\x1b[?2026l";

    act(() => emitOutput(outputDelta(0, held)));
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockAcknowledgeTerminalOutput).not.toHaveBeenCalled();

    act(() => emitOutput(outputDelta(held.length, release)));
    await vi.waitFor(() =>
      expect(mockAcknowledgeTerminalOutput).toHaveBeenLastCalledWith(
        terminalId,
        1,
        "lease-1",
        held.length + release.length,
      ),
    );
  });

  it("reattaches once when checkpoint parsing rejects", async () => {
    const terminalId = "t-output-checkpoint-reject";
    const emitOutput = await attachedOutputEmitter(terminalId);
    const attachCalls = mockAttachTerminalOutput.mock.calls.length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockAcknowledgeTerminalOutput.mockClear();
    mockTerminalRenderCheckpointApply.mockRejectedValueOnce(new Error("checkpoint failed"));

    try {
      act(() => emitOutput(outputDelta(0, "checkpoint-failure")));
      await vi.waitFor(() =>
        expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachCalls + 1),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachCalls + 1);
      expect(mockAcknowledgeTerminalOutput).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("reattaches once when an early physical chunk is discarded", async () => {
    const terminalId = "t-output-early-physical-discard";
    const emitOutput = await attachedOutputEmitter(terminalId);
    const attachCalls = mockAttachTerminalOutput.mock.calls.length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockAcknowledgeTerminalOutput.mockClear();
    mockWrite.mockImplementationOnce(() => {
      throw new Error("unexpected renderer failure");
    });
    const data = "x".repeat(256 * 1024 + 1);

    try {
      act(() => emitOutput(outputDelta(0, data)));
      await vi.waitFor(() =>
        expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachCalls + 1),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachCalls + 1);
      expect(mockAcknowledgeTerminalOutput).not.toHaveBeenCalled();
    } finally {
      mockWrite.mockImplementation((_: string | Uint8Array, callback?: () => void) => callback?.());
      warn.mockRestore();
    }
  });

  it("does not ACK when an immediate native prefix is discarded before its held frame tail", async () => {
    const terminalId = "t-output-native-prefix-discard";
    mockCreateTerminalSession.mockResolvedValueOnce({
      id: terminalId,
      title: "Terminal",
      initialExecutionHost: "nativeWindows",
      config: {
        profile: "PowerShell",
        cols: 80,
        rows: 24,
        sync_group: "",
        env: [],
        advertise_true_color: true,
      },
    });
    const emitOutput = await attachedOutputEmitter(terminalId);
    const attachCalls = mockAttachTerminalOutput.mock.calls.length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockAcknowledgeTerminalOutput.mockClear();
    mockWrite.mockImplementationOnce(() => {
      throw new Error("discard immediate native prefix");
    });

    try {
      const prefixAndHeldFrame = "prefix\x1b[?2026hbody";
      act(() => emitOutput(outputDelta(0, prefixAndHeldFrame)));
      // The original range is already invalid. A later frame end must not run
      // its deferred parse callback and turn that rejection into parsed credit.
      act(() => emitOutput(outputDelta(prefixAndHeldFrame.length, "\x1b[?2026l")));

      await vi.waitFor(() =>
        expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachCalls + 1),
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachCalls + 1);
      expect(mockAcknowledgeTerminalOutput).not.toHaveBeenCalled();
    } finally {
      mockWrite.mockImplementation((_: string | Uint8Array, callback?: () => void) => callback?.());
      warn.mockRestore();
    }
  });

  it("pull watchdog accepts an idle empty range after backend geometry advances", async () => {
    vi.useFakeTimers();
    try {
      const terminalId = "t-output-pull-idle-resize";
      await attachedOutputEmitter(terminalId);
      toggleInputMode(terminalId);
      const composer = screen.getByTestId(`terminal-input-composer-${terminalId}`);
      expect(composer).toHaveAttribute("data-can-send", "true");
      const attachCalls = mockAttachTerminalOutput.mock.calls.length;
      mockResumeTerminalOutput.mockClear();
      mockResumeTerminalOutput.mockResolvedValue({
        ...outputDelta(0, ""),
        geometry: { revision: 1, cols: 100, rows: 30 },
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(mockResumeTerminalOutput).toHaveBeenCalledTimes(1);
      expect(mockResumeTerminalOutput).toHaveBeenCalledWith(terminalId, 1, 0);
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachCalls);
      expect(terminalOutputRecoveryCounters(terminalId)).toMatchObject({
        geometryEscalation: 0,
        repair: 0,
      });
      expect(composer).toHaveAttribute("data-can-send", "true");
    } finally {
      vi.useRealTimers();
    }
  });

  it("pull watchdog drains a live delta that arrives while its single request is pending", async () => {
    vi.useFakeTimers();
    try {
      const terminalId = "t-output-pull-live-race";
      const emitOutput = await attachedOutputEmitter(terminalId);
      let resolvePull!: (value: ReturnType<typeof outputDelta>) => void;
      const pendingPull = new Promise<ReturnType<typeof outputDelta>>((resolve) => {
        resolvePull = resolve;
      });
      mockResumeTerminalOutput.mockClear();
      mockResumeTerminalOutput.mockReturnValue(pendingPull);
      mockWrite.mockClear();
      mockAcknowledgeTerminalOutput.mockClear();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(mockResumeTerminalOutput).toHaveBeenCalledTimes(1);

      act(() => emitOutput(outputDelta(0, "live")));
      expect(writtenStream()).not.toContain("live");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      // Adjacent ticks cannot start another resume while this epoch owns one.
      expect(mockResumeTerminalOutput).toHaveBeenCalledTimes(1);

      await act(async () => {
        resolvePull(outputDelta(0, ""));
        await pendingPull;
        await Promise.resolve();
      });
      expect(writtenStream()).toContain("live");
      expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledWith(terminalId, 1, "lease-1", 4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pull watchdog recovers a full-edge delta that emitted no event", async () => {
    vi.useFakeTimers();
    try {
      const terminalId = "t-output-pull-missing-edge";
      await attachedOutputEmitter(terminalId);
      mockResumeTerminalOutput.mockClear();
      mockResumeTerminalOutput.mockResolvedValue(outputDelta(0, "lost"));
      mockWrite.mockClear();
      mockAcknowledgeTerminalOutput.mockClear();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(writtenStream()).toContain("lost");
      expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledWith(terminalId, 1, "lease-1", 4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reattaches the active epoch when the backend rejects its ACK token", async () => {
    const terminalId = "t-output-ack-lease-lost";
    const emitOutput = await attachedOutputEmitter(terminalId);
    const attachCalls = mockAttachTerminalOutput.mock.calls.length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockAcknowledgeTerminalOutput.mockResolvedValueOnce(false);

    try {
      act(() => emitOutput(outputDelta(0, "lease-lost")));
      await vi.waitFor(() =>
        expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachCalls + 1),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("replaces a pending attach after its watchdog and ignores the orphan completion", async () => {
    vi.useFakeTimers();
    const terminalId = "t-output-attach-timeout";
    const baselineAttachment = await mockAttachTerminalOutput();
    mockAttachTerminalOutput.mockClear();
    let resolveOrphan!: (value: typeof baselineAttachment) => void;
    const orphan = new Promise<typeof baselineAttachment>((resolve) => {
      resolveOrphan = resolve;
    });
    const replacement = {
      ...baselineAttachment,
      flowControl: { ...baselineAttachment.flowControl, token: "lease-replacement" },
    };
    mockAttachTerminalOutput.mockReturnValueOnce(orphan).mockResolvedValueOnce(replacement);
    const warn = vi.spyOn(console, "warn").mockImplementation((message) => {
      if (message === "[TerminalView] terminal output attach timed out; replacing epoch") {
        throw new Error("patched console");
      }
    });

    try {
      const { unmount } = render(
        <TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />,
      );
      await vi.waitFor(() => expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(1));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_999);
      });
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_001);
      });
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(2);
      await vi.waitFor(() => expect(mockReset).toHaveBeenCalled());
      const resetsAfterReplacement = mockReset.mock.calls.length;

      await act(async () => {
        resolveOrphan({
          ...baselineAttachment,
          flowControl: { ...baselineAttachment.flowControl, token: "lease-orphan" },
        });
        await orphan;
        await Promise.resolve();
      });
      expect(mockReset).toHaveBeenCalledTimes(resetsAfterReplacement);
      expect(mockAcknowledgeTerminalOutput).not.toHaveBeenCalledWith(
        terminalId,
        expect.any(Number),
        "lease-orphan",
        expect.any(Number),
      );
      expect(terminalOutputRecoveryCounters(terminalId)).toMatchObject({ attachTimeout: 1 });
      unmount();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not replace an unmounted epoch when its orphan attach settles", async () => {
    vi.useFakeTimers();
    const terminalId = "t-output-attach-timeout-unmount";
    const baselineAttachment = await mockAttachTerminalOutput();
    mockAttachTerminalOutput.mockClear();
    let resolveOrphan!: (value: typeof baselineAttachment) => void;
    const orphan = new Promise<typeof baselineAttachment>((resolve) => {
      resolveOrphan = resolve;
    });
    mockAttachTerminalOutput.mockReturnValueOnce(orphan);

    try {
      const { unmount } = render(
        <TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />,
      );
      await vi.waitFor(() => expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(1));
      unmount();
      const resetsAfterUnmount = mockReset.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
        resolveOrphan(baselineAttachment);
        await orphan;
        await Promise.resolve();
      });

      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(1);
      expect(mockReset).toHaveBeenCalledTimes(resetsAfterUnmount);
      expect(mockAcknowledgeTerminalOutput).not.toHaveBeenCalledWith(
        terminalId,
        expect.any(Number),
        expect.any(String),
        expect.any(Number),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps real attach orphans across successes and recovers once when one settles", async () => {
    vi.useFakeTimers();
    const terminalId = "t-output-attach-timeout-cap";
    const baselineAttachment = await mockAttachTerminalOutput();
    mockAttachTerminalOutput.mockClear();
    const resolveOrphans: Array<(value: typeof baselineAttachment) => void> = [];
    let operation = 0;
    mockAttachTerminalOutput.mockImplementation(() => {
      operation += 1;
      // Timeout and success alternate. The sixth timeout fills the resource
      // budget; operation 12 is admitted only after a real orphan settles.
      if (operation <= 11 && operation % 2 === 1) {
        return new Promise<typeof baselineAttachment>((resolve) => resolveOrphans.push(resolve));
      }
      return Promise.resolve({
        ...baselineAttachment,
        flowControl: { ...baselineAttachment.flowControl, token: `lease-success-${operation}` },
      });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      const { unmount } = render(
        <TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />,
      );
      await vi.waitFor(() => expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(mockOnTerminalOutput).toHaveBeenCalledWith(terminalId, expect.any(Function)),
      );
      const emitOutput = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as
        | ((data: Uint8Array | Record<string, unknown>) => void)
        | undefined;
      expect(emitOutput).toBeDefined();

      for (let orphan = 0; orphan < 6; orphan += 1) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(6_000);
        });
        if (orphan === 5) break;

        expect(mockAttachTerminalOutput).toHaveBeenCalledTimes((orphan + 1) * 2);
        await vi.waitFor(() => expect(mockReset.mock.calls.length).toBeGreaterThan(orphan));
        act(() => {
          emitOutput?.({ ...outputDelta(0, "X"), seqEnd: 2 });
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(100);
        });
        expect(mockAttachTerminalOutput).toHaveBeenCalledTimes((orphan + 1) * 2 + 1);
      }

      // Five successful replacements reset rate backoff, but the six orphan
      // bridge Promises are all still pending. A twelfth operation is blocked.
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(11);
      expect(terminalOutputRecoveryCounters(terminalId)).toMatchObject({ attachTimeout: 6 });
      const resetsAtCap = mockReset.mock.calls.length;

      await act(async () => {
        resolveOrphans[0]?.({
          ...baselineAttachment,
          flowControl: { ...baselineAttachment.flowControl, token: "lease-orphan-late" },
        });
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1_000);
      });
      await vi.waitFor(() => expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(12));
      await vi.waitFor(() => expect(mockReset.mock.calls.length).toBeGreaterThan(resetsAtCap));
      const resetsAfterCapacityRecovery = mockReset.mock.calls.length;
      expect(mockAcknowledgeTerminalOutput).not.toHaveBeenCalledWith(
        terminalId,
        expect.any(Number),
        "lease-orphan-late",
        expect.any(Number),
      );

      // A second late orphan only releases another slot. The cap waiter was
      // one-shot, so it cannot launch a duplicate recovery for the same epoch.
      await act(async () => {
        resolveOrphans[1]?.(baselineAttachment);
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(12);
      expect(mockReset).toHaveBeenCalledTimes(resetsAfterCapacityRecovery);
      unmount();
      for (const resolve of resolveOrphans.slice(2)) resolve(baselineAttachment);
    } finally {
      mockAttachTerminalOutput.mockReset();
      mockAttachTerminalOutput.mockResolvedValue(baselineAttachment);
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("shares the attach operation cap across pre-timeout remounts", async () => {
    vi.useFakeTimers();
    const terminalId = "t-output-attach-remount-cap";
    const baselineAttachment = await mockAttachTerminalOutput();
    mockAttachTerminalOutput.mockClear();
    const pendingAttaches = Array.from({ length: 6 }, () => {
      let resolve!: (value: typeof baselineAttachment) => void;
      const promise = new Promise<typeof baselineAttachment>((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    });
    let attachOperation = 0;
    mockAttachTerminalOutput.mockImplementation(() => {
      const operation = attachOperation;
      attachOperation += 1;
      if (operation < pendingAttaches.length) return pendingAttaches[operation].promise;
      return Promise.resolve({
        ...baselineAttachment,
        flowControl: { ...baselineAttachment.flowControl, token: `lease-current-${operation}` },
      });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let currentUnmount: (() => void) | undefined;

    try {
      for (let mount = 0; mount < 6; mount += 1) {
        const view = render(
          <TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />,
        );
        await vi.waitFor(() => expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(mount + 1));
        // The operation has not reached its 5 s watchdog. Unmount must still
        // leave its uncancellable bridge Promise charged to this terminal id.
        view.unmount();
      }

      const current = render(
        <TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />,
      );
      currentUnmount = current.unmount;
      await vi.waitFor(() => {
        expect(mockOnTerminalOutput.mock.calls.filter(([id]) => id === terminalId)).toHaveLength(7);
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(6);
      const resetsAtCap = mockReset.mock.calls.length;

      pendingAttaches[0].resolve({
        ...baselineAttachment,
        flowControl: { ...baselineAttachment.flowControl, token: "lease-stale-remount" },
      });
      await act(async () => {
        await pendingAttaches[0].promise;
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(100);
      });
      await vi.waitFor(() => expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(7));
      await vi.waitFor(() => expect(mockReset.mock.calls.length).toBeGreaterThan(resetsAtCap));
      const resetsAfterCurrentRecovery = mockReset.mock.calls.length;
      expect(mockAcknowledgeTerminalOutput).not.toHaveBeenCalledWith(
        terminalId,
        expect.any(Number),
        "lease-stale-remount",
        expect.any(Number),
      );

      pendingAttaches[1].resolve(baselineAttachment);
      await act(async () => {
        await pendingAttaches[1].promise;
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(7);
      expect(mockReset).toHaveBeenCalledTimes(resetsAfterCurrentRecovery);
    } finally {
      currentUnmount?.();
      for (const pending of pendingAttaches.slice(2)) pending.resolve(baselineAttachment);
      await Promise.all(pendingAttaches.map(({ promise }) => promise));
      mockAttachTerminalOutput.mockReset();
      mockAttachTerminalOutput.mockResolvedValue(baselineAttachment);
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("shares the ACK operation cap across pre-timeout remounts", async () => {
    vi.useFakeTimers();
    const terminalId = "t-output-ack-remount-cap";
    const baselineAttachment = await mockAttachTerminalOutput();
    mockAttachTerminalOutput.mockClear();
    let attachmentNumber = 0;
    mockAttachTerminalOutput.mockImplementation(() => {
      attachmentNumber += 1;
      return Promise.resolve({
        ...baselineAttachment,
        flowControl: {
          ...baselineAttachment.flowControl,
          token: `lease-ack-remount-${attachmentNumber}`,
        },
      });
    });
    const pendingAcks = Array.from({ length: 6 }, () => {
      let resolve!: (value: boolean) => void;
      const promise = new Promise<boolean>((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    });
    let ackOperation = 0;
    mockAcknowledgeTerminalOutput.mockImplementation(() => {
      const operation = ackOperation;
      ackOperation += 1;
      if (operation < pendingAcks.length) return pendingAcks[operation].promise;
      return Promise.resolve(true);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let currentUnmount: (() => void) | undefined;

    try {
      for (let mount = 0; mount < 6; mount += 1) {
        const view = render(
          <TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />,
        );
        await waitForTerminalInputReady();
        const emitOutput = mockOnTerminalOutput.mock.calls.filter(([id]) => id === terminalId)[
          mount
        ]?.[1] as ((data: Record<string, unknown>) => void) | undefined;
        expect(emitOutput).toBeDefined();
        act(() => emitOutput?.(outputDelta(0, "A")));
        await vi.waitFor(() =>
          expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledTimes(mount + 1),
        );
        view.unmount();
      }

      const current = render(
        <TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />,
      );
      currentUnmount = current.unmount;
      await waitForTerminalInputReady();
      const currentEmitter = mockOnTerminalOutput.mock.calls.filter(
        ([id]) => id === terminalId,
      )[6]?.[1] as ((data: Record<string, unknown>) => void) | undefined;
      expect(currentEmitter).toBeDefined();
      act(() => currentEmitter?.(outputDelta(0, "B")));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledTimes(6);
      const attachesAtCap = mockAttachTerminalOutput.mock.calls.length;
      const resetsAtCap = mockReset.mock.calls.length;

      pendingAcks[0].resolve(true);
      await act(async () => {
        await pendingAcks[0].promise;
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(100);
      });
      await vi.waitFor(() =>
        expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachesAtCap + 1),
      );
      await vi.waitFor(() => expect(mockReset.mock.calls.length).toBeGreaterThan(resetsAtCap));
      const resetsAfterCurrentRecovery = mockReset.mock.calls.length;
      expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledTimes(6);

      pendingAcks[1].resolve(true);
      await act(async () => {
        await pendingAcks[1].promise;
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachesAtCap + 1);
      expect(mockReset).toHaveBeenCalledTimes(resetsAfterCurrentRecovery);
      expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledTimes(6);
    } finally {
      currentUnmount?.();
      for (const pending of pendingAcks.slice(2)) pending.resolve(true);
      await Promise.all(pendingAcks.map(({ promise }) => promise));
      mockAttachTerminalOutput.mockReset();
      mockAttachTerminalOutput.mockResolvedValue(baselineAttachment);
      mockAcknowledgeTerminalOutput.mockReset();
      mockAcknowledgeTerminalOutput.mockResolvedValue(true);
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("caps pre-timeout attach operations across different terminal ids", async () => {
    vi.useFakeTimers();
    const terminalIds = Array.from({ length: 6 }, (_, index) => `t-global-attach-${index}`);
    const currentTerminalId = "t-global-attach-current";
    const baselineAttachment = await mockAttachTerminalOutput();
    mockAttachTerminalOutput.mockClear();
    const pendingAttaches = terminalIds.map(() => {
      let resolve!: (value: typeof baselineAttachment) => void;
      const promise = new Promise<typeof baselineAttachment>((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    });
    let attachOperation = 0;
    mockAttachTerminalOutput.mockImplementation(() => {
      const operation = attachOperation;
      attachOperation += 1;
      if (operation < pendingAttaches.length) return pendingAttaches[operation].promise;
      return Promise.resolve({
        ...baselineAttachment,
        flowControl: { ...baselineAttachment.flowControl, token: "lease-global-current" },
      });
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let currentUnmount: (() => void) | undefined;

    try {
      for (let index = 0; index < terminalIds.length; index += 1) {
        const view = render(
          <TerminalView instanceId={terminalIds[index]} profile="PowerShell" syncGroup="" />,
        );
        await vi.waitFor(() => expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(index + 1));
        view.unmount();
      }

      const current = render(
        <TerminalView instanceId={currentTerminalId} profile="PowerShell" syncGroup="" />,
      );
      currentUnmount = current.unmount;
      await vi.waitFor(() =>
        expect(mockOnTerminalOutput).toHaveBeenCalledWith(currentTerminalId, expect.any(Function)),
      );
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(6);
      const resetsAtCap = mockReset.mock.calls.length;

      pendingAttaches[0].resolve({
        ...baselineAttachment,
        flowControl: { ...baselineAttachment.flowControl, token: "lease-global-stale" },
      });
      await act(async () => {
        await pendingAttaches[0].promise;
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(100);
      });
      await vi.waitFor(() => expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(7));
      await vi.waitFor(() => expect(mockReset.mock.calls.length).toBeGreaterThan(resetsAtCap));
      const resetsAfterRecovery = mockReset.mock.calls.length;
      expect(mockAcknowledgeTerminalOutput).not.toHaveBeenCalledWith(
        terminalIds[0],
        expect.any(Number),
        "lease-global-stale",
        expect.any(Number),
      );

      pendingAttaches[1].resolve(baselineAttachment);
      await act(async () => {
        await pendingAttaches[1].promise;
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(7);
      expect(mockReset).toHaveBeenCalledTimes(resetsAfterRecovery);
    } finally {
      currentUnmount?.();
      for (const pending of pendingAttaches.slice(2)) pending.resolve(baselineAttachment);
      await Promise.all(pendingAttaches.map(({ promise }) => promise));
      mockAttachTerminalOutput.mockReset();
      mockAttachTerminalOutput.mockResolvedValue(baselineAttachment);
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("caps pre-timeout ACK operations across different terminal ids", async () => {
    vi.useFakeTimers();
    const terminalIds = Array.from({ length: 6 }, (_, index) => `t-global-ack-${index}`);
    const currentTerminalId = "t-global-ack-current";
    const baselineAttachment = await mockAttachTerminalOutput();
    mockAttachTerminalOutput.mockClear();
    let attachmentNumber = 0;
    mockAttachTerminalOutput.mockImplementation(() => {
      attachmentNumber += 1;
      return Promise.resolve({
        ...baselineAttachment,
        flowControl: {
          ...baselineAttachment.flowControl,
          token: `lease-global-ack-${attachmentNumber}`,
        },
      });
    });
    const pendingAcks = terminalIds.map(() => {
      let resolve!: (value: boolean) => void;
      const promise = new Promise<boolean>((resolvePromise) => {
        resolve = resolvePromise;
      });
      return { promise, resolve };
    });
    let ackOperation = 0;
    mockAcknowledgeTerminalOutput.mockImplementation(() => {
      const operation = ackOperation;
      ackOperation += 1;
      if (operation < pendingAcks.length) return pendingAcks[operation].promise;
      return Promise.resolve(true);
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let currentUnmount: (() => void) | undefined;

    try {
      for (const terminalId of terminalIds) {
        const view = render(
          <TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />,
        );
        await waitForTerminalInputReady();
        const emitOutput = mockOnTerminalOutput.mock.calls.find(
          ([registeredId]) => registeredId === terminalId,
        )?.[1] as ((data: Record<string, unknown>) => void) | undefined;
        expect(emitOutput).toBeDefined();
        act(() => emitOutput?.(outputDelta(0, "A")));
        await vi.waitFor(() =>
          expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledTimes(
            terminalIds.indexOf(terminalId) + 1,
          ),
        );
        view.unmount();
      }

      const current = render(
        <TerminalView instanceId={currentTerminalId} profile="PowerShell" syncGroup="" />,
      );
      currentUnmount = current.unmount;
      await waitForTerminalInputReady();
      const currentEmitter = mockOnTerminalOutput.mock.calls.find(
        ([registeredId]) => registeredId === currentTerminalId,
      )?.[1] as ((data: Record<string, unknown>) => void) | undefined;
      expect(currentEmitter).toBeDefined();
      act(() => currentEmitter?.(outputDelta(0, "B")));
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledTimes(6);
      const attachesAtCap = mockAttachTerminalOutput.mock.calls.length;
      const resetsAtCap = mockReset.mock.calls.length;

      pendingAcks[0].resolve(true);
      await act(async () => {
        await pendingAcks[0].promise;
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(100);
      });
      await vi.waitFor(() =>
        expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachesAtCap + 1),
      );
      await vi.waitFor(() => expect(mockReset.mock.calls.length).toBeGreaterThan(resetsAtCap));
      const resetsAfterRecovery = mockReset.mock.calls.length;
      expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledTimes(6);

      pendingAcks[1].resolve(true);
      await act(async () => {
        await pendingAcks[1].promise;
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachesAtCap + 1);
      expect(mockReset).toHaveBeenCalledTimes(resetsAfterRecovery);
      expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledTimes(6);
    } finally {
      currentUnmount?.();
      for (const pending of pendingAcks.slice(2)) pending.resolve(true);
      await Promise.all(pendingAcks.map(({ promise }) => promise));
      mockAttachTerminalOutput.mockReset();
      mockAttachTerminalOutput.mockResolvedValue(baselineAttachment);
      mockAcknowledgeTerminalOutput.mockReset();
      mockAcknowledgeTerminalOutput.mockResolvedValue(true);
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("replaces a token after a pending ACK timeout and ignores the late old ACK", async () => {
    vi.useFakeTimers();
    const terminalId = "t-output-ack-timeout";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const originalRecordRecovery = terminalOutputRecoveryMetrics.recordTerminalOutputRecovery;
    const recordRecovery = vi
      .spyOn(terminalOutputRecoveryMetrics, "recordTerminalOutputRecovery")
      .mockImplementation((id, event) => {
        const snapshot = originalRecordRecovery(id, event);
        if (event === "ackTimeout") throw new Error("poisoned diagnostic counter");
        return snapshot;
      });
    try {
      const baselineAttachment = await mockAttachTerminalOutput();
      mockAttachTerminalOutput.mockClear();
      const emitOutput = await attachedOutputEmitter(terminalId);
      const attachCalls = mockAttachTerminalOutput.mock.calls.length;
      const oldBytes = Array.from(new TextEncoder().encode("old"));
      mockAttachTerminalOutput.mockResolvedValueOnce({
        ...baselineAttachment,
        state: {
          ...baselineAttachment.state,
          snapshotSeq: oldBytes.length,
          sourceSeq: oldBytes.length,
        },
        snapshot: oldBytes,
        flowControl: { ...baselineAttachment.flowControl, token: "lease-2" },
      });
      let resolveOldAck!: (accepted: boolean) => void;
      const oldAck = new Promise<boolean>((resolve) => {
        resolveOldAck = resolve;
      });
      mockAcknowledgeTerminalOutput.mockClear();
      mockAcknowledgeTerminalOutput.mockReturnValueOnce(oldAck).mockResolvedValue(true);

      act(() => emitOutput(outputDelta(0, "old")));
      await vi.waitFor(() =>
        expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledWith(terminalId, 1, "lease-1", 3),
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(4_999);
      });
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachCalls);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_001);
      });
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachCalls + 1);
      await vi.waitFor(() =>
        expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledWith(terminalId, 1, "lease-2", 3),
      );

      resolveOldAck(true);
      await act(async () => {
        await oldAck;
        await Promise.resolve();
      });
      act(() => emitOutput(outputDelta(3, "new")));
      await vi.waitFor(() =>
        expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledWith(terminalId, 1, "lease-2", 6),
      );
      expect(
        mockAcknowledgeTerminalOutput.mock.calls.filter(([, , token]) => token === "lease-1"),
      ).toHaveLength(1);
      expect(terminalOutputRecoveryCounters(terminalId)).toMatchObject({ ackTimeout: 1 });
    } finally {
      recordRecovery.mockRestore();
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps the Tauri event callback no-throw when live processing fails synchronously", async () => {
    const terminalId = "t-output-listener-sync-failure";
    const emitOutput = await attachedOutputEmitter(terminalId);
    const attachCalls = mockAttachTerminalOutput.mock.calls.length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockTerminalRenderCheckpointApply.mockImplementationOnce(() => {
      throw new Error("synchronous checkpoint failure");
    });

    try {
      expect(() => emitOutput(outputDelta(0, "sync-failure"))).not.toThrow();
      await vi.waitFor(() =>
        expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachCalls + 1),
      );
      expect(terminalOutputRecoveryCounters(terminalId).malformedDelta).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  it("merges output deltas that arrive while xterm is still parsing (issue #606)", async () => {
    const terminalId = "t-output-backlog-coalesce";
    const emitOutput = await attachedOutputEmitter(terminalId);

    // Park the next write so the surface is provably behind while more deltas
    // land — the flood condition, without needing a flood.
    const finishWrites: Array<() => void> = [];
    mockWrite.mockClear();
    mockWrite.mockImplementationOnce((_: string | Uint8Array, callback?: () => void) => {
      if (callback) finishWrites.push(callback);
    });

    act(() => emitOutput(outputDelta(0, "one")));
    // The first delta went straight through: an idle surface must not be delayed.
    expect(decodedWrites()).toEqual(["one"]);

    act(() => {
      emitOutput(outputDelta(3, "two"));
      emitOutput(outputDelta(6, "three"));
      emitOutput(outputDelta(11, "four"));
    });
    // Held, not written: nothing may reach xterm while it still owes a callback.
    expect(decodedWrites()).toEqual(["one"]);

    act(() => finishWrites[0]?.());

    // Three logical writes, one physical xterm write. Stabilizer and detector
    // boundaries stay untouched; only the renderer-facing FIFO may batch.
    await vi.waitFor(() => {
      expect(decodedWrites()).toEqual(["one", "twothreefour"]);
    });
    expect(writtenStream()).toBe("onetwothreefour");
    expect(terminalOutputRecoveryCounters(terminalId)).toMatchObject({
      gap: 0,
      repair: 0,
      malformedDelta: 0,
    });
  });

  it("coalesces four 64 KiB enqueue quanta for a sole owner (#661)", async () => {
    const terminalId = "t-output-fair-sole-owner";
    const emitOutput = await attachedOutputEmitter(terminalId);
    const flood = "x".repeat(256 * 1024);
    mockWrite.mockClear();

    act(() => emitOutput(outputDelta(0, flood)));

    await vi.waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(1));
    const physical = mockWrite.mock.calls[0]?.[0] as Uint8Array;
    expect(physical).toBeInstanceOf(Uint8Array);
    expect(physical.byteLength).toBe(256 * 1024);
    expect(terminalOutputPipelineCounters(terminalId).writeBatchMaxParts).toBe(4);
  });

  it("slices non-stabilized replay into independent 64 KiB physical writes (#661)", async () => {
    const terminalId = "t-output-fair-replay-quantum";
    const defaultAttachment = await mockAttachTerminalOutput();
    mockAttachTerminalOutput.mockClear();
    const replay = new Uint8Array(2 * 64 * 1024 + 17);
    for (let index = 0; index < replay.length; index += 1) replay[index] = index % 251;
    mockAttachTerminalOutput.mockResolvedValueOnce({
      ...defaultAttachment,
      state: {
        ...defaultAttachment.state,
        snapshotSeq: replay.length,
        sourceSeq: replay.length,
      },
      snapshot: Array.from(replay),
    });
    const writes: Array<{ data: Uint8Array; sourceType: "bytes" | "string" }> = [];
    const completions: Array<() => void> = [];
    const pendingCompletions = new Set<() => void>();
    let completed = 0;
    mockWrite.mockImplementation((data: string | Uint8Array, callback?: () => void) => {
      writes.push({
        data: typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data),
        sourceType: typeof data === "string" ? "string" : "bytes",
      });
      let settled = false;
      const complete = () => {
        if (settled) return;
        settled = true;
        pendingCompletions.delete(complete);
        completed += 1;
        callback?.();
      };
      pendingCompletions.add(complete);
      completions.push(complete);
    });

    let view: ReturnType<typeof render> | undefined;
    try {
      view = render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      expect(writes[0]).toMatchObject({ sourceType: "bytes" });
      expect(writes[0].data).toHaveLength(64 * 1024);
      act(() => completions[0]?.());
      await vi.waitFor(() => expect(writes).toHaveLength(2));
      expect(writes[1].data).toHaveLength(64 * 1024);
      act(() => completions[1]?.());
      await vi.waitFor(() => expect(writes).toHaveLength(3));
      expect(writes[2].data).toHaveLength(17);
      act(() => completions[2]?.());
      // The attach pipeline applies the authoritative bracketed-paste mode as a
      // string only after every replay callback. It remains one atomic write.
      await vi.waitFor(() => expect(writes).toHaveLength(4));
      expect(writes[3]).toMatchObject({ sourceType: "string" });
      act(() => completions[3]?.());
      await waitForTerminalInputReady();

      const replayWrites = writes.filter(({ sourceType }) => sourceType === "bytes");
      const concatenated = new Uint8Array(
        replayWrites.reduce((total, part) => total + part.data.length, 0),
      );
      let offset = 0;
      for (const part of replayWrites) {
        concatenated.set(part.data, offset);
        offset += part.data.length;
      }
      expect(concatenated).toEqual(replay);
      expect(replayWrites).toHaveLength(3);
      expect(completed).toBe(4);
      expect(terminalOutputPipelineCounters(terminalId).writeBatchMaxParts).toBe(1);
    } finally {
      await act(async () => {
        // A failed intermediate assertion must not leave an accepted xterm
        // callback holding the app-global fair-scheduler lease.
        while (pendingCompletions.size > 0) {
          pendingCompletions.values().next().value?.();
          await Promise.resolve();
        }
        view?.unmount();
        await Promise.resolve();
      });
      mockWrite.mockReset();
      mockWrite.mockImplementation(completeMockWrite);
    }
    expect(terminalWriteFairScheduler.isIdleForTests()).toBe(true);
  });

  it("rotates physical writes across flooded panes before returning to the same pane (#661)", async () => {
    const paneA = "t-output-fair-a";
    const paneB = "t-output-fair-b";
    const createdTerminalBaseline = createdTerminals.length;
    const view = render(
      <>
        <TerminalView instanceId={paneA} profile="PowerShell" syncGroup="" />
        <TerminalView instanceId={paneB} profile="PowerShell" syncGroup="" />
      </>,
    );
    const writes: string[] = [];
    let finishPaneAFirst: (() => void) | undefined;
    try {
      await vi.waitFor(() => {
        expect(mockOnTerminalOutput).toHaveBeenCalledWith(paneA, expect.any(Function));
        expect(mockOnTerminalOutput).toHaveBeenCalledWith(paneB, expect.any(Function));
        expect(createdTerminals.slice(createdTerminalBaseline)).toHaveLength(2);
      });
      await waitForStreamAttachReset();

      const emitter = (terminalId: string) =>
        mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as (
          data: Uint8Array | Record<string, unknown>,
        ) => void;
      type WritableTerminal = MockTerminalInstance & {
        write: (data: string | Uint8Array, callback?: () => void) => void;
      };
      const [terminalA, terminalB] = createdTerminals.slice(createdTerminalBaseline) as [
        WritableTerminal,
        WritableTerminal,
      ];
      terminalA.write = (data, callback) => {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        writes.push(`a:${text}`);
        if (text === "one") {
          let settled = false;
          finishPaneAFirst = () => {
            if (settled) return;
            settled = true;
            finishPaneAFirst = undefined;
            callback?.();
          };
        } else callback?.();
      };
      terminalB.write = (data, callback) => {
        const text = typeof data === "string" ? data : new TextDecoder().decode(data);
        writes.push(`b:${text}`);
        callback?.();
      };

      act(() => emitter(paneA)(outputDelta(0, "one")));
      expect(writes).toEqual(["a:one"]);

      act(() => {
        emitter(paneA)(outputDelta(3, "two"));
        emitter(paneB)(outputDelta(0, "other"));
      });
      await vi.waitFor(() => {
        expect(terminalOutputPipelineCounters(paneA).writeQueueMaxDepth).toBeGreaterThanOrEqual(1);
        expect(terminalOutputPipelineCounters(paneB).writeQueueMaxDepth).toBeGreaterThanOrEqual(1);
      });
      expect(writes).toEqual(["a:one"]);

      act(() => finishPaneAFirst?.());
      await vi.waitFor(() => expect(writes).toEqual(["a:one", "b:other", "a:two"]));
    } finally {
      await act(async () => {
        finishPaneAFirst?.();
        view.unmount();
        await Promise.resolve();
      });
    }
    expect(terminalWriteFairScheduler.isIdleForTests()).toBe(true);
  });

  it("limits a contended pane turn to one 64 KiB enqueue quantum (#661)", async () => {
    const paneA = "t-output-fair-quantum-a";
    const paneB = "t-output-fair-quantum-b";
    const createdTerminalBaseline = createdTerminals.length;
    const view = render(
      <>
        <TerminalView instanceId={paneA} profile="PowerShell" syncGroup="" />
        <TerminalView instanceId={paneB} profile="PowerShell" syncGroup="" />
      </>,
    );
    const pendingPhysicalWrites: Array<{
      pane: "a" | "b";
      complete: () => void;
    }> = [];
    try {
      await vi.waitFor(() => {
        expect(mockOnTerminalOutput).toHaveBeenCalledWith(paneA, expect.any(Function));
        expect(mockOnTerminalOutput).toHaveBeenCalledWith(paneB, expect.any(Function));
        expect(createdTerminals.slice(createdTerminalBaseline)).toHaveLength(2);
      });
      await waitForStreamAttachReset();

      const emitter = (terminalId: string) =>
        mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as (
          data: Uint8Array | Record<string, unknown>,
        ) => void;
      type WritableTerminal = MockTerminalInstance & {
        write: (data: string | Uint8Array, callback?: () => void) => void;
      };
      const [terminalA, terminalB] = createdTerminals.slice(createdTerminalBaseline) as [
        WritableTerminal,
        WritableTerminal,
      ];
      const aWrites: Uint8Array[] = [];
      const bWrites: Uint8Array[] = [];
      let aCallbacksCompleted = 0;
      let bCallbacksCompleted = 0;
      let duplicateCallbacks = 0;
      terminalA.write = (data, callback) => {
        aWrites.push(
          typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data),
        );
        let settled = false;
        const complete = () => {
          if (settled) {
            duplicateCallbacks += 1;
            return;
          }
          settled = true;
          aCallbacksCompleted += 1;
          callback?.();
        };
        pendingPhysicalWrites.push({ pane: "a", complete });
      };
      terminalB.write = (data, callback) => {
        bWrites.push(
          typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data),
        );
        let settled = false;
        const complete = () => {
          if (settled) {
            duplicateCallbacks += 1;
            return;
          }
          settled = true;
          bCallbacksCompleted += 1;
          callback?.();
        };
        pendingPhysicalWrites.push({ pane: "b", complete });
      };

      const completeNextPhysicalWrite = async (expectedPane?: "a" | "b") => {
        await vi.waitFor(() => expect(pendingPhysicalWrites.length).toBeGreaterThan(0));
        const pending = pendingPhysicalWrites.shift();
        expect(pending).toBeDefined();
        await act(async () => {
          pending?.complete();
          await Promise.resolve();
        });
        if (expectedPane !== undefined) expect(pending?.pane).toBe(expectedPane);
      };

      const firstA = "hold-a";
      const firstB = "hold-b";
      const aFlood = "a".repeat(256 * 1024);
      const bFlood = "b".repeat(256 * 1024);
      const expectedA = new TextEncoder().encode(firstA + aFlood);
      const expectedB = new TextEncoder().encode(firstB + bFlood);
      const attachCallsAfterInitial = mockAttachTerminalOutput.mock.calls.length;
      mockAcknowledgeTerminalOutput.mockClear();
      act(() => emitter(paneA)(outputDelta(0, firstA)));
      expect(aWrites.map(({ length }) => length)).toEqual([firstA.length]);

      act(() => {
        emitter(paneA)(outputDelta(firstA.length, aFlood));
        emitter(paneB)(outputDelta(0, firstB));
      });
      await completeNextPhysicalWrite("a");
      await vi.waitFor(() => expect(bWrites.map(({ length }) => length)).toEqual([firstB.length]));

      act(() => emitter(paneB)(outputDelta(firstB.length, bFlood)));
      await vi.waitFor(() =>
        expect(terminalOutputPipelineCounters(paneB).writeQueueMaxBytes).toBeGreaterThanOrEqual(
          256 * 1024,
        ),
      );
      await completeNextPhysicalWrite("b");

      const byteLength = (parts: readonly Uint8Array[]) =>
        parts.reduce((total, part) => total + part.length, 0);
      while (
        byteLength(aWrites) < expectedA.length ||
        byteLength(bWrites) < expectedB.length ||
        aCallbacksCompleted < aWrites.length ||
        bCallbacksCompleted < bWrites.length
      ) {
        await completeNextPhysicalWrite();
      }
      expect(byteLength(aWrites)).toBe(expectedA.length);
      expect(byteLength(bWrites)).toBe(expectedB.length);
      expect(aCallbacksCompleted).toBe(aWrites.length);
      expect(bCallbacksCompleted).toBe(bWrites.length);
      expect(aWrites[1]).toHaveLength(64 * 1024);
      const concatenate = (parts: readonly Uint8Array[]) => {
        const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
        let offset = 0;
        for (const part of parts) {
          result.set(part, offset);
          offset += part.length;
        }
        return result;
      };
      const expectExactBytes = (label: string, actual: Uint8Array, expected: Uint8Array) => {
        expect(actual.byteLength, `${label}: actual/expected byte length`).toBe(
          expected.byteLength,
        );
        let firstMismatch = -1;
        for (let index = 0; index < expected.byteLength; index += 1) {
          if (actual[index] !== expected[index]) {
            firstMismatch = index;
            break;
          }
        }
        const mismatchDetail =
          firstMismatch < 0
            ? "none"
            : `${firstMismatch} (actual=${actual[firstMismatch]}, expected=${expected[firstMismatch]})`;
        expect(
          firstMismatch,
          `${label}: actual length=${actual.byteLength}, expected length=${expected.byteLength}, first mismatch=${mismatchDetail}`,
        ).toBe(-1);
      };
      expectExactBytes("pane A", concatenate(aWrites), expectedA);
      expectExactBytes("pane B", concatenate(bWrites), expectedB);
      expect(duplicateCallbacks).toBe(0);
      await vi.waitFor(() => {
        expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledWith(
          paneA,
          1,
          "lease-1",
          expectedA.length,
        );
        expect(mockAcknowledgeTerminalOutput).toHaveBeenCalledWith(
          paneB,
          1,
          "lease-1",
          expectedB.length,
        );
      });
      const finalAckCount = (terminalId: string, seq: number) =>
        mockAcknowledgeTerminalOutput.mock.calls.filter(
          ([id, _generation, _token, acknowledgedSeq]) =>
            id === terminalId && acknowledgedSeq === seq,
        ).length;
      expect(finalAckCount(paneA, expectedA.length)).toBe(1);
      expect(finalAckCount(paneB, expectedB.length)).toBe(1);
      // A rejected/discarded physical entry schedules a replacement attach. Both
      // queues reached final parsed credit without that recovery path.
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(attachCallsAfterInitial);
    } finally {
      await act(async () => {
        while (pendingPhysicalWrites.length > 0) {
          pendingPhysicalWrites.shift()?.complete();
          await Promise.resolve();
        }
        view.unmount();
        await Promise.resolve();
      });
    }
    expect(terminalWriteFairScheduler.isIdleForTests()).toBe(true);
  });

  it("discards queued old-epoch writes and drains the in-flight parse before reattach", async () => {
    const terminalId = "t-output-reattach-write-cutover";
    const emitOutput = await attachedOutputEmitter(terminalId);
    let finishInFlight: (() => void) | undefined;
    mockWrite.mockClear();
    mockReset.mockClear();
    mockWrite.mockImplementationOnce((_, callback?: () => void) => {
      finishInFlight = callback;
    });

    const inFlight = "old-in-flight";
    const queued = "old-queued";
    act(() => {
      emitOutput(outputDelta(0, inFlight));
      emitOutput(outputDelta(inFlight.length, queued));
    });
    expect(decodedWrites()).toEqual([inFlight]);

    // Malformed sequence metadata forces the screen-losing reattach path while
    // one old write is parsing and another is queued behind it.
    act(() => {
      emitOutput({
        ...outputDelta(inFlight.length + queued.length, "X"),
        seqEnd: inFlight.length + queued.length + 2,
      });
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));

    expect(mockReset).not.toHaveBeenCalled();
    expect(writtenStream()).toBe(inFlight);

    act(() => finishInFlight?.());
    await vi.waitFor(() => expect(mockReset).toHaveBeenCalled());
    expect(writtenStream()).not.toContain(queued);
  });

  it("does not enqueue an invalidated attach segment after its checkpoint await", async () => {
    const terminalId = "t-output-reattach-checkpoint-cutover";
    const stale = "stale-after-checkpoint";
    const attachment = await mockAttachTerminalOutput();
    mockAttachTerminalOutput.mockClear();

    let resolveInitialAttach!: (value: typeof attachment) => void;
    const initialAttach = new Promise<typeof attachment>((resolve) => {
      resolveInitialAttach = resolve;
    });
    mockAttachTerminalOutput.mockReturnValueOnce(initialAttach).mockResolvedValueOnce(attachment);

    let releaseCheckpoint!: () => void;
    const checkpointHeld = new Promise<void>((resolve) => {
      releaseCheckpoint = resolve;
    });
    mockTerminalRenderCheckpointApply.mockImplementationOnce(() => checkpointHeld);

    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => {
      expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(1);
      expect(mockOnTerminalOutput).toHaveBeenCalledWith(terminalId, expect.any(Function));
    });
    const emitOutput = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as
      | ((data: Uint8Array | Record<string, unknown>) => void)
      | undefined;
    expect(emitOutput).toBeDefined();

    act(() => emitOutput?.(outputDelta(0, stale)));
    await act(async () => {
      resolveInitialAttach(attachment);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(mockTerminalRenderCheckpointApply).toHaveBeenCalledTimes(1));

    // The old attach is parked after its checkpoint accepted the segment but
    // before the visible xterm enqueue. Invalidate that epoch at precisely this
    // await boundary; the replacement attach is allowed to complete normally.
    const resetsBeforeReattach = mockReset.mock.calls.length;
    mockWrite.mockClear();
    act(() => {
      emitOutput?.({
        ...outputDelta(stale.length, "X"),
        seqEnd: stale.length + 2,
      });
    });
    await vi.waitFor(() => expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(2));

    await act(async () => {
      releaseCheckpoint();
      await checkpointHeld;
    });
    await vi.waitFor(() => {
      expect(mockReset.mock.calls.length).toBeGreaterThan(resetsBeforeReattach);
    });
    expect(writtenStream()).not.toContain(stale);
  });

  it("settles a discarded queued replay so the replacement attach can reset", async () => {
    const terminalId = "t-output-reattach-queued-replay";
    const replay = new TextEncoder().encode("queued-replay-snapshot");
    const replayAttachment = {
      state: {
        version: 1,
        generation: 1,
        snapshotStartSeq: 0,
        snapshotSeq: replay.length,
        sourceStartSeq: 0,
        sourceSeq: replay.length,
        snapshotKind: "raw",
        protocolRevision: 0,
        modes: { bracketedPaste: false },
        geometry,
      },
      snapshot: Array.from(replay),
      flowControl: { token: "lease-replay", windowBytes: 524288 },
    };
    const replacementAttachment = {
      ...replayAttachment,
      state: {
        ...replayAttachment.state,
        snapshotSeq: 0,
        sourceSeq: 0,
      },
      snapshot: [],
      flowControl: { token: "lease-gap", windowBytes: 524288 },
    };
    mockAttachTerminalOutput
      .mockResolvedValueOnce(replayAttachment)
      .mockResolvedValueOnce(replacementAttachment);
    mockWrite.mockImplementation(() => {
      throw new Error("write data discarded");
    });

    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await vi.waitFor(() => {
      expect(decodedWrites()).toContain("queued-replay-snapshot");
      expect(mockOnTerminalOutput).toHaveBeenCalledWith(terminalId, expect.any(Function));
    });
    const emitOutput = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as
      | ((data: Uint8Array | Record<string, unknown>) => void)
      | undefined;
    expect(emitOutput).toBeDefined();
    const resetsBeforeReattach = mockReset.mock.calls.length;

    // The replay batch was restored at the queue head after xterm rejected it.
    // A malformed live payload clears that queue and starts a replacement attach.
    // Its discard path must settle the old replay Promise, or the serialized
    // replacement chain can never reach terminal.reset().
    act(() => {
      emitOutput?.({ seqStart: 0, seqEnd: 2, data: [0x58] });
    });
    mockWrite.mockImplementation((_: string | Uint8Array, callback?: () => void) => {
      callback?.();
    });
    await vi.waitFor(() => expect(mockAttachTerminalOutput).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(mockReset.mock.calls.length).toBeGreaterThan(resetsBeforeReattach);
    });
  });

  it("does not let a post-parse callback failure poison xterm flow-control accounting", async () => {
    const terminalId = "t-output-callback-flow-control";
    mockCreateTerminalSession.mockResolvedValueOnce({
      id: terminalId,
      title: "Terminal",
      initialExecutionHost: "nativeWindows",
      config: {
        profile: "PowerShell",
        cols: 80,
        rows: 24,
        sync_group: "",
        env: [],
        advertise_true_color: true,
      },
    });
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    const emitOutput = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId)?.[1] as
      | ((data: Uint8Array | Record<string, unknown>) => void)
      | undefined;
    expect(emitOutput).toBeDefined();

    // xterm 6.0.0 drains one queued write at a time and schedules the next drain
    // only after the embedder callback returns. If that callback escapes, a
    // later small write is still accepted into the FIFO but no new drain is
    // scheduled, so its callback never arrives and the pane stalls.
    const acceptedWrites: string[] = [];
    const accountedWrites: string[] = [];
    const callbackErrors: unknown[] = [];
    const xtermQueue: Array<{
      text: string;
      callback?: () => void;
    }> = [];
    let xtermDrainActive = false;
    const scheduleXtermDrain = () => {
      if (xtermDrainActive || xtermQueue.length === 0) return;
      xtermDrainActive = true;
      setTimeout(() => {
        const accepted = xtermQueue.shift()!;
        try {
          accepted.callback?.();
          accountedWrites.push(accepted.text);
          xtermDrainActive = false;
          scheduleXtermDrain();
        } catch (error) {
          callbackErrors.push(error);
          // Deliberately leave the accepted FIFO in xterm's poisoned
          // single-flight state: there is no follow-up drain task.
        }
      }, 0);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const countersBefore = terminalOutputPipelineCounters(terminalId);
    mockWrite.mockClear();
    mockWrite.mockImplementation((data, callback?: () => void) => {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      acceptedWrites.push(text);
      xtermQueue.push({ text, callback });
      scheduleXtermDrain();
    });
    mockRefresh.mockImplementation(() => {
      throw new Error("renderer settle failed");
    });

    const frame = "\x1b[?2026hbody\x1b[?25h\x1b[?2026l\x1b[?25l\x1b[3;4H\x1b[?25h";
    try {
      act(() => {
        emitOutput?.(new TextEncoder().encode(frame));
        emitOutput?.(new TextEncoder().encode(frame));
        emitOutput?.(new TextEncoder().encode("tail"));
      });

      await vi.waitFor(() => expect(accountedWrites).toHaveLength(3), { timeout: 1_000 });
      expect(callbackErrors).toEqual([]);
      expect(xtermQueue).toEqual([]);
      expect(xtermDrainActive).toBe(false);
      expect(acceptedWrites).toHaveLength(3);
      expect(acceptedWrites.filter((write) => write === "tail")).toHaveLength(1);
      const countersAfter = terminalOutputPipelineCounters(terminalId);
      expect(countersAfter.writeBackpressure - countersBefore.writeBackpressure).toBe(0);
      expect(countersAfter.writeCallbackFailures - countersBefore.writeCallbackFailures).toBe(2);
      expect(
        countersAfter.writeCallbackLiveFailures - countersBefore.writeCallbackLiveFailures,
      ).toBe(2);
      expect(
        countersAfter.writeCallbackRefreshFailures - countersBefore.writeCallbackRefreshFailures,
      ).toBe(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "[TerminalView] xterm write callback failed:",
        expect.objectContaining({
          source: "live",
          failures: [{ stage: "refresh", message: "renderer settle failed" }],
        }),
      );
    } finally {
      mockWrite.mockImplementation((_: string | Uint8Array, callback?: () => void) => {
        callback?.();
      });
      mockRefresh.mockImplementation(() => {});
      warn.mockRestore();
    }
  });

  it("keeps physical write boundaries while an IME composition is active", async () => {
    const terminalId = "t-output-backlog-ime-boundary";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" isFocused />);
    const terminal = createdTerminals.at(-1)!;
    const helper = document.createElement("textarea");
    helper.className = "xterm-helper-textarea";
    terminal.element.appendChild(helper);
    await waitForTerminalInputReady();
    const registered = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId);
    const emitOutput = registered?.[1] as
      | ((data: Uint8Array | Record<string, unknown>) => void)
      | undefined;
    expect(emitOutput).toBeDefined();

    let finishFirstWrite: (() => void) | undefined;
    mockWrite.mockClear();
    mockWrite.mockImplementationOnce((_, callback?: () => void) => {
      finishFirstWrite = callback;
    });
    act(() => emitOutput?.(outputDelta(0, "one")));
    act(() => {
      helper.dispatchEvent(new CompositionEvent("compositionstart", { data: "" }));
      helper.value = "ㄱ";
      helper.dispatchEvent(new CompositionEvent("compositionupdate", { data: "ㄱ" }));
      helper.dispatchEvent(new Event("input", { bubbles: true }));
      emitOutput?.(outputDelta(3, "two"));
      emitOutput?.(outputDelta(6, "three"));
    });

    act(() => finishFirstWrite?.());
    await vi.waitFor(() => expect(decodedWrites()).toEqual(["one", "two", "three"]));
  });

  it("drains old-grid writes before a deferred fit", async () => {
    const terminalId = "t-output-backlog-fit-order";
    const paneId = "pane-output-backlog-fit-order";
    render(
      <TerminalView instanceId={terminalId} paneId={paneId} profile="PowerShell" syncGroup="" />,
    );
    await waitForTerminalInputReady();
    const registered = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId);
    const emitOutput = registered?.[1] as
      | ((data: Uint8Array | Record<string, unknown>) => void)
      | undefined;
    expect(emitOutput).toBeDefined();
    const order: string[] = [];
    let finishFirstWrite: (() => void) | undefined;
    let firstWrite = true;
    mockWrite.mockClear();
    mockFit.mockClear();
    mockRequestAnimationFrame.mockClear();
    mockWrite.mockImplementation((data, callback?: () => void) => {
      const text = typeof data === "string" ? data : new TextDecoder().decode(data);
      order.push(`write:${text}`);
      if (firstWrite) {
        firstWrite = false;
        finishFirstWrite = callback;
      } else {
        callback?.();
      }
    });
    mockFit.mockImplementation(() => {
      order.push("fit");
    });

    try {
      act(() => {
        emitOutput?.(outputDelta(0, "one"));
        emitOutput?.(outputDelta(3, "two"));
        useOverridesStore.getState().setViewOverride(paneId, { fontSize: 20 });
      });
      await vi.waitFor(() => expect(mockRequestAnimationFrame).toHaveBeenCalled());
      expect(mockFit).not.toHaveBeenCalled();

      act(() => finishFirstWrite?.());
      await vi.waitFor(() => expect(order).toEqual(["write:one", "write:two", "fit"]));
    } finally {
      mockWrite.mockImplementation((_: string | Uint8Array, callback?: () => void) => {
        callback?.();
      });
      mockFit.mockImplementation(() => {});
    }
  });

  it("releases a deferred fit after an unexpected synchronous xterm write failure", async () => {
    const terminalId = "t-output-backlog-write-failure-fit";
    const paneId = "pane-output-backlog-write-failure-fit";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    render(
      <TerminalView instanceId={terminalId} paneId={paneId} profile="PowerShell" syncGroup="" />,
    );
    await waitForTerminalInputReady();
    const registered = mockOnTerminalOutput.mock.calls.find(([id]) => id === terminalId);
    const emitOutput = registered?.[1] as
      | ((data: Uint8Array | Record<string, unknown>) => void)
      | undefined;
    expect(emitOutput).toBeDefined();

    let finishFirstWrite: (() => void) | undefined;
    let writeAttempt = 0;
    mockWrite.mockClear();
    mockFit.mockClear();
    mockRequestAnimationFrame.mockClear();
    mockWrite.mockImplementation((_, callback?: () => void) => {
      writeAttempt += 1;
      if (writeAttempt === 1) {
        finishFirstWrite = callback;
        return;
      }
      if (writeAttempt === 2) throw new Error("unexpected renderer failure");
      callback?.();
    });
    const attachCallsBeforeFailure = mockAttachTerminalOutput.mock.calls.length;

    try {
      act(() => {
        emitOutput?.(outputDelta(0, "one"));
        emitOutput?.(outputDelta(3, "two"));
        useOverridesStore.getState().setViewOverride(paneId, { fontSize: 20 });
      });
      await vi.waitFor(() => expect(mockRequestAnimationFrame).toHaveBeenCalled());
      expect(mockFit).not.toHaveBeenCalled();

      act(() => finishFirstWrite?.());
      // Attempt 2 rejects the deferred tail exactly once. Parsed credit then
      // performs its required reattach, whose normal mode-sync write is attempt
      // 3; that is recovery work, not a duplicate retry of the rejected bytes.
      await vi.waitFor(() => expect(mockWrite).toHaveBeenCalledTimes(3));
      expect(mockAttachTerminalOutput.mock.calls.length).toBe(attachCallsBeforeFailure + 1);
      await vi.waitFor(() => expect(mockFit).toHaveBeenCalledTimes(1));
      expect(warn).toHaveBeenCalledWith(
        "[TerminalView] xterm write failed:",
        expect.objectContaining({ message: "unexpected renderer failure" }),
      );
    } finally {
      mockWrite.mockImplementation((_: string | Uint8Array, callback?: () => void) => {
        callback?.();
      });
      mockFit.mockImplementation(() => {});
      warn.mockRestore();
    }
  });

  it("keeps ordered detector transitions while batching the visible writes", async () => {
    const terminalId = "t-output-backlog-detector-order";
    const emitOutput = await attachedOutputEmitter(terminalId);
    const finishWrites: Array<() => void> = [];
    mockWrite.mockClear();
    mockWrite.mockImplementationOnce((_: string | Uint8Array, callback?: () => void) => {
      if (callback) finishWrites.push(callback);
    });

    act(() => {
      useTerminalStore.getState().updateInstanceInfo(terminalId, {
        activity: { type: "running" },
      });
      emitOutput(outputDelta(0, "busy"));
      emitOutput(outputDelta(4, "\x1b[?1049h"));
      emitOutput(outputDelta(12, "\x1b[?1049l"));
    });

    // The raw detector must see enter then leave immediately, even though both
    // byte writes are waiting behind the first xterm parse. Merging them before
    // detection makes `enterAlt && leaveAlt` true and silently ignores both.
    expect(
      useTerminalStore.getState().instances.find(({ id }) => id === terminalId)?.activity,
    ).toEqual({ type: "shell" });

    act(() => finishWrites[0]?.());
    await vi.waitFor(() => expect(writtenStream()).toBe("busy\x1b[?1049h\x1b[?1049l"));
  });

  it("repairs an output delta gap from the ring without resetting the screen", async () => {
    const terminalId = "t-output-gap-repair";
    const emitOutput = await attachedOutputEmitter(terminalId);

    act(() => emitOutput(outputDelta(0, "AAAAA")));

    mockWrite.mockClear();
    mockReset.mockClear();
    const attachCallsBeforeGap = mockAttachTerminalOutput.mock.calls.length;
    mockResumeTerminalOutput.mockClear();
    mockResumeTerminalOutput.mockResolvedValueOnce(outputDelta(5, "BBB"));

    // The `[5, 8)` event never arrived; the surface sees `[8, 10)` instead.
    act(() => emitOutput(outputDelta(8, "CC")));

    expect(mockResumeTerminalOutput).toHaveBeenCalledWith(terminalId, 1, 5);
    await vi.waitFor(() => expect(writtenStream()).toBe("BBBCC"));
    expect(mockReset).not.toHaveBeenCalled();
    expect(mockAttachTerminalOutput.mock.calls.length).toBe(attachCallsBeforeGap);
    expect(terminalOutputRecoveryCounters(terminalId)).toMatchObject({
      gap: 1,
      repair: 1,
      ringEscalation: 0,
    });

    // The repaired stream stays contiguous: the next delta is not another gap.
    mockResumeTerminalOutput.mockClear();
    act(() => emitOutput(outputDelta(10, "DD")));
    expect(mockResumeTerminalOutput).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(writtenStream()).toBe("BBBCCDD"));
  });

  // ADR-0072 hangs its "revisit the ring size / checkpoint reuse" condition on
  // `ringEscalation`, so each escalation must land in its own bucket. Every one
  // of these ends in the same visible outcome (a full reattach), which is why
  // asserting the attach count alone would not catch a misfiled counter.
  it("counts only a ring that cannot bridge the gap as a ring escalation", async () => {
    const terminalId = "t-output-gap-escalation";
    const emitOutput = await attachedOutputEmitter(terminalId);

    act(() => emitOutput(outputDelta(0, "AAAAA")));

    const attachCallsBeforeGap = mockAttachTerminalOutput.mock.calls.length;
    mockResumeTerminalOutput.mockClear();
    mockResumeTerminalOutput.mockResolvedValueOnce(null);

    act(() => emitOutput(outputDelta(8, "CC")));

    expect(mockResumeTerminalOutput).toHaveBeenCalledWith(terminalId, 1, 5);
    await vi.waitFor(() => {
      expect(mockAttachTerminalOutput.mock.calls.length).toBeGreaterThan(attachCallsBeforeGap);
    });
    expect(terminalOutputRecoveryCounters(terminalId)).toMatchObject({
      ringEscalation: 1,
      geometryEscalation: 0,
      nestedGap: 0,
      repairFailure: 0,
    });
  });

  it("counts a gap that spans a PTY resize as a geometry escalation", async () => {
    const terminalId = "t-output-gap-resize";
    const emitOutput = await attachedOutputEmitter(terminalId);

    act(() => emitOutput(outputDelta(0, "AAAAA")));

    const attachCallsBeforeGap = mockAttachTerminalOutput.mock.calls.length;
    mockResumeTerminalOutput.mockClear();
    // One delta cannot describe bytes written on two different grids.
    mockResumeTerminalOutput.mockResolvedValueOnce({
      ...outputDelta(5, "BBB"),
      geometry: { revision: 1, cols: 100, rows: 30 },
    });

    act(() => emitOutput(outputDelta(8, "CC")));

    await vi.waitFor(() => {
      expect(mockAttachTerminalOutput.mock.calls.length).toBeGreaterThan(attachCallsBeforeGap);
    });
    expect(terminalOutputRecoveryCounters(terminalId)).toMatchObject({
      geometryEscalation: 1,
      ringEscalation: 0,
      repairFailure: 0,
    });
  });

  // issue #607 (1): a hole that reopens behind a served range is still repayable
  // by one more exact range. Escalating instead threw the screen away for the
  // very "repeated loss during a flood" case ADR-0072 exists to survive.
  it("keeps repairing when a second hole opens behind the served range", async () => {
    const terminalId = "t-output-gap-nested";
    const emitOutput = await attachedOutputEmitter(terminalId);

    act(() => emitOutput(outputDelta(0, "AAAAA")));

    mockWrite.mockClear();
    mockReset.mockClear();
    const attachCallsBeforeGap = mockAttachTerminalOutput.mock.calls.length;
    mockResumeTerminalOutput.mockClear();
    // Round 1 bridges `[5, 8)`, but the delta buffered behind it starts at 12:
    // the flood lost a second event while the first repair was being served.
    // Round 2 bridges `[8, 12)` and the buffered delta finally lands.
    mockResumeTerminalOutput.mockResolvedValueOnce(outputDelta(5, "BBB"));
    mockResumeTerminalOutput.mockResolvedValueOnce(outputDelta(8, "DDDD"));

    act(() => emitOutput(outputDelta(12, "CC")));

    // Both repair rounds must reach xterm exactly once and before the buffered
    // delta. The coordinator has already moved `expectedSeq` past those bytes,
    // so omission or duplication would silently corrupt the visible stream.
    await vi.waitFor(() => expect(writtenStream()).toBe("BBBDDDDCC"));
    expect(mockResumeTerminalOutput.mock.calls).toEqual([
      [terminalId, 1, 5],
      [terminalId, 1, 8],
    ]);
    expect(mockReset).not.toHaveBeenCalled();
    expect(mockAttachTerminalOutput.mock.calls.length).toBe(attachCallsBeforeGap);
    expect(terminalOutputRecoveryCounters(terminalId)).toMatchObject({
      gap: 1,
      nestedGap: 1,
      // The loop repaid the reopened hole, so the screen survived: the
      // escalation bucket that would say otherwise must stay empty.
      nestedGapEscalation: 0,
      repair: 1,
      ringEscalation: 0,
      geometryEscalation: 0,
    });
  });

  it("gives up on the repair loop at the round cap and reattaches", async () => {
    const terminalId = "t-output-gap-nested-cap";
    const emitOutput = await attachedOutputEmitter(terminalId);

    act(() => emitOutput(outputDelta(0, "AAAAA")));

    mockWrite.mockClear();
    const attachCallsBeforeGap = mockAttachTerminalOutput.mock.calls.length;
    mockResumeTerminalOutput.mockClear();
    try {
      // Every round is served and every round the hole reopens — a stream losing
      // deltas faster than repairs land. The loop must not run forever.
      mockResumeTerminalOutput.mockImplementation((_id: string, _generation: number, seq: number) =>
        Promise.resolve(outputDelta(seq, "X")),
      );

      act(() => emitOutput(outputDelta(100, "CC")));

      await vi.waitFor(() => {
        expect(mockAttachTerminalOutput.mock.calls.length).toBeGreaterThan(attachCallsBeforeGap);
      });
      expect(mockResumeTerminalOutput).toHaveBeenCalledTimes(4);
      // Each served round still reached the screen before the escalation.
      expect(decodedWrites().filter((written) => written === "X")).toHaveLength(4);
      expect(terminalOutputRecoveryCounters(terminalId)).toMatchObject({
        // `nestedGap` counts every round, so on its own it cannot tell a repaid
        // hole from a lost screen. The cap that ended the loop gets its own
        // bucket — it is the only evidence that could move
        // `TERMINAL_OUTPUT_REPAIR_MAX_ROUNDS` (issue #607).
        nestedGap: 4,
        nestedGapEscalation: 1,
        repair: 0,
        ringEscalation: 0,
        geometryEscalation: 0,
      });
    } finally {
      mockResumeTerminalOutput.mockReset();
      mockResumeTerminalOutput.mockResolvedValue(null);
    }
  });

  // issue #607 (3): a repair suspends delta application, so a round-trip that
  // never settles freezes the pane's output for good and piles every later delta
  // into `pending`. Losing the screen beats losing the pane.
  it("reattaches when the repair round-trip never settles", async () => {
    vi.useFakeTimers();
    try {
      const terminalId = "t-output-gap-repair-hang";
      const emitOutput = await attachedOutputEmitter(terminalId);

      act(() => emitOutput(outputDelta(0, "AAAAA")));

      const attachCallsBeforeGap = mockAttachTerminalOutput.mock.calls.length;
      mockResumeTerminalOutput.mockClear();
      mockResumeTerminalOutput.mockReturnValueOnce(new Promise(() => {}));

      act(() => emitOutput(outputDelta(8, "CC")));

      expect(mockResumeTerminalOutput).toHaveBeenCalledWith(terminalId, 1, 5);
      // Inside the watchdog window the pane still waits for the exact range.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(14_000);
      });
      expect(mockAttachTerminalOutput.mock.calls.length).toBe(attachCallsBeforeGap);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });
      expect(mockAttachTerminalOutput.mock.calls.length).toBeGreaterThan(attachCallsBeforeGap);
      expect(terminalOutputRecoveryCounters(terminalId)).toMatchObject({
        repairTimeout: 1,
        ringEscalation: 0,
        repairFailure: 0,
        nestedGap: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  // issue #607 (2): the attach snapshot is the whole 1 MiB ring, so a delta lost
  // during the attach round-trip is still in the ring. Reattaching there dropped
  // cells and burned ADR-0069's `reconstructable` for nothing.
  it("repairs a gap that opened during the attach round-trip", async () => {
    const terminalId = "t-output-gap-during-attach";
    const attachment = {
      state: {
        version: 1,
        generation: 1,
        snapshotStartSeq: 0,
        snapshotSeq: 0,
        sourceStartSeq: 0,
        sourceSeq: 0,
        snapshotKind: "raw",
        protocolRevision: 0,
        modes: { bracketedPaste: false },
        geometry,
      },
      snapshot: [],
      flowControl: { token: "lease-gap", windowBytes: 524288 },
    };
    let resolveAttach!: (value: unknown) => void;
    mockAttachTerminalOutput.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveAttach = resolve;
      }),
    );
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    // The listener is live while the attach RPC is still in flight — exactly the
    // window this test is about.
    const emitOutput = await vi.waitFor(() => {
      const registered = mockOnTerminalOutput.mock.calls.find(
        ([registeredTerminalId]) => registeredTerminalId === terminalId,
      );
      expect(registered).toBeDefined();
      return registered?.[1] as (data: Uint8Array | Record<string, unknown>) => void;
    });

    mockWrite.mockClear();
    const attachCallsDuringGap = mockAttachTerminalOutput.mock.calls.length;
    mockResumeTerminalOutput.mockClear();
    mockResumeTerminalOutput.mockResolvedValueOnce(outputDelta(0, "AAAAAAAA"));

    // The `[0, 8)` emit was lost in the attach window; the snapshot ends at 0.
    act(() => emitOutput(outputDelta(8, "CC")));
    await act(async () => {
      resolveAttach(attachment);
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      const written = writtenStream();
      expect(written).toContain("AAAAAAAA");
      expect(written.indexOf("CC")).toBeGreaterThan(written.indexOf("AAAAAAAA"));
    });
    expect(mockResumeTerminalOutput).toHaveBeenCalledWith(terminalId, 1, 0);
    // No second attach: the screen and the checkpoint model survived.
    expect(mockAttachTerminalOutput.mock.calls.length).toBe(attachCallsDuringGap);
    expect(terminalOutputRecoveryCounters(terminalId)).toMatchObject({
      gap: 1,
      repair: 1,
      ringEscalation: 0,
      attachFailure: 0,
    });
    // Readiness belongs to the attach, not to the repair: the pane must not stay
    // fail-closed just because the attach ended on a hole it handed to recovery.
    toggleInputMode(terminalId);
    await vi.waitFor(() =>
      expect(screen.getByTestId(`terminal-input-composer-${terminalId}`)).toHaveAttribute(
        "data-can-send",
        "true",
      ),
    );
  });

  // The attach hands its hole straight to recovery instead of going through
  // `scheduleOutputRepairRetry`. Routing it through the retry timer would make
  // the start latency depend on `TERMINAL_WRITE_RETRY_MS` and would let a live
  // delta arriving inside that window decide who starts the round-trip.
  it("starts the attach-window repair without waiting on the retry timer", async () => {
    vi.useFakeTimers();
    try {
      const terminalId = "t-output-gap-attach-direct";
      const attachment = {
        state: {
          version: 1,
          generation: 1,
          snapshotStartSeq: 0,
          snapshotSeq: 0,
          sourceStartSeq: 0,
          sourceSeq: 0,
          snapshotKind: "raw",
          protocolRevision: 0,
          modes: { bracketedPaste: false },
          geometry,
        },
        snapshot: [],
        flowControl: { token: "lease-gap-direct", windowBytes: 524288 },
      };
      let resolveAttach!: (value: unknown) => void;
      mockAttachTerminalOutput.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveAttach = resolve;
        }),
      );
      render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
      const emitOutput = await vi.waitFor(() => {
        const registered = mockOnTerminalOutput.mock.calls.find(
          ([registeredTerminalId]) => registeredTerminalId === terminalId,
        );
        expect(registered).toBeDefined();
        return registered?.[1] as (data: Uint8Array | Record<string, unknown>) => void;
      });

      const attachCallsDuringGap = mockAttachTerminalOutput.mock.calls.length;
      mockResumeTerminalOutput.mockClear();
      mockResumeTerminalOutput.mockResolvedValueOnce(outputDelta(0, "AAAAAAAA"));

      act(() => emitOutput(outputDelta(8, "CC")));
      await act(async () => {
        resolveAttach(attachment);
        // Stop one millisecond short of `TERMINAL_WRITE_RETRY_MS`: the repair
        // must already be in flight from the attach itself.
        await vi.advanceTimersByTimeAsync(15);
      });

      expect(mockResumeTerminalOutput).toHaveBeenCalledWith(terminalId, 1, 0);
      expect(mockAttachTerminalOutput.mock.calls.length).toBe(attachCallsDuringGap);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a rejected repair request as a repair failure, not a ring escalation", async () => {
    const terminalId = "t-output-gap-rpc-failure";
    const emitOutput = await attachedOutputEmitter(terminalId);

    act(() => emitOutput(outputDelta(0, "AAAAA")));

    const attachCallsBeforeGap = mockAttachTerminalOutput.mock.calls.length;
    mockResumeTerminalOutput.mockClear();
    mockResumeTerminalOutput.mockRejectedValueOnce(new Error("Session 't1' not found"));

    act(() => emitOutput(outputDelta(8, "CC")));

    await vi.waitFor(() => {
      expect(mockAttachTerminalOutput.mock.calls.length).toBeGreaterThan(attachCallsBeforeGap);
    });
    expect(terminalOutputRecoveryCounters(terminalId)).toMatchObject({
      repairFailure: 1,
      ringEscalation: 0,
      geometryEscalation: 0,
      nestedGap: 0,
    });
  });

  it("counts a repair refused for a replaced generation as a repair failure", async () => {
    const terminalId = "t-output-gap-generation";
    const emitOutput = await attachedOutputEmitter(terminalId);

    act(() => emitOutput(outputDelta(0, "AAAAA")));

    const attachCallsBeforeGap = mockAttachTerminalOutput.mock.calls.length;
    mockResumeTerminalOutput.mockClear();
    // Passes payload validation, then the coordinator refuses it: the session
    // was replaced. Nothing to do with ring retention or a resize.
    mockResumeTerminalOutput.mockResolvedValueOnce({ ...outputDelta(5, "BBB"), generation: 2 });

    act(() => emitOutput(outputDelta(8, "CC")));

    await vi.waitFor(() => {
      expect(mockAttachTerminalOutput.mock.calls.length).toBeGreaterThan(attachCallsBeforeGap);
    });
    expect(terminalOutputRecoveryCounters(terminalId)).toMatchObject({
      repairFailure: 1,
      ringEscalation: 0,
      geometryEscalation: 0,
      nestedGap: 0,
    });
  });

  it("counts a malformed repair range as a malformed delta, not a ring escalation", async () => {
    const terminalId = "t-output-gap-malformed-repair";
    const emitOutput = await attachedOutputEmitter(terminalId);

    act(() => emitOutput(outputDelta(0, "AAAAA")));

    const attachCallsBeforeGap = mockAttachTerminalOutput.mock.calls.length;
    mockResumeTerminalOutput.mockClear();
    // Byte length disagrees with the declared range.
    mockResumeTerminalOutput.mockResolvedValueOnce({ ...outputDelta(5, "BBB"), seqEnd: 9 });

    act(() => emitOutput(outputDelta(8, "CC")));

    await vi.waitFor(() => {
      expect(mockAttachTerminalOutput.mock.calls.length).toBeGreaterThan(attachCallsBeforeGap);
    });
    expect(terminalOutputRecoveryCounters(terminalId)).toMatchObject({
      malformedDelta: 1,
      ringEscalation: 0,
      repairFailure: 0,
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
    expect(
      useTerminalStore.getState().instances.find((instance) => instance.id === "t-composer-send")
        ?.lastUserInput,
    ).toBe("한글 second");
  });

  // Issue #558. In the alternate screen the composer is a keyboard proxy: keys go to
  // the PTY, which is why ASCII reaches a fullscreen app as it is typed. A composition
  // cannot be proxied key by key, so the composed text used to pile up in the draft
  // while Enter and Backspace kept going to the app — the draft was neither
  // submittable nor erasable. Route the commit, not the keys.
  it("writes a composition commit straight to a fullscreen app and drops it from the draft", async () => {
    render(<TerminalView instanceId="t-composer-alt-ime" profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode("t-composer-alt-ime");
    const textarea = screen.getByTestId(
      "terminal-input-composer-t-composer-alt-ime-textarea",
    ) as HTMLTextAreaElement;
    mockBufferActive.type = "alternate";

    // The IME owns the textarea while composing, so the composed run lands in the
    // draft no matter what passthrough does.
    fireEvent.compositionStart(textarea, { data: "" });
    fireEvent.change(textarea, { target: { value: "가" } });
    fireEvent.compositionEnd(textarea, { data: "가" });

    expect(mockWriteToTerminal).toHaveBeenCalledWith("t-composer-alt-ime", "가");
    // Enter belongs to the app while the draft is empty, so the draft may not keep the
    // committed syllable — it would have no way out.
    await vi.waitFor(() => expect(textarea.value).toBe(""));
    expect(mockWriteTerminalInput).not.toHaveBeenCalled();
  });

  // Issue #560. An empty draft lends the keyboard to the fullscreen app; a non-empty
  // one keeps it. Without the second half, anything that reached the draft while the
  // app ran was stranded — Enter and Backspace both went to the app, so the text could
  // be neither submitted nor erased.
  it("hands a fullscreen app the keys the draft would otherwise swallow", async () => {
    render(<TerminalView instanceId="t-composer-alt-keys" profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode("t-composer-alt-keys");
    const textarea = screen.getByTestId(
      "terminal-input-composer-t-composer-alt-keys-textarea",
    ) as HTMLTextAreaElement;
    mockBufferActive.type = "alternate";
    mockWriteToTerminal.mockClear();

    // Tab would have opened the recall popup; Shift+Enter would have started a draft.
    fireEvent.keyDown(textarea, { key: "Tab" });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });

    expect(mockWriteToTerminal).toHaveBeenCalledWith("t-composer-alt-keys", "\t");
    expect(mockWriteToTerminal).toHaveBeenCalledWith("t-composer-alt-keys", "\r");
    expect(textarea.value).toBe("");
  });

  it("writes a paste to a fullscreen app instead of the draft", async () => {
    const terminalId = "t-composer-alt-paste";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode(terminalId);
    const textarea = screen.getByTestId(
      `terminal-input-composer-${terminalId}-textarea`,
    ) as HTMLTextAreaElement;
    mockBufferActive.type = "alternate";
    mockWriteTerminalInput.mockClear();

    fireEvent.paste(textarea, {
      clipboardData: {
        getData: (type: string) => (type === "text/plain" ? "first\nsecond" : ""),
      },
    });

    // Same write path Direct mode's native paste uses, so both modes behave alike.
    expect(mockWriteTerminalInput).toHaveBeenCalledWith(terminalId, "first\nsecond", false);
    expect(textarea.value).toBe("");
  });

  it("gives a non-empty draft its keys back so it can still be sent in a fullscreen app", async () => {
    const terminalId = "t-composer-alt-leftover";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode(terminalId);
    const textarea = screen.getByTestId(
      `terminal-input-composer-${terminalId}-textarea`,
    ) as HTMLTextAreaElement;
    // A draft can survive into a fullscreen app — typed at the shell, then Direct mode,
    // then the app starts and Composer comes back. That draft needs a way out.
    fireEvent.change(textarea, { target: { value: "leftover" } });
    mockBufferActive.type = "alternate";
    mockWriteToTerminal.mockClear();

    fireEvent.keyDown(textarea, { key: "Backspace" });
    expect(mockWriteToTerminal).not.toHaveBeenCalled();

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(mockWriteTerminalInput).toHaveBeenCalledWith(terminalId, "leftover", true);
    expect(mockWriteToTerminal).not.toHaveBeenCalled();
  });

  it("keeps a paste in a non-empty draft in a fullscreen app", async () => {
    const terminalId = "t-composer-alt-paste-draft";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode(terminalId);
    const textarea = screen.getByTestId(
      `terminal-input-composer-${terminalId}-textarea`,
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "draft " } });
    mockBufferActive.type = "alternate";
    mockWriteTerminalInput.mockClear();

    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: { getData: () => "tail" },
    });
    act(() => {
      textarea.dispatchEvent(pasteEvent);
    });

    // The draft owns the keyboard here, so pasting into it is a normal edit: nothing
    // goes to the PTY and the event is left alone for the textarea to insert.
    expect(mockWriteTerminalInput).not.toHaveBeenCalled();
    expect(pasteEvent.defaultPrevented).toBe(false);
  });

  it("never proxies the paste chord itself, or the clipboard would never be read", async () => {
    // Real-device defect: Ctrl+V was forwarded like any other key, so a fullscreen app
    // received the raw control byte ( → `^V` on screen) and preventDefault kept the
    // browser from ever firing the paste event that carries the text.
    const terminalId = "t-composer-alt-paste-chord";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode(terminalId);
    const textarea = screen.getByTestId(
      `terminal-input-composer-${terminalId}-textarea`,
    ) as HTMLTextAreaElement;
    mockBufferActive.type = "alternate";
    mockWriteToTerminal.mockClear();
    mockWriteTerminalInput.mockClear();

    const chord = new KeyboardEvent("keydown", {
      key: "v",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    textarea.dispatchEvent(chord);

    expect(mockWriteToTerminal).not.toHaveBeenCalled();
    expect(chord.defaultPrevented).toBe(false);

    // The default action stands, so the browser paste event follows and routes.
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: { getData: () => "pasted" },
    });
    act(() => {
      textarea.dispatchEvent(pasteEvent);
    });

    expect(mockWriteTerminalInput).toHaveBeenCalledWith(terminalId, "pasted", false);
  });

  it("routes a paste typed-into-then-pasted in the same tick by the live draft value", async () => {
    // The controlled `text` prop is one render behind an edit. Deciding emptiness from
    // it would consume the event as a proxy paste while the host saw a non-empty draft,
    // and the paste would reach neither the terminal nor the draft.
    const terminalId = "t-composer-alt-paste-race";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode(terminalId);
    const textarea = screen.getByTestId(
      `terminal-input-composer-${terminalId}-textarea`,
    ) as HTMLTextAreaElement;
    mockBufferActive.type = "alternate";
    mockWriteTerminalInput.mockClear();

    // Set the DOM value without letting React re-render with it first.
    textarea.value = "typed";
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: { getData: () => "tail" },
    });
    act(() => {
      textarea.dispatchEvent(pasteEvent);
    });

    expect(pasteEvent.defaultPrevented).toBe(false);
    expect(mockWriteTerminalInput).not.toHaveBeenCalled();
  });

  it("proxies nothing while a remote client owns this terminal", async () => {
    // Local control is the outer gate on every write path. With it withdrawn the keys
    // stay with the draft rather than silently vanishing.
    const terminalId = "t-composer-alt-remote";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode(terminalId);
    const textarea = screen.getByTestId(
      `terminal-input-composer-${terminalId}-textarea`,
    ) as HTMLTextAreaElement;
    mockBufferActive.type = "alternate";
    act(() => capturedRemoteControlChanged?.({ active: true }));
    mockWriteToTerminal.mockClear();
    mockWriteTerminalInput.mockClear();

    fireEvent.keyDown(textarea, { key: "Tab" });
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: { getData: () => "tail" },
    });
    act(() => {
      textarea.dispatchEvent(pasteEvent);
    });

    expect(mockWriteToTerminal).not.toHaveBeenCalled();
    expect(mockWriteTerminalInput).not.toHaveBeenCalled();
    expect(pasteEvent.defaultPrevented).toBe(false);
  });

  it("keeps a composition commit in the draft on the normal buffer", async () => {
    render(<TerminalView instanceId="t-composer-normal-ime" profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode("t-composer-normal-ime");
    const textarea = screen.getByTestId(
      "terminal-input-composer-t-composer-normal-ime-textarea",
    ) as HTMLTextAreaElement;

    fireEvent.compositionStart(textarea, { data: "" });
    fireEvent.change(textarea, { target: { value: "가나다" } });
    fireEvent.compositionEnd(textarea, { data: "다" });

    // Here the draft is a real drafting surface and Enter submits it, so diverting
    // the commit would break composing a line before sending it.
    expect(mockWriteToTerminal).not.toHaveBeenCalled();
    expect(textarea.value).toBe("가나다");

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(mockWriteTerminalInput).toHaveBeenCalledWith("t-composer-normal-ime", "가나다", true);
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

  // Issue #567: the mode/draft/readiness re-seed used to run as a setState effect
  // keyed on `instanceId`. It now falls out of reading the runtime store directly,
  // so the swap must still isolate every one of those three per terminal.
  it("re-seeds mode, draft and readiness when instanceId changes in place", async () => {
    const { rerender } = render(
      <TerminalView instanceId="t-swap-a" profile="PowerShell" syncGroup="" />,
    );
    await waitForTerminalInputReady();

    toggleInputMode("t-swap-a");
    await vi.waitFor(() =>
      expect(screen.getByTestId("terminal-input-composer-t-swap-a")).toHaveAttribute(
        "data-can-send",
        "true",
      ),
    );
    fireEvent.change(screen.getByTestId("terminal-input-composer-t-swap-a-textarea"), {
      target: { value: "draft for A" },
    });
    expect(screen.getByTestId("terminal-input-composer-t-swap-a-textarea")).toHaveValue(
      "draft for A",
    );

    // Terminal B follows the desktop default (composer, just set by the toggle)
    // but owns its own draft, and its output protocol has not attached yet.
    rerender(<TerminalView instanceId="t-swap-b" profile="PowerShell" syncGroup="" />);
    expect(screen.getByTestId("terminal-input-composer-t-swap-b")).toHaveAttribute(
      "data-mode",
      "composer",
    );
    expect(screen.getByTestId("terminal-input-composer-t-swap-b-textarea")).toHaveValue("");
    expect(screen.getByTestId("terminal-input-composer-t-swap-b")).toHaveAttribute(
      "data-can-send",
      "false",
    );

    // Back to A: the runtime store still holds its draft.
    rerender(<TerminalView instanceId="t-swap-a" profile="PowerShell" syncGroup="" />);
    expect(screen.getByTestId("terminal-input-composer-t-swap-a-textarea")).toHaveValue(
      "draft for A",
    );
    // …but the readiness that the *first* A terminal published must not carry
    // over: this is a brand new xterm whose output protocol has not attached.
    // Keying readiness by `instanceId` alone would report ready here (the draft
    // is non-empty, so `data-can-send` is gated purely by readiness).
    expect(screen.getByTestId("terminal-input-composer-t-swap-a")).toHaveAttribute(
      "data-can-send",
      "false",
    );
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

  it("keeps nav keys inside the draft once it has text", async () => {
    const terminalId = "t-composer-nav-draft";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode(terminalId);
    const textarea = screen.getByTestId(`terminal-input-composer-${terminalId}-textarea`);
    fireEvent.change(textarea, { target: { value: "draft" } });
    mockWriteToTerminal.mockClear();

    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(mockWriteToTerminal).not.toHaveBeenCalled();
  });

  it("lets combos bound to laymux actions bubble instead of forwarding them", async () => {
    const terminalId = "t-composer-panenav";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode(terminalId);
    const textarea = screen.getByTestId(`terminal-input-composer-${terminalId}-textarea`);
    mockWriteToTerminal.mockClear();

    // Empty draft, but these combos match registry bindings (pane.focus =
    // Alt+Arrow wildcard, workspace.prev = Ctrl+Alt+Up) — the registry check,
    // not a hardcoded modifier rule, must keep them bubbling untouched.
    const altLeft = new KeyboardEvent("keydown", { key: "ArrowLeft", altKey: true, bubbles: true });
    const stopSpy = vi.spyOn(altLeft, "stopPropagation");
    textarea.dispatchEvent(altLeft);
    fireEvent.keyDown(textarea, { key: "ArrowUp", ctrlKey: true, altKey: true });
    // Ctrl+Alt+C = pane.copyIdentifier — bound, so it bubbles too.
    fireEvent.keyDown(textarea, { key: "c", ctrlKey: true, altKey: true });

    expect(mockWriteToTerminal).not.toHaveBeenCalled();
    expect(stopSpy).not.toHaveBeenCalled();
  });

  it("forwards activity-control chords from an empty draft but not paste or drafts", async () => {
    const terminalId = "t-composer-ctrlc";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode(terminalId);
    const textarea = screen.getByTestId(`terminal-input-composer-${terminalId}-textarea`);
    mockWriteToTerminal.mockClear();

    // Empty draft: Ctrl+C interrupts the running activity (SIGINT), Ctrl+D sends EOF.
    fireEvent.keyDown(textarea, { key: "c", ctrlKey: true });
    expect(mockWriteToTerminal).toHaveBeenCalledWith(terminalId, "\x03");
    fireEvent.keyDown(textarea, { key: "d", ctrlKey: true });
    expect(mockWriteToTerminal).toHaveBeenCalledWith(terminalId, "\x04");

    // Ctrl+V must keep pasting into the draft — never forwarded.
    mockWriteToTerminal.mockClear();
    fireEvent.keyDown(textarea, { key: "v", ctrlKey: true });
    expect(mockWriteToTerminal).not.toHaveBeenCalled();

    // With text staged, Ctrl+C is the editor's copy again — not an interrupt.
    fireEvent.change(textarea, { target: { value: "draft" } });
    fireEvent.keyDown(textarea, { key: "c", ctrlKey: true });
    expect(mockWriteToTerminal).not.toHaveBeenCalled();
  });

  it("passes empty-draft nav keys (and honors DECCKM) through while a program runs", async () => {
    const terminalId = "t-composer-program";
    render(<TerminalView instanceId={terminalId} profile="PowerShell" syncGroup="" />);
    await waitForTerminalInputReady();

    toggleInputMode(terminalId);
    const textarea = screen.getByTestId(`terminal-input-composer-${terminalId}-textarea`);
    // OSC 133;C = a command started running → ↑/↓ pass through to it (menu/history).
    emitOutput(terminalId, "\x1b]133;C\x07");
    mockWriteToTerminal.mockClear();

    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(mockWriteToTerminal).toHaveBeenCalledWith(terminalId, "\x1b[A");
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

    // OSC 133;D = command done → back at the prompt (this is the last OSC at a
    // PowerShell prompt, where 133;B is never sent). ↑ must now recall, not pass through.
    emitOutput(terminalId, "\x1b]133;D;0\x07");
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
