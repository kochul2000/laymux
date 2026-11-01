import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MicIcon, MicOffIcon } from "./icons";
import type { VoiceState } from "@/lib/agent-voice-client";

// The control bar can unmount on mouse leave. Audio belongs to the controller,
// not to that transient button (ADR-0369).
let snapshot: VoiceState & { terminalId?: string } = { status: "idle" };
const listeners = new Set<() => void>();
let client: { start(): Promise<void>; stop(): Promise<void> } | undefined;
let attempt = 0;
import.meta.hot?.dispose(() => {
  attempt++;
  void client?.stop();
});
function publish(state: VoiceState) {
  snapshot = { ...state, terminalId: snapshot.terminalId };
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

async function toggle(terminalId: string) {
  if (snapshot.status === "starting" || snapshot.status === "connected") {
    attempt++;
    publish({ status: "idle" });
    await client?.stop();
    return;
  }
  const ticket = ++attempt;
  snapshot = { status: "starting", terminalId };
  publish(snapshot);
  let context: AudioContext | undefined;
  try {
    context = new AudioContext();
    void context.resume();
    const { createAgentVoiceClient } = await import("@/lib/agent-voice-client");
    if (ticket !== attempt) {
      await context.close();
      return;
    }
    client = createAgentVoiceClient(
      {
        start: (sdp) => invoke<string>("voice_start", { terminalId, sdp }),
        poll: (sessionId, since) => invoke("voice_events", { sessionId, since }),
        stop: (sessionId) => invoke("voice_stop", { sessionId }),
      },
      publish,
      context,
    );
    await client.start();
  } catch (error) {
    await context?.close().catch(() => {});
    if (ticket === attempt) publish({ status: "error", error: String(error) });
  }
}

export function AgentVoiceButton({ terminalId }: { terminalId: string }) {
  const state = useSyncExternalStore(subscribe, () => snapshot);
  const active = state.status === "starting" || state.status === "connected";
  const title =
    state.status === "error" ? state.error : active ? "Codex Voice 중지" : "Codex Voice 시작";
  return (
    <button
      type="button"
      data-testid="pane-control-voice"
      aria-label={title}
      title={title}
      aria-pressed={active}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]"
      style={active ? { color: "var(--accent)" } : undefined}
      onClick={() => {
        void toggle(terminalId);
      }}
    >
      {active ? <MicOffIcon size={13} /> : <MicIcon size={13} />}
    </button>
  );
}
