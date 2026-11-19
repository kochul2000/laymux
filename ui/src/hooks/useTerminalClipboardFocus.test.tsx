import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setTerminalClipboardFocus } from "@/lib/tauri-api";
import { useSettingsStore } from "@/stores/settings-store";
import { type TerminalInstance, useTerminalStore } from "@/stores/terminal-store";
import { useTerminalClipboardFocus } from "./useTerminalClipboardFocus";

vi.mock("@/lib/tauri-api", () => ({
  setTerminalClipboardFocus: vi.fn().mockResolvedValue(undefined),
}));

const terminal: TerminalInstance = {
  id: "terminal-one",
  profile: "PowerShell",
  syncGroup: "group",
  workspaceId: "workspace",
  label: "Terminal",
  lastActivityAt: 0,
  isFocused: true,
  sessionReady: true,
  generation: 3,
};

let surface: HTMLElement;
let input: HTMLTextAreaElement;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Windows");
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  useSettingsStore.getState().setTerminal({ allowOsc52ClipboardWrite: false });
  useTerminalStore.setState({ instances: [terminal] });
  surface = document.createElement("div");
  surface.dataset.clipboardTerminalId = terminal.id;
  input = document.createElement("textarea");
  input.className = "xterm-helper-textarea";
  surface.append(input);
  document.body.append(surface);
});

afterEach(() => {
  surface.remove();
  vi.restoreAllMocks();
  useTerminalStore.setState({ instances: [] });
  useSettingsStore.getState().setTerminal({ allowOsc52ClipboardWrite: false });
});

it("publishes only the opted-in and hydrated input's current PTY generation", () => {
  input.focus();
  const { rerender, unmount } = renderHook(({ loaded }) => useTerminalClipboardFocus(loaded), {
    initialProps: { loaded: false },
  });
  expect(setTerminalClipboardFocus).toHaveBeenLastCalledWith(null, null);

  act(() => useSettingsStore.getState().setTerminal({ allowOsc52ClipboardWrite: true }));
  expect(setTerminalClipboardFocus).toHaveBeenLastCalledWith(null, null);
  rerender({ loaded: true });
  expect(setTerminalClipboardFocus).toHaveBeenLastCalledWith(terminal.id, 3);

  act(() => useTerminalStore.setState({ instances: [{ ...terminal, generation: 4 }] }));
  expect(setTerminalClipboardFocus).toHaveBeenLastCalledWith(terminal.id, 4);
  act(() => useSettingsStore.getState().setTerminal({ allowOsc52ClipboardWrite: false }));
  expect(setTerminalClipboardFocus).toHaveBeenLastCalledWith(null, null);
  unmount();
});

it("revokes the target on native blur and when focus moves to another input", () => {
  useSettingsStore.getState().setTerminal({ allowOsc52ClipboardWrite: true });
  const { unmount } = renderHook(() => useTerminalClipboardFocus(true));
  act(() => input.focus());
  expect(setTerminalClipboardFocus).toHaveBeenLastCalledWith(terminal.id, 3);

  act(() => window.dispatchEvent(new Event("blur")));
  expect(setTerminalClipboardFocus).toHaveBeenLastCalledWith(null, null);
  act(() => window.dispatchEvent(new Event("focus")));
  expect(setTerminalClipboardFocus).toHaveBeenLastCalledWith(terminal.id, 3);

  const other = document.createElement("textarea");
  surface.append(other);
  act(() => other.focus());
  expect(setTerminalClipboardFocus).toHaveBeenLastCalledWith(null, null);
  unmount();
});
