import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useTerminalParserAdmissionSettings } from "./useTerminalParserAdmissionSettings";
import {
  TERMINAL_WRITE_DEFAULT_CLASS_SHARE,
  TERMINAL_WRITE_MIN_CLASS_SHARE,
  terminalWriteFairScheduler,
} from "@/lib/terminal-write-fair-scheduler";
import { useSettingsStore } from "@/stores/settings-store";

describe("useTerminalParserAdmissionSettings", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    terminalWriteFairScheduler.resetForTests();
  });

  it("applies the configured shares on mount and on later settings changes", () => {
    const setClassShare = vi.spyOn(terminalWriteFairScheduler, "setClassShare");

    renderHook(() => useTerminalParserAdmissionSettings());

    expect(setClassShare).toHaveBeenLastCalledWith({
      focused: TERMINAL_WRITE_DEFAULT_CLASS_SHARE.focused,
      foreground: TERMINAL_WRITE_DEFAULT_CLASS_SHARE.foreground,
      background: TERMINAL_WRITE_DEFAULT_CLASS_SHARE.background,
    });

    act(() => {
      useSettingsStore.getState().setTerminal({
        parserAdmission: { focusedShare: 9, visibleShare: 4, hiddenShare: 1 },
      });
    });

    expect(setClassShare).toHaveBeenLastCalledWith({
      focused: 9,
      foreground: 4,
      background: 1,
    });
    setClassShare.mockRestore();
  });

  it("falls back to defaults when a settings snapshot omits the shares", () => {
    act(() => {
      useSettingsStore.getState().setTerminal({ parserAdmission: undefined });
    });
    const setClassShare = vi.spyOn(terminalWriteFairScheduler, "setClassShare");

    renderHook(() => useTerminalParserAdmissionSettings());

    expect(setClassShare).toHaveBeenLastCalledWith(undefined);
    setClassShare.mockRestore();
  });

  it("clamps a class share that would pause its parsers", () => {
    act(() => {
      useSettingsStore.getState().setTerminal({
        parserAdmission: { focusedShare: 4, visibleShare: 2, hiddenShare: 0 },
      });
    });

    renderHook(() => useTerminalParserAdmissionSettings());

    // The scheduler owns the clamp, so the hook may forward the raw value.
    expect(terminalWriteFairScheduler.classShareForTests().background).toBe(
      TERMINAL_WRITE_MIN_CLASS_SHARE,
    );
  });
});
