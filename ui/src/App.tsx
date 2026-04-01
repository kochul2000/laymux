import { useEffect, useRef } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useSyncEvents } from "@/hooks/useSyncEvents";
import { useSessionPersistence } from "@/hooks/useSessionPersistence";
import { useAutomationBridge } from "@/hooks/useAutomationBridge";
import { saveBeforeClose } from "@/lib/persist-session";
import { createCloseHandler } from "@/lib/window-close-handler";

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
        const handler = createCloseHandler({
          destroy: () => appWindow.destroy(),
          close: () => appWindow.close(),
          saveBeforeClose,
          timeoutMs: 5000,
        });
        appWindow
          .onCloseRequested(handler)
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
