import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import {
  useAgentHookUpdateStore,
  hookUpdateKey,
  hookUpdateErrorKey,
  hookMissingKey,
  missingInstallKey,
  installMissingIntegration,
  updateAgentHooks,
  dismissHookUpdateNotice,
  refreshAgentHookUpdates,
} from "@/lib/agent-hook-updates";
import { persistSession } from "@/lib/persist-session";
import { useSettingsStore } from "@/stores/settings-store";

const providerName = (provider: string) =>
  ({ claude: "Claude", codex: "Codex", grok: "Grok" })[provider] ?? provider;

export function AgentHookUpdateNotice() {
  const { t } = useTranslation("settings");
  const { targets, errors, missing, dismissed, busyKey } = useAgentHookUpdateStore();
  const missingEnabled = useSettingsStore((s) => s.notifications.agentIntegrationMissing);
  const setNotifications = useSettingsStore((s) => s.setNotifications);
  const [neverShowMissing, setNeverShowMissing] = useState(false);
  const visible = targets.filter(
    (target) =>
      (target.status.updateRequired || target.status.updateWarning) &&
      !dismissed.includes(hookUpdateKey(target)),
  );
  const visibleErrors = errors.filter((error) => !dismissed.includes(hookUpdateErrorKey(error)));
  // The setting hides only missing-integration rows (ADR-0330).
  const visibleMissing =
    missingEnabled === false
      ? []
      : missing.filter(
          (target) => (target.hook || target.mcp) && !dismissed.includes(hookMissingKey(target)),
        );
  if (!visible.length && !visibleErrors.length && !visibleMissing.length) return null;
  const updates = visible.length > 0 || visibleErrors.length > 0;
  const environment = (distro: string | null) =>
    distro ? `WSL · ${distro}` : t("agentHooks.native");
  function dismiss() {
    if (neverShowMissing && visibleMissing.length) {
      setNotifications({ agentIntegrationMissing: false });
      void persistSession();
    }
    dismissHookUpdateNotice();
  }
  return (
    <aside
      className="agent-hook-update-notice"
      data-testid="agent-hook-update-notice"
      aria-live="polite"
    >
      <strong>{t(updates ? "agentHooks.updateNotice" : "agentHooks.missingNotice")}</strong>
      {updates && <p>{t("agentHooks.updateNoticeDesc")}</p>}
      {visibleMissing.length > 0 && <p>{t("agentHooks.missingNoticeDesc")}</p>}
      <div className="agent-hook-update-notice__targets">
        {visible.map((target) => (
          <div className="agent-hook-update-notice__target" key={hookUpdateKey(target)}>
            <div>
              <strong>
                {providerName(target.provider)} · {environment(target.distro)}
              </strong>
              <p className="agent-hooks-path">{target.status.configDir}</p>
              {target.status.updateWarning && <p role="alert">{target.status.updateWarning}</p>}
            </div>
            <Button
              variant="primary"
              data-testid="agent-hook-update-action"
              disabled={busyKey !== null || !target.status.updateRequired}
              onClick={() => void updateAgentHooks(target)}
            >
              {t(busyKey === hookUpdateKey(target) ? "agentHooks.updating" : "agentHooks.update")}
            </Button>
          </div>
        ))}
        {visibleMissing.map((target) => (
          <div
            className="agent-hook-update-notice__target"
            data-testid="agent-integration-missing"
            key={hookMissingKey(target)}
          >
            <div>
              <strong>
                {providerName(target.provider)} · {environment(target.distro)}
              </strong>
              <p className="agent-hooks-muted">
                {[
                  target.hook && t("agentHooks.missingHook"),
                  target.mcp && t("agentHooks.missingMcp"),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
            </div>
            <div className="agent-hook-update-notice__installs">
              {(["hook", "mcp"] as const)
                .filter((integration) => target[integration])
                .map((integration) => (
                  <Button
                    key={integration}
                    variant="primary"
                    data-testid={`agent-integration-install-${integration}`}
                    disabled={busyKey !== null}
                    onClick={() => void installMissingIntegration(target, integration)}
                  >
                    {t(
                      busyKey === missingInstallKey(target, integration)
                        ? "agentHooks.installing"
                        : integration === "hook"
                          ? "agentHooks.installHook"
                          : "agentHooks.installMcp",
                    )}
                  </Button>
                ))}
            </div>
          </div>
        ))}
        {visibleErrors.map((error) => (
          <p className="agent-hooks-notice" role="alert" key={JSON.stringify(error)}>
            {error.provider} {error.distro} {error.message}
          </p>
        ))}
      </div>
      {visibleMissing.length > 0 && (
        <label className="agent-hook-update-notice__never">
          <input
            type="checkbox"
            data-testid="agent-integration-never-show"
            checked={neverShowMissing}
            onChange={(e) => setNeverShowMissing(e.target.checked)}
          />
          <span>{t("agentHooks.missingNeverShow")}</span>
        </label>
      )}
      <div className="agent-hook-update-notice__actions">
        <Button disabled={busyKey !== null} onClick={() => void refreshAgentHookUpdates()}>
          {t("agentHooks.refresh")}
        </Button>
        <Button
          data-testid="agent-hook-update-dismiss"
          disabled={busyKey !== null}
          onClick={dismiss}
        >
          {t("agentHooks.later")}
        </Button>
      </div>
    </aside>
  );
}
