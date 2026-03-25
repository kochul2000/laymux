import { AppLayout } from "@/components/layout/AppLayout";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { useSyncEvents } from "@/hooks/useSyncEvents";
import { useSessionPersistence } from "@/hooks/useSessionPersistence";
import { useAutomationBridge } from "@/hooks/useAutomationBridge";

export function App() {
  useKeyboardShortcuts();
  useSyncEvents();
  useSessionPersistence();
  useAutomationBridge();

  return (
    <div className="h-screen" data-testid="app-root">
      <AppLayout />
    </div>
  );
}
