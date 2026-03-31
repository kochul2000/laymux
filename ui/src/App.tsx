import { useEffect, useRef } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useSyncEvents } from "@/hooks/useSyncEvents";
import { useSessionPersistence } from "@/hooks/useSessionPersistence";
import { useAutomationBridge } from "@/hooks/useAutomationBridge";
import { saveBeforeClose } from "@/lib/persist-session";

export function App() {
  useKeyboardShortcuts();
  useSyncEvents();
  useSessionPersistence();
  useAutomationBridge();

  // Save terminal state before window close (Alt+F4, OS close, etc.)
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    let cancelled = false;
    import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => {
        if (cancelled) return;
        const appWindow = getCurrentWindow();
        const CLOSE_TIMEOUT_MS = 5000;
        appWindow
          .onCloseRequested(async (event) => {
            event.preventDefault();
            try {
              const result = await Promise.race([
                saveBeforeClose().then(() => "saved" as const),
                new Promise<"timeout">((resolve) =>
                  setTimeout(() => resolve("timeout"), CLOSE_TIMEOUT_MS),
                ),
              ]);
              if (result === "timeout") {
                console.warn("[App] saveBeforeClose timed out after", CLOSE_TIMEOUT_MS, "ms");
              }
            } catch (err) {
              console.error("[App] saveBeforeClose failed:", err);
            }
            await appWindow.destroy();
          })
          .then((unlisten) => {
            if (cancelled) unlisten();
            else cleanupRef.current = unlisten;
          })
          .catch((err) => {
            console.error("[App] Failed to register onCloseRequested handler:", err);
          });
      })
      .catch((err) => {
        console.error("[App] Failed to import @tauri-apps/api/window:", err);
      });
    return () => {
      cancelled = true;
      cleanupRef.current?.();
    };
  }, []);

  return (
    <div className="h-screen" data-testid="app-root">
      <AppLayout />
    </div>
  );
}
