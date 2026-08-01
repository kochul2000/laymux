/**
 * The optional bottom widget surface (ADR-0105).
 *
 * Rendered outside the dock grid so it sits below every dock and spans the whole
 * window. It is a slot area and nothing else: it owns no data, and turning it
 * off hides the surface without touching the placement stored for it.
 */

import { useSettingsStore } from "@/stores/settings-store";
import { WidgetSlot } from "@/components/widgets/WidgetSlot";

export function StatusLine() {
  const statusLine = useSettingsStore((s) => s.widgets.statusLine);
  if (!statusLine.enabled) return null;

  return (
    <div
      data-testid="status-line"
      className="ui-toolbar shrink-0 px-1"
      style={{
        background: "var(--bg-surface)",
        borderTop: "1px solid var(--border)",
      }}
    >
      <WidgetSlot slot={{ surface: "statusLine", side: "left" }} instances={statusLine.left} />
      <WidgetSlot slot={{ surface: "statusLine", side: "right" }} instances={statusLine.right} />
    </div>
  );
}
