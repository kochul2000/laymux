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
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      if (cancelled) return;
      const appWindow = getCurrentWindow();
      const CLOSE_TIMEOUT_MS = 5000;
      appWindow
        .onCloseRequested(async (event) => {
          event.preventDefault();
          try {
            await Promise.race([
              saveBeforeClose(),
              new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS)),
            ]);
          } catch {
            // Save failed — close anyway
          }
          await appWindow.destroy();
        })
        .then((unlisten) => {
          if (cancelled) unlisten();
          else cleanupRef.current = unlisten;
        })
        .catch(() => {});
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
