import { useEffect } from "react";
import { loadWindowGeometry, saveWindowGeometry, type WindowGeometry } from "@/lib/tauri-api";

const MIN_WINDOW_WIDTH = 200;
const MIN_WINDOW_HEIGHT = 150;

/** Last known good geometry, updated on move/resize events. */
let cachedGeometry: WindowGeometry | null = null;

/** Exposed for testing. */
export function _getCachedGeometry(): WindowGeometry | null {
  return cachedGeometry;
}
export function _resetCachedGeometry(): void {
  cachedGeometry = null;
}

/**
 * Restore window size/position from cached geometry on startup.
 * Clamps to the largest available monitor if saved size exceeds screen bounds.
 */
export async function restoreWindowGeometry(): Promise<void> {
  const geo = await loadWindowGeometry();
  if (!geo) return;

  // Skip invalid geometry (e.g. saved while minimized: x/y = -32000 on Windows)
  if (geo.width < MIN_WINDOW_WIDTH || geo.height < MIN_WINDOW_HEIGHT) return;
  if (geo.x <= -10000 || geo.y <= -10000) return;

  const { getCurrentWindow, PhysicalSize, PhysicalPosition, availableMonitors } =
    await import("@tauri-apps/api/window");

  const appWindow = getCurrentWindow();
  const monitors = await availableMonitors();

  // Find the largest monitor to use as max bounds
  let maxW = 1920;
  let maxH = 1080;
  for (const m of monitors) {
    if (m.size.width > maxW) maxW = m.size.width;
    if (m.size.height > maxH) maxH = m.size.height;
  }

  // Clamp size to monitor bounds
  const width = Math.min(geo.width, maxW);
  const height = Math.min(geo.height, maxH);

  await appWindow.setSize(new PhysicalSize(width, height));
  await appWindow.setPosition(new PhysicalPosition(geo.x, geo.y));

  if (geo.maximized) {
    await appWindow.maximize();
  }
}

/**
 * Snapshot current window geometry into the module-level cache.
 * Called on move/resize events so we always have the last good values.
 */
async function snapshotGeometry(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();

  const minimized = await appWindow.isMinimized();
  if (minimized) return;

  const pos = await appWindow.outerPosition();
  const size = await appWindow.innerSize();
  const maximized = await appWindow.isMaximized();

  cachedGeometry = {
    x: pos.x,
    y: pos.y,
    width: size.width,
    height: size.height,
    maximized,
  };
}

/**
 * Save window geometry to persistent cache.
 * If minimized, saves the last known good geometry instead of bogus values.
 *
 * NOTE: We save innerSize (content area), not outerSize (includes OS decorations),
 * because restoreWindowGeometry uses setSize() which sets the inner size.
 * Using outerSize would cause the window to grow by the decoration height on each restart.
 */
export async function captureWindowGeometry(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();

  const minimized = await appWindow.isMinimized();
  if (minimized) {
    // Save cached geometry from before minimization
    if (cachedGeometry) {
      await saveWindowGeometry(cachedGeometry);
    }
    return;
  }

  const pos = await appWindow.outerPosition();
  const size = await appWindow.innerSize();
  const maximized = await appWindow.isMaximized();

  const geo: WindowGeometry = {
    x: pos.x,
    y: pos.y,
    width: size.width,
    height: size.height,
    maximized,
  };

  cachedGeometry = geo;
  await saveWindowGeometry(geo);
}

/**
 * Hook: restores window geometry on mount and tracks move/resize for caching.
 */
export function useWindowGeometry() {
  useEffect(() => {
    restoreWindowGeometry().catch((err) => {
      console.warn("[useWindowGeometry] Failed to restore:", err);
    });

    let unlistenMove: (() => void) | null = null;
    let unlistenResize: (() => void) | null = null;

    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      const appWindow = getCurrentWindow();
      appWindow
        .onMoved(() => {
          snapshotGeometry().catch(() => {});
        })
        .then((fn) => {
          unlistenMove = fn;
        });
      appWindow
        .onResized(() => {
          snapshotGeometry().catch(() => {});
        })
        .then((fn) => {
          unlistenResize = fn;
        });
    });

    return () => {
      unlistenMove?.();
      unlistenResize?.();
    };
  }, []);
}
