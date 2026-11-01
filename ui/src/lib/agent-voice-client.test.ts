import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentVoiceClient } from "./agent-voice-client";

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function devices(permission = Promise.resolve({ getTracks: () => [track] })) {
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(() => permission) } });
  vi.stubGlobal(
    "RTCPeerConnection",
    vi.fn(function () {
      return peer;
    }),
  );
  vi.stubGlobal(
    "AudioContext",
    vi.fn(function () {
      return context;
    }),
  );
  return permission;
}
const track = { stop: vi.fn() };
const peer = {
  addTrack: vi.fn(),
  createDataChannel: vi.fn(),
  createOffer: vi.fn(async () => ({ type: "offer", sdp: "offer" })),
  setLocalDescription: vi.fn(async () => {}),
  localDescription: { sdp: "offer" },
  iceGatheringState: "complete",
  close: vi.fn(),
  setRemoteDescription: vi.fn(async () => {}),
  connectionState: "new",
  ontrack: null,
  onconnectionstatechange: null,
};
const context = {
  resume: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
};

describe("client audio lifetime", () => {
  it("a hung signaling connection closes the microphone and peer", async () => {
    vi.useFakeTimers();
    devices();
    const api = {
      start: vi.fn(async () => "session"),
      poll: vi.fn(() => new Promise<never>(() => {})),
      stop: vi.fn(async () => {}),
    };
    const update = vi.fn();
    const voice = createAgentVoiceClient(api, update);
    const started = voice.start();
    await vi.waitFor(() => expect(api.poll).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(10001);
    await started;
    expect(update).toHaveBeenLastCalledWith({
      status: "error",
      error: "Voice signaling timed out",
    });
    expect(track.stop).toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalled();
    expect(api.stop).toHaveBeenCalledWith("session");
  });
  it("stopping during microphone permission releases a late stream without opening a server session", async () => {
    let grant!: (stream: { getTracks: () => (typeof track)[] }) => void;
    devices(
      new Promise((resolve) => {
        grant = resolve;
      }),
    );
    const api = { start: vi.fn(), poll: vi.fn(), stop: vi.fn() };
    const voice = createAgentVoiceClient(api, vi.fn());
    const pending = voice.start();
    await vi.waitFor(() => expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalled());
    await voice.stop();
    track.stop.mockClear();
    grant({ getTracks: () => [track] });
    await pending;
    expect(track.stop).toHaveBeenCalled();
    expect(api.start).not.toHaveBeenCalled();
  });

  it("a late server response is stopped after the user cancels", async () => {
    devices();
    let started!: (id: string) => void;
    const api = {
      start: vi.fn(
        () =>
          new Promise<string>((r) => {
            started = r;
          }),
      ),
      poll: vi.fn(),
      stop: vi.fn(async () => {}),
    };
    const voice = createAgentVoiceClient(api, vi.fn());
    const pending = voice.start();
    await vi.waitFor(() => expect(api.start).toHaveBeenCalledWith("offer"));
    await voice.stop();
    started("late-session");
    await pending;
    expect(api.stop).toHaveBeenCalledWith("late-session");
  });
});
