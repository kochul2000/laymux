import type { Terminal } from "@xterm/xterm";

// Stagger WebGL context creation to prevent WebView2 GPU process crash.
// Multiple near-simultaneous WebGL inits can trigger ACCESS_VIOLATION in msedge.dll.
// This is the next reserved start time, not an in-flight count: a later reveal
// wave must be placed after every already-reserved slot.
let webglNextInitAt = 0;
const WEBGL_STAGGER_MS = 150;

export function monotonicNow(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

/** Reserve the next globally-spaced WebGL initialization slot. */
export function _reserveWebglInitDelay(now = monotonicNow()): number {
  const scheduledAt = Math.max(now, webglNextInitAt);
  webglNextInitAt = scheduledAt + WEBGL_STAGGER_MS;
  return scheduledAt - now;
}

/** Reset the stagger timeline (for tests). */
export function _resetWebglStagger(): void {
  webglNextInitAt = 0;
}

/**
 * True on a Linux **desktop** host.
 *
 * Two exclusions matter. WSL runs a Windows WebView, so its user agent reports
 * Windows and must not enable Linux-only IME handling. Android WebView reports
 * `Linux; Android ...` and is not a supported desktop target, so it is excluded
 * too rather than being silently treated as Linux.
 */
export function isLinuxHost(): boolean {
  const ua = navigator.userAgent;
  if (!ua.includes("Linux")) return false;
  return !ua.includes("Windows") && !ua.includes("Android");
}

export function shouldEnableTerminalWebgl(): boolean {
  return true;
}

/**
 * Whether the viewport is scrolled away from the bottom of the scrollback.
 * xterm exposes the bottom-most scroll offset as `buffer.active.baseY` and the
 * current top-of-viewport line as `viewportY`; they are equal exactly when the
 * user is pinned to the live bottom.
 */
export function isTerminalScrolledUp(terminal: Terminal): boolean {
  const activeBuffer = terminal.buffer.active as { baseY?: number; viewportY?: number };
  const baseY = activeBuffer.baseY ?? 0;
  const viewportY = activeBuffer.viewportY ?? baseY;
  return viewportY < baseY;
}
