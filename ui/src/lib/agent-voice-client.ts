export type VoiceState = { status: "idle" | "starting" | "connected" | "error"; error?: string };
export interface VoiceSignaling {
  start(sdp: string): Promise<string>;
  poll(
    id: string,
    since: number,
  ): Promise<{
    sequence: number;
    closed: boolean;
    events: { method: string; params: { sdp?: string; message?: string; error?: string } }[];
  }>;
  stop(id: string): Promise<unknown>;
}

type Run = {
  stream?: MediaStream;
  peer?: RTCPeerConnection;
  context?: AudioContext;
  playback?: HTMLAudioElement;
  session?: string;
  timer?: ReturnType<typeof setTimeout>;
  connectTimer?: ReturnType<typeof setTimeout>;
};

/** Media stays in WebRTC; only authenticated signaling goes through laymux. */
export function createAgentVoiceClient(
  api: VoiceSignaling,
  update: (state: VoiceState) => void,
  initialContext?: AudioContext,
) {
  async function signaling<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Voice signaling timed out")), 10000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  let current: Run | undefined;
  let suppliedContext = initialContext;
  async function dispose(run: Run) {
    clearTimeout(run.timer);
    clearTimeout(run.connectTimer);
    run.stream?.getTracks().forEach((track) => track.stop());
    run.peer?.close();
    if (run.playback) {
      run.playback.pause();
      run.playback.srcObject = null;
      run.playback.remove();
    }
    await run.context?.close().catch(() => {});
    if (run.session) await api.stop(run.session).catch(() => {});
  }
  async function stop() {
    const run = current;
    current = undefined;
    update({ status: "idle" });
    if (run) await dispose(run);
  }
  async function fail(run: Run, error: unknown) {
    if (current !== run) return;
    current = undefined;
    update({ status: "error", error: error instanceof Error ? error.message : String(error) });
    await dispose(run);
  }
  async function start() {
    const previous = current;
    const run: Run = {};
    current = run;
    update({ status: "starting" });
    try {
      if (previous) await dispose(previous);
      if (current !== run) return;
      if (!navigator.mediaDevices?.getUserMedia)
        throw new Error("Voice requires microphone access on an HTTPS or localhost page");
      // Resume under the initiating user gesture, before the permission dialog.
      run.context = suppliedContext ?? new AudioContext();
      suppliedContext = undefined;
      await run.context.resume();
      run.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
      if (current !== run) {
        await dispose(run);
        return;
      }
      const peer = new RTCPeerConnection();
      run.peer = peer;
      run.stream.getTracks().forEach((track) => peer.addTrack(track, run.stream!));
      peer.createDataChannel("oai-events");
      peer.ontrack = (event) => {
        if (current !== run || !run.context) return;
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        const playback = (run.playback ??= document.createElement("audio"));
        playback.autoplay = true;
        playback.srcObject = stream;
        void playback.play().catch((error: unknown) => fail(run, error));
      };
      peer.onconnectionstatechange = () => {
        if (current !== run) return;
        if (peer.connectionState === "connected") {
          clearTimeout(run.connectTimer);
          update({ status: "connected" });
        } else if (peer.connectionState === "failed" || peer.connectionState === "disconnected")
          void fail(run, new Error("Voice media connection was lost"));
      };
      run.connectTimer = setTimeout(() => {
        void fail(run, new Error("Voice media connection timed out"));
      }, 30000);
      await peer.setLocalDescription(await peer.createOffer());
      if (peer.iceGatheringState !== "complete") {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            peer.removeEventListener("icegatheringstatechange", gathered);
            reject(new Error("Voice ICE gathering timed out"));
          }, 10000);
          function gathered() {
            if (peer.iceGatheringState === "complete") {
              clearTimeout(timeout);
              peer.removeEventListener("icegatheringstatechange", gathered);
              resolve();
            }
          }
          peer.addEventListener("icegatheringstatechange", gathered);
          gathered();
        });
      }
      if (current !== run) {
        await dispose(run);
        return;
      }
      const sdp = peer.localDescription?.sdp;
      if (!sdp) throw new Error("Voice audio offer is unavailable");
      run.session = await api.start(sdp);
      if (current !== run) {
        await dispose(run);
        return;
      }
      let since = 0;
      const poll = async () => {
        if (current !== run || !run.session) return;
        try {
          const response = await signaling(api.poll(run.session, since));
          if (current !== run) return;
          since = response.sequence;
          for (const event of response.events) {
            if (event.method === "thread/realtime/sdp" && event.params.sdp)
              await peer.setRemoteDescription({ type: "answer", sdp: event.params.sdp });
            if (event.method === "thread/realtime/error")
              throw new Error(event.params.message ?? event.params.error ?? "Codex voice failed");
          }
          if (response.closed) throw new Error("Codex voice session ended");
          run.timer = setTimeout(() => {
            void poll();
          }, 500);
        } catch (error) {
          await fail(run, error);
        }
      };
      await poll();
    } catch (error) {
      await fail(run, error);
    }
  }
  return { start, stop };
}
