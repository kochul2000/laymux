/**
 * In-process bus for cross-terminal renderer refresh signals.
 *
 * Why: when one xterm instance in the same WebView2 window exits a TUI app
 * (e.g. Codex) it floods the buffer with alt-screen restore / clear / scrollback
 * sequences. The resulting WebGL render burst can leave neighbour xterm WebGL
 * texture atlases in a stale state — characters render as scattered glyph
 * fragments. Forcing a `clearTextureAtlas()` + `refresh()` on every peer
 * terminal whenever a TUI process exits rebuilds the atlas without a visible
 * flash and avoids the corruption.
 *
 * Listeners receive every signal — including ones they themselves published —
 * and are responsible for filtering by `sourceId` to skip self-signals. This
 * keeps the bus dumb and side-effect free.
 */

export type RendererRefreshReason = "peer-tui-exit" | "peer-context-loss";

export interface RendererRefreshSignal {
  reason: RendererRefreshReason;
  sourceId: string;
}

type Listener = (signal: RendererRefreshSignal) => void;

const listeners: Set<Listener> = new Set();

export function subscribeRendererRefresh(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function publishRendererRefresh(signal: RendererRefreshSignal): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener(signal);
    } catch (err) {
      console.warn("[terminal-renderer-bus] listener threw:", err);
    }
  }
}

/** Test-only: clear all subscribers between cases. */
export function _resetRendererBus(): void {
  listeners.clear();
}
