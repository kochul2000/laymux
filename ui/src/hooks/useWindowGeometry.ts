import { useEffect } from "react";
import { loadWindowGeometry, saveWindowGeometry } from "@/lib/tauri-api";

/**
 * Restore window size/position from cached geometry on startup.
 * Clamps to the largest available monitor if saved size exceeds screen bounds.
 */
export async function restoreWindowGeometry(): Promise<void> {
  const geo = await loadWindowGeometry();
  if (!geo) return;

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
 * Capture current window geometry and save to cache.
 */
export async function captureWindowGeometry(): Promise<void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const appWindow = getCurrentWindow();

  const pos = await appWindow.outerPosition();
  const size = await appWindow.outerSize();
  const maximized = await appWindow.isMaximized();

  await saveWindowGeometry({
    x: pos.x,
    y: pos.y,
    width: size.width,
    height: size.height,
    maximized,
  });
}

/**
 * Hook: restores window geometry on mount.
 */
export function useWindowGeometry() {
  useEffect(() => {
    restoreWindowGeometry().catch((err) => {
      console.warn("[useWindowGeometry] Failed to restore:", err);
    });
  }, []);
}
