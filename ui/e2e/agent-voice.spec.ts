import { expect, test } from "@playwright/test";

test.use({
  permissions: ["microphone"],
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--mute-audio"],
  },
});

test("WebRTC sends and receives audio and releases it when stopped", async ({ page }) => {
  await page.route("**/voice-validation.html", (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: {
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'self'",
      },
      body: '<button id="voice">Voice</button><button id="stop">Stop</button><output id="status"></output>',
    }),
  );
  await page.goto("/voice-validation.html");
  await page.evaluate(async () => {
    const { createAgentVoiceClient } = await import("/src/lib/agent-voice-client.ts");
    const state = window as unknown as {
      voiceTest: {
        peer: RTCPeerConnection;
        server: RTCPeerConnection;
        stopped: number;
        stream?: MediaStream;
        playback?: HTMLAudioElement;
      };
    };
    const server = new RTCPeerConnection();
    const Base = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Base {
      constructor(configuration?: RTCConfiguration) {
        super(configuration);
        state.voiceTest.peer = this;
      }
    };
    state.voiceTest = { peer: null as unknown as RTCPeerConnection, server, stopped: 0 };
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this instanceof HTMLAudioElement) state.voiceTest.playback = this;
      return play.call(this);
    };
    const audio = new AudioContext();
    const oscillator = audio.createOscillator();
    const output = audio.createMediaStreamDestination();
    oscillator.connect(output);
    oscillator.start();
    server.addTrack(output.stream.getAudioTracks()[0], output.stream);
    server.ontrack = (event) => {
      state.voiceTest.stream = event.streams[0];
    };
    let answer = "";
    const client = createAgentVoiceClient(
      {
        start: async (sdp) => {
          await server.setRemoteDescription({ type: "offer", sdp });
          await server.setLocalDescription(await server.createAnswer());
          if (server.iceGatheringState !== "complete")
            await new Promise<void>((resolve) =>
              server.addEventListener("icegatheringstatechange", () => {
                if (server.iceGatheringState === "complete") resolve();
              }),
            );
          answer = server.localDescription!.sdp;
          return "session";
        },
        poll: async (_id, since) => ({
          sequence: 1,
          closed: false,
          events: since ? [] : [{ method: "thread/realtime/sdp", params: { sdp: answer } }],
        }),
        stop: async () => {
          state.voiceTest.stopped++;
          server.close();
          oscillator.stop();
          output.stream.getTracks().forEach((t) => t.stop());
          await audio.close();
        },
      },
      (value) => {
        document.querySelector("output")!.textContent = value.status;
      },
    );
    document.querySelector("#voice")!.addEventListener("click", () => {
      void audio.resume();
      void client.start();
    });
    document.querySelector("#stop")!.addEventListener("click", () => {
      void client.stop();
    });
  });
  await page.locator("#voice").click();
  await expect(page.locator("output")).toHaveText("connected");
  await expect
    .poll(() =>
      page.evaluate(async () => {
        const { peer } = (window as unknown as { voiceTest: { peer: RTCPeerConnection } })
          .voiceTest;
        const stats = await peer.getStats();
        let sent = 0,
          received = 0,
          decodedSamples = 0,
          receivedEnergy = 0;
        stats.forEach((stat) => {
          if (stat.type === "outbound-rtp") sent += stat.bytesSent ?? 0;
          if (stat.type === "inbound-rtp") {
            received += stat.bytesReceived ?? 0;
            decodedSamples += stat.totalSamplesReceived ?? 0;
            receivedEnergy += stat.totalAudioEnergy ?? 0;
          }
        });
        return sent > 0 && received > 0 && decodedSamples > 0 && receivedEnergy > 0;
      }),
    )
    .toBe(true);
  await page.locator("#stop").click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const value = (
          window as unknown as {
            voiceTest: { peer: RTCPeerConnection; stopped: number; playback?: HTMLAudioElement };
          }
        ).voiceTest;
        return {
          stopped: value.stopped,
          state: value.peer.connectionState,
          playbackReleased: value.playback?.paused && value.playback.srcObject === null,
        };
      }),
    )
    .toEqual({ stopped: 1, state: "closed", playbackReleased: true });
});
