import { useEffect, useRef } from "react";
import { AppLayout } from "@/components/layout/AppLayout";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useSyncEvents } from "@/hooks/useSyncEvents";
import { useSessionPersistence } from "@/hooks/useSessionPersistence";
import { useAutomationBridge } from "@/hooks/useAutomationBridge";
import { saveBeforeClose } from "@/lib/persist-session";
import { createCloseHandler } from "@/lib/window-close-handler";
import { useWindowGeometry, captureWindowGeometry } from "@/hooks/useWindowGeometry";
import { useAppFocus } from "@/hooks/useAppFocus";

export function App() {
  useKeyboardShortcuts();
  useSyncEvents();
  const { loaded } = useSessionPersistence();
  useAutomationBridge();
  useWindowGeometry();
  useAppFocus();

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
          saveBeforeClose: async () => {
            await captureWindowGeometry();
            await saveBeforeClose();
          },
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

  if (!loaded) {
    return (
      <div
        className="h-screen flex items-center justify-center"
        data-testid="app-root"
        style={{ background: "var(--bg, #1e1e2e)" }}
      >
        <div
          style={{
            color: "var(--text, #cdd6f4)",
            fontFamily: "system-ui, sans-serif",
            fontSize: 14,
            textAlign: "center",
          }}
        >
          <div style={{ marginBottom: 12, fontSize: 16 }}>Laymux</div>
          <div style={{ opacity: 0.5 }}>Loading session...</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen" data-testid="app-root">
      <AppLayout />
    </div>
  );
}
