import { useEffect } from "react";
import { useLocalMobileModeStore } from "@/stores/local-mobile-mode-store";

export function LocalMobileModeOverlay() {
  const active = useLocalMobileModeStore((state) => state.active);
  const url = useLocalMobileModeStore((state) => state.url);
  const exit = useLocalMobileModeStore((state) => state.exit);

  useEffect(() => {
    if (!active) return;

    const handleMessage = (event: MessageEvent) => {
      if ((event.data as { type?: string } | null)?.type === "laymux:desktop-mode") {
        exit();
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [active, exit]);

  if (!active || !url) return null;

  return (
    <div className="local-mobile-mode-overlay" data-testid="local-mobile-mode-overlay">
      <iframe
        allow="clipboard-write"
        className="local-mobile-mode-frame"
        data-testid="local-mobile-mode-frame"
        title="Laymux mobile mode"
        src={url}
      />
    </div>
  );
}
