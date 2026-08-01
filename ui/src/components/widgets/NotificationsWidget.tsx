import { useTranslation } from "react-i18next";
import { useNotificationStore } from "@/stores/notification-store";
import { useUiStore } from "@/stores/ui-store";
import { WidgetChrome, WidgetLabel } from "./WidgetChrome";
import type { WidgetComponentProps } from "./types";

/**
 * Ringer glyph from the icon font the toolbar buttons already use.
 *
 * Escaped rather than pasted so no encoding step can mangle it, and the count
 * beside it still carries the meaning where that font is absent.
 */
const BELL_GLYPH = "\uEA8F";

export function NotificationsWidget({ instance }: WidgetComponentProps) {
  const { t } = useTranslation("settings");
  const unread = useNotificationStore(
    (s) => s.notifications.filter((notification) => notification.readAt === null).length,
  );
  const toggleNotificationPanel = useUiStore((s) => s.toggleNotificationPanel);

  return (
    <WidgetChrome
      testId={`widget-notifications-${instance.id}`}
      title={
        unread === 0
          ? t("widgets.notificationsNone")
          : t("widgets.notificationsUnread", { num: unread })
      }
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
