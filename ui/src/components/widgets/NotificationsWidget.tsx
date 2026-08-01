import { useNotificationStore } from "@/stores/notification-store";
import { useUiStore } from "@/stores/ui-store";
import { WidgetChrome, WidgetLabel } from "./WidgetChrome";
import type { WidgetComponentProps } from "./types";

/** Ringer glyph, matching the icon font the toolbar buttons already use. */
const BELL_GLYPH = "";

export function NotificationsWidget({ instance }: WidgetComponentProps) {
  const unread = useNotificationStore(
    (s) => s.notifications.filter((notification) => notification.readAt === null).length,
  );
  const toggleNotificationPanel = useUiStore((s) => s.toggleNotificationPanel);

  return (
    <WidgetChrome
      testId={`widget-notifications-${instance.id}`}
      title={unread === 0 ? "No unread notifications" : `${unread} unread notifications`}
      onClick={toggleNotificationPanel}
    >
      <WidgetLabel>
        <span
          style={{ fontFamily: "'Segoe Fluent Icons', 'Segoe MDL2 Assets'" }}
          aria-hidden="true"
        >
          {BELL_GLYPH}
        </span>
      </WidgetLabel>
      <span
        data-testid={`widget-notifications-${instance.id}-count`}
        style={{ color: unread > 0 ? "var(--accent)" : "var(--text-muted)" }}
      >
        {unread}
      </span>
    </WidgetChrome>
  );
}
