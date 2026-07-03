import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useAutoRemoteAccessPrompt } from "./useAutoRemoteAccessPrompt";
import { useLocalMobileModeStore } from "@/stores/local-mobile-mode-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";

function Probe({ enabled = true }: { enabled?: boolean }) {
  useAutoRemoteAccessPrompt(enabled);
  return null;
}

function setInnerWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    value: width,
    configurable: true,
  });
}

describe("useAutoRemoteAccessPrompt", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    useLocalMobileModeStore.setState(useLocalMobileModeStore.getInitialState());
    setInnerWidth(1200);
  });

  it("opens the Remote Access modal when the app window is narrow", () => {
    useSettingsStore.getState().setRemote({ autoMobileModeMinWidth: 720 });
    setInnerWidth(600);

    render(<Probe />);

    expect(useUiStore.getState().remoteAccessModalOpen).toBe(true);
  });

  it("does nothing when the threshold is disabled", () => {
    useSettingsStore.getState().setRemote({ autoMobileModeMinWidth: 0 });
    setInnerWidth(320);

    render(<Probe />);

    expect(useUiStore.getState().remoteAccessModalOpen).toBe(false);
  });

  it("waits until explicitly enabled before checking the narrow-window threshold", () => {
    useSettingsStore.getState().setRemote({ autoMobileModeMinWidth: 720 });
    setInnerWidth(600);

    const { rerender } = render(<Probe enabled={false} />);

    expect(useUiStore.getState().remoteAccessModalOpen).toBe(false);

    rerender(<Probe enabled />);

    expect(useUiStore.getState().remoteAccessModalOpen).toBe(true);
  });

  it("does not open the modal while local mobile mode is already active", () => {
    useSettingsStore.getState().setRemote({ autoMobileModeMinWidth: 720 });
    useLocalMobileModeStore.getState().enter("http://127.0.0.1:19281/remote/?localApp=1");
    setInnerWidth(600);

    render(<Probe />);

    expect(useUiStore.getState().remoteAccessModalOpen).toBe(false);
  });
});
