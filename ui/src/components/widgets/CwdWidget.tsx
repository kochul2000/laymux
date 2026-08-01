import { useTerminalStore } from "@/stores/terminal-store";
import { abbreviatePath } from "@/lib/workspace-summary";
import { clipboardWriteText } from "@/lib/tauri-api";
import { WidgetChrome } from "./WidgetChrome";
import type { WidgetComponentProps } from "./types";

/**
 * The focused terminal's working directory.
 *
 * Reads the CWD the SyncGroup already tracks rather than asking a shell
 * (ADR-0003); with no focused terminal there is nothing to show, and the widget
 * says so instead of showing another pane's path.
 */
export function CwdWidget({ instance }: WidgetComponentProps) {
  const cwd = useTerminalStore((s) => s.instances.find((terminal) => terminal.isFocused)?.cwd);

  return (
    <WidgetChrome
      testId={`widget-cwd-${instance.id}`}
      title={cwd ? `${cwd}\nClick to copy` : "No focused terminal"}
      onClick={cwd ? () => void clipboardWriteText(cwd).catch(() => {}) : undefined}
    >
      <span className="truncate" style={{ maxWidth: 220 }}>
        {cwd ? abbreviatePath(cwd) : "—"}
      </span>
    </WidgetChrome>
  );
}
