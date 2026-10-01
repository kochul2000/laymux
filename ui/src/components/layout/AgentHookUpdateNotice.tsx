import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import {
  useAgentHookUpdateStore,
  hookUpdateKey,
  updateAgentHooks,
  dismissHookUpdateNotice,
  refreshAgentHookUpdates,
} from "@/lib/agent-hook-updates";

export function AgentHookUpdateNotice() {
  const { t } = useTranslation("settings");
  const { targets, errors, dismissed, busyKey } = useAgentHookUpdateStore();
  const visible = targets.filter(
    (target) =>
      (target.status.updateRequired || target.status.updateWarning) &&
      !dismissed.includes(hookUpdateKey(target)),
  );
  const visibleErrors = errors.filter((error) => !dismissed.includes(JSON.stringify(error)));
  if (!visible.length && !visibleErrors.length) return null;
  return (
    <aside
      className="agent-hook-update-notice"
      data-testid="agent-hook-update-notice"
      aria-live="polite"
    >
      <strong>{t("agentHooks.updateNotice")}</strong>
      <p>{t("agentHooks.updateNoticeDesc")}</p>
      <div className="agent-hook-update-notice__targets">
        {visible.map((target) => (
          <div className="agent-hook-update-notice__target" key={hookUpdateKey(target)}>
            <div>
              <strong>
                {target.provider === "codex" ? "Codex" : "Claude"} ·{" "}
                {target.distro ? `WSL · ${target.distro}` : t("agentHooks.native")}
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
        {visibleErrors.map((error) => (
          <p className="agent-hooks-notice" role="alert" key={JSON.stringify(error)}>
            {error.provider} {error.distro} {error.message}
          </p>
        ))}
      </div>
      <div className="agent-hook-update-notice__actions">
        <Button disabled={busyKey !== null} onClick={() => void refreshAgentHookUpdates()}>
          {t("agentHooks.refresh")}
        </Button>
        <Button
          data-testid="agent-hook-update-dismiss"
          disabled={busyKey !== null}
          onClick={dismissHookUpdateNotice}
        >
          {t("agentHooks.later")}
        </Button>
      </div>
    </aside>
  );
}
