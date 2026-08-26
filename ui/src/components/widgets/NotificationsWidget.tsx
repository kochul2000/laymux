import { useTranslation } from "react-i18next";
import { useNotificationStore } from "@/stores/notification-store";
import { useUiStore } from "@/stores/ui-store";
import { BellIcon } from "@/components/ui/icons";
import { WidgetChrome, WidgetLabel } from "./WidgetChrome";
import type { WidgetComponentProps } from "./types";

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
        <BellIcon size={12} />
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
