import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock settings store before importing the module under test.
// 훅(useResolvedKeybinding)도 테스트하므로 selector 호출이 가능한 함수형 mock 으로 만든다.
const mockGetState = vi.fn();
vi.mock("@/stores/settings-store", () => {
  const useSettingsStore = <T>(selector: (s: unknown) => T): T => selector(mockGetState());
  useSettingsStore.getState = () => mockGetState();
  return { useSettingsStore };
});

import {
  DEFAULT_KEYBINDINGS,
  matchesKeybinding,
  resolveKeybinding,
  useResolvedKeybinding,
} from "./keybinding-registry";
import { renderHook } from "@testing-library/react";

function makeKeyEvent(
  key: string,
  opts: { ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
): KeyboardEvent {
  return {
    key,
    ctrlKey: opts.ctrl ?? false,
    altKey: opts.alt ?? false,
    shiftKey: opts.shift ?? false,
  } as unknown as KeyboardEvent;
}

describe("keybinding-registry", () => {
  beforeEach(() => {
    mockGetState.mockReturnValue({ keybindings: [] });
  });

  describe("DEFAULT_KEYBINDINGS", () => {
    it("should have unique ids", () => {
      const ids = DEFAULT_KEYBINDINGS.map((d) => d.id);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("should include issueReporter.submit", () => {
      expect(DEFAULT_KEYBINDINGS.find((d) => d.id === "issueReporter.submit")).toBeDefined();
    });

    // issue #324: 1회성 CWD 전파 단축키 (Settings UI 에 자동 노출)
    it("should include pane.propagateCwdOnce with Ctrl+Alt+P default", () => {
      const def = DEFAULT_KEYBINDINGS.find((d) => d.id === "pane.propagateCwdOnce");
      expect(def).toBeDefined();
      expect(def?.defaultKeys).toBe("Ctrl+Alt+P");
      expect(def?.group).toBe("Pane");
    });

    it("should include terminal.copy / terminal.paste with OS-default combos", () => {
      const copy = DEFAULT_KEYBINDINGS.find((d) => d.id === "terminal.copy");
      const paste = DEFAULT_KEYBINDINGS.find((d) => d.id === "terminal.paste");
      expect(copy?.defaultKeys).toBe("Ctrl+C");
      expect(paste?.defaultKeys).toBe("Ctrl+V");
    });
  });

  describe("resolveKeybinding", () => {
    it("should return default keys when no override", () => {
      expect(resolveKeybinding("issueReporter.submit")).toBe("Ctrl+Enter");
    });

    it("should return user override when present", () => {
      mockGetState.mockReturnValue({
        keybindings: [{ command: "issueReporter.submit", keys: "Ctrl+Shift+Enter" }],
      });
      expect(resolveKeybinding("issueReporter.submit")).toBe("Ctrl+Shift+Enter");
    });

    it("should return undefined for unknown action", () => {
      expect(resolveKeybinding("unknown.action")).toBeUndefined();
    });
  });

  // PR #331 리뷰 1번: 툴팁 등 렌더링에 쓰는 키 콤보는 keybindings 구독 기반 훅으로
  // 읽어야 재바인딩 시 즉시 갱신된다 (resolveKeybinding 은 getState 1회 읽기).
  describe("useResolvedKeybinding", () => {
    it("should return default keys when no override", () => {
      const { result } = renderHook(() => useResolvedKeybinding("pane.propagateCwdOnce"));
      expect(result.current).toBe("Ctrl+Alt+P");
    });

    it("should return user override when present", () => {
      mockGetState.mockReturnValue({
        keybindings: [{ command: "pane.propagateCwdOnce", keys: "Ctrl+Shift+P" }],
      });
      const { result } = renderHook(() => useResolvedKeybinding("pane.propagateCwdOnce"));
      expect(result.current).toBe("Ctrl+Shift+P");
    });

    it("should return undefined for unknown action", () => {
      const { result } = renderHook(() => useResolvedKeybinding("unknown.action"));
      expect(result.current).toBeUndefined();
    });
  });

  describe("matchesKeybinding", () => {
    it("should match Ctrl+Enter to issueReporter.submit", () => {
      const e = makeKeyEvent("Enter", { ctrl: true });
      expect(matchesKeybinding(e, "issueReporter.submit")).toBe(true);
    });

    it("should not match plain Enter to issueReporter.submit", () => {
      const e = makeKeyEvent("Enter");
      expect(matchesKeybinding(e, "issueReporter.submit")).toBe(false);
    });

    it("should match Ctrl+Alt+N to workspace.new", () => {
      const e = makeKeyEvent("n", { ctrl: true, alt: true });
      expect(matchesKeybinding(e, "workspace.new")).toBe(true);
    });

    it("should respect user override", () => {
      mockGetState.mockReturnValue({
        keybindings: [{ command: "issueReporter.submit", keys: "Ctrl+Shift+Enter" }],
      });
      // Old combo should NOT match
      const oldEvent = makeKeyEvent("Enter", { ctrl: true });
      expect(matchesKeybinding(oldEvent, "issueReporter.submit")).toBe(false);
      // New combo should match
      const newEvent = makeKeyEvent("Enter", { ctrl: true, shift: true });
      expect(matchesKeybinding(newEvent, "issueReporter.submit")).toBe(true);
    });

    it("should match arrow keys with normalized names", () => {
      const e = makeKeyEvent("ArrowDown", { ctrl: true, alt: true });
      expect(matchesKeybinding(e, "workspace.next")).toBe(true);
    });

    it("should return false for unknown action", () => {
      const e = makeKeyEvent("x", { ctrl: true });
      expect(matchesKeybinding(e, "unknown.action")).toBe(false);
    });

    it("should match Ctrl+, to settings.open", () => {
      const e = makeKeyEvent(",", { ctrl: true });
      expect(matchesKeybinding(e, "settings.open")).toBe(true);
    });

    it("should match Ctrl+Shift+C to terminal.copy when overridden", () => {
      mockGetState.mockReturnValue({
        keybindings: [
          { command: "terminal.copy", keys: "Ctrl+Shift+C" },
          { command: "terminal.paste", keys: "Ctrl+Shift+V" },
        ],
      });
      const copyEvent = makeKeyEvent("C", { ctrl: true, shift: true });
      expect(matchesKeybinding(copyEvent, "terminal.copy")).toBe(true);
      // The OS-default Ctrl+C should no longer match the rebound action
      const oldCopy = makeKeyEvent("c", { ctrl: true });
      expect(matchesKeybinding(oldCopy, "terminal.copy")).toBe(false);
    });

    it("should match any arrow key for 'Arrow' wildcard bindings (pane.focus)", () => {
      expect(matchesKeybinding(makeKeyEvent("ArrowLeft", { alt: true }), "pane.focus")).toBe(true);
      expect(matchesKeybinding(makeKeyEvent("ArrowRight", { alt: true }), "pane.focus")).toBe(true);
      expect(matchesKeybinding(makeKeyEvent("ArrowUp", { alt: true }), "pane.focus")).toBe(true);
      expect(matchesKeybinding(makeKeyEvent("ArrowDown", { alt: true }), "pane.focus")).toBe(true);
      expect(matchesKeybinding(makeKeyEvent("a", { alt: true }), "pane.focus")).toBe(false);
      expect(matchesKeybinding(makeKeyEvent("ArrowLeft"), "pane.focus")).toBe(false);
    });

    it("should respect 'Arrow' wildcard in user overrides", () => {
      mockGetState.mockReturnValue({
        keybindings: [{ command: "pane.focus", keys: "Ctrl+Alt+Arrow" }],
      });
      expect(
        matchesKeybinding(makeKeyEvent("ArrowLeft", { ctrl: true, alt: true }), "pane.focus"),
      ).toBe(true);
      expect(matchesKeybinding(makeKeyEvent("ArrowLeft", { alt: true }), "pane.focus")).toBe(false);
    });

    it("should match Ctrl+C / Ctrl+V to terminal.copy / terminal.paste by default", () => {
      const copy = makeKeyEvent("c", { ctrl: true });
      const paste = makeKeyEvent("v", { ctrl: true });
      expect(matchesKeybinding(copy, "terminal.copy")).toBe(true);
      expect(matchesKeybinding(paste, "terminal.paste")).toBe(true);
    });
  });
});
