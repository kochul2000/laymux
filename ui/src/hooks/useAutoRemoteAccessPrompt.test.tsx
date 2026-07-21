import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPhoneLikeRemoteScreen, useAutoRemoteAccessPrompt } from "./useAutoRemoteAccessPrompt";
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

function setScreen(width: number, height: number) {
  Object.defineProperty(window, "screen", {
    value: { width, height },
    configurable: true,
  });
}

describe("useAutoRemoteAccessPrompt", () => {
  beforeEach(() => {
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useUiStore.setState(useUiStore.getInitialState());
    useLocalMobileModeStore.setState(useLocalMobileModeStore.getInitialState());
    setInnerWidth(1200);
    // Default to a desktop-sized remote screen so the RDP path stays closed
    // unless a test opts into phone geometry.
    setScreen(1920, 1080);
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

  it("opens the modal on an RDP session driven by a phone-sized screen", async () => {
    // Wide laymux window + a phone-shaped remote display: the narrow-window
    // heuristic must NOT fire, so a pass here proves the phone-RDP path opened it.
    useSettingsStore.getState().setRemote({ autoMobileModeMinWidth: 720 });
    setInnerWidth(1920);
    setScreen(390, 844);
    vi.mocked(getRemoteSessionActive).mockResolvedValue(true);

    render(<Probe />);

    await waitFor(() => {
      expect(useUiStore.getState().remoteAccessModalOpen).toBe(true);
    });
  });

  it("does NOT open the modal on a desktop-sized RDP session", async () => {
    useSettingsStore.getState().setRemote({ autoMobileModeMinWidth: 720 });
    setInnerWidth(1920);
    setScreen(1920, 1080);
    vi.mocked(getRemoteSessionActive).mockResolvedValue(true);

    render(<Probe />);

    // Let the resolved promise run.
    await Promise.resolve();
    await Promise.resolve();
    expect(useUiStore.getState().remoteAccessModalOpen).toBe(false);
  });

  it("does NOT open the modal on a portrait but large (rotated-monitor) RDP session", async () => {
    useSettingsStore.getState().setRemote({ autoMobileModeMinWidth: 720 });
    setScreen(1080, 1920);
    vi.mocked(getRemoteSessionActive).mockResolvedValue(true);

    render(<Probe />);

    await Promise.resolve();
    await Promise.resolve();
    expect(useUiStore.getState().remoteAccessModalOpen).toBe(false);
  });

  it("opens the modal when a phone RDP session connects after mount", async () => {
    useSettingsStore.getState().setRemote({ autoMobileModeMinWidth: 720 });
    setInnerWidth(1920);
    setScreen(390, 844);
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

  it("does not open the modal on a phone RDP session while local mobile mode is active", async () => {
    useSettingsStore.getState().setRemote({ autoMobileModeMinWidth: 720 });
    useLocalMobileModeStore.getState().enter("http://127.0.0.1:19281/remote/?localApp=1");
    setScreen(390, 844);
    vi.mocked(getRemoteSessionActive).mockResolvedValue(true);

    render(<Probe />);

    // Give the resolved promise a chance to run.
    await Promise.resolve();
    await Promise.resolve();
    expect(useUiStore.getState().remoteAccessModalOpen).toBe(false);
  });

  it("does not open the modal on a phone RDP session when the threshold is disabled", async () => {
    useSettingsStore.getState().setRemote({ autoMobileModeMinWidth: 0 });
    setScreen(390, 844);
    vi.mocked(getRemoteSessionActive).mockResolvedValue(true);

    render(<Probe />);

    await Promise.resolve();
    await Promise.resolve();
    expect(useUiStore.getState().remoteAccessModalOpen).toBe(false);
  });
});

describe("isPhoneLikeRemoteScreen", () => {
  const cases: Array<[string, number, number, number, boolean]> = [
    ["portrait phone", 390, 844, 720, true],
    ["portrait phone at the threshold edge", 720, 1280, 720, true],
    ["landscape desktop", 1920, 1080, 720, false],
    ["small 720p desktop (landscape)", 1280, 720, 720, false],
    ["portrait rotated monitor (wide short edge)", 1080, 1920, 720, false],
    ["landscape phone (not portrait)", 844, 390, 720, false],
  ];

  it.each(cases)("%s -> %s", (_label, width, height, threshold, expected) => {
    Object.defineProperty(window, "screen", { value: { width, height }, configurable: true });
    expect(isPhoneLikeRemoteScreen(threshold)).toBe(expected);
  });

  it("returns false when the threshold is disabled or non-finite", () => {
    Object.defineProperty(window, "screen", {
      value: { width: 390, height: 844 },
      configurable: true,
    });
    expect(isPhoneLikeRemoteScreen(0)).toBe(false);
    expect(isPhoneLikeRemoteScreen(Number.NaN)).toBe(false);
  });
});
