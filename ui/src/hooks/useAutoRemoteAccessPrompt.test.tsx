import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoRemoteAccessPrompt } from "./useAutoRemoteAccessPrompt";
import { getRemoteSessionActive, onRemoteSessionChanged } from "@/lib/tauri-api";
import { useLocalMobileModeStore } from "@/stores/local-mobile-mode-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";

vi.mock("@/lib/tauri-api", () => ({
  getRemoteSessionActive: vi.fn().mockResolvedValue(false),
  onRemoteSessionChanged: vi.fn().mockResolvedValue(vi.fn()),
}));

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
    vi.mocked(getRemoteSessionActive).mockResolvedValue(false);
    vi.mocked(onRemoteSessionChanged).mockResolvedValue(vi.fn());
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

  it("opens the modal when launched inside an OS remote session, even on a wide window", async () => {
    // Threshold disabled + wide window: the width heuristic must NOT fire, so a
    // pass here proves the RDP-session path is what opens the modal.
    useSettingsStore.getState().setRemote({ autoMobileModeMinWidth: 0 });
    setInnerWidth(1920);
    vi.mocked(getRemoteSessionActive).mockResolvedValue(true);

    render(<Probe />);

    await waitFor(() => {
      expect(useUiStore.getState().remoteAccessModalOpen).toBe(true);
    });
  });

  it("opens the modal when a remote session connects after mount", async () => {
    useSettingsStore.getState().setRemote({ autoMobileModeMinWidth: 0 });
    setInnerWidth(1920);
    let fire: ((active: boolean) => void) | undefined;
    vi.mocked(onRemoteSessionChanged).mockImplementation((cb) => {
      fire = cb;
      return Promise.resolve(vi.fn());
    });

    render(<Probe />);

    await waitFor(() => expect(fire).toBeDefined());
    expect(useUiStore.getState().remoteAccessModalOpen).toBe(false);

    fire?.(true);

    await waitFor(() => {
      expect(useUiStore.getState().remoteAccessModalOpen).toBe(true);
    });
  });

  it("does not open the modal on remote session while local mobile mode is active", async () => {
    useSettingsStore.getState().setRemote({ autoMobileModeMinWidth: 0 });
    useLocalMobileModeStore.getState().enter("http://127.0.0.1:19281/remote/?localApp=1");
    setInnerWidth(1920);
    vi.mocked(getRemoteSessionActive).mockResolvedValue(true);

    render(<Probe />);

    // Give the resolved promise a chance to run.
    await Promise.resolve();
    await Promise.resolve();
    expect(useUiStore.getState().remoteAccessModalOpen).toBe(false);
  });
});
