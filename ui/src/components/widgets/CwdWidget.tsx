import { useTranslation } from "react-i18next";
import { useTerminalStore } from "@/stores/terminal-store";
import { abbreviatePath } from "@/lib/workspace-summary";
import { clipboardWriteText } from "@/lib/tauri-api";
import { WidgetChrome } from "./WidgetChrome";
import type { WidgetComponentProps } from "./types";
import { CWD_WIDGET_WIDTH } from "./widget-options";

/**
 * The focused terminal's working directory.
 *
 * Reads the CWD the SyncGroup already tracks rather than asking a shell
 * (ADR-0003); with no focused terminal there is nothing to show, and the widget
 * says so instead of showing another pane's path.
 */
export function CwdWidget({ instance }: WidgetComponentProps) {
  const { t } = useTranslation("settings");
  const cwd = useTerminalStore((s) => s.instances.find((terminal) => terminal.isFocused)?.cwd);

  return (
    <WidgetChrome
      testId={`widget-cwd-${instance.id}`}
      title={cwd ? `${cwd}\n${t("widgets.cwdCopyHint")}` : t("widgets.cwdNone")}
      onClick={cwd ? () => void clipboardWriteText(cwd).catch(() => {}) : undefined}
    >
      <span className="truncate" style={{ maxWidth: CWD_WIDGET_WIDTH }}>
        {cwd ? abbreviatePath(cwd) : "—"}
      </span>
    </WidgetChrome>
  );
}
