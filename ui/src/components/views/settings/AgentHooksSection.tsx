import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { FocusInput, FocusSelect } from "@/components/ui/FormControls";
import {
  getAgentHookConnections,
  listAgentHookEnvironments,
  manageAgentHooks,
  type HookConnection,
  type HookEnvironment,
  type HookProvider,
  type HookStatus,
} from "@/lib/agent-hooks-api";
import { SettingsField, SettingsGroup } from "./SettingsLayout";
import { useTerminalStore } from "@/stores/terminal-store";
import { manageAgentHooksAndRefresh } from "@/lib/agent-hook-updates";

function normalizeConfigPath(path: string | null | undefined) {
  if (!path) return undefined;
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

export function AgentHooksSection({
  provider,
  stateDetection = "heuristic",
  onStateDetectionChange,
}: {
  provider: HookProvider;
  stateDetection?: "heuristic" | "hooks";
  onStateDetectionChange?: (mode: "heuristic" | "hooks") => void;
}) {
  const { t } = useTranslation("settings");
  const [environments, setEnvironments] = useState<HookEnvironment[]>([]);
  const [environment, setEnvironment] = useState("native");
  const [configDir, setConfigDir] = useState("");
  const [result, setResult] = useState<{ key: string; status?: HookStatus; error?: string }>();
  const [connections, setConnections] = useState<HookConnection[]>([]);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const sequence = useRef(0);
  const distro = environment === "native" ? null : environment.slice(4);
  const key = JSON.stringify([provider, distro, configDir, revision]);
  const status = result?.key === key ? result.status : undefined;
  const error = result?.key === key ? result.error : undefined;
  const detected = useTerminalStore(
    (s) =>
      s.instances.filter(
        (i) =>
          i.taskDetectionSource === "hooks" &&
          i.agentHook?.snapshot.provider === provider &&
          i.agentHook.snapshot.distro === distro &&
          normalizeConfigPath(i.agentHook.snapshot.configDir) ===
            normalizeConfigPath(status?.configDir),
      ).length,
  );

  useEffect(() => {
    let active = true;
    void listAgentHookEnvironments()
      .then((value) => {
        if (active) setEnvironments(value ?? []);
      })
      .catch(() => {
        /* Native status still reports a useful error. */
      });
    const refresh = () =>
      void getAgentHookConnections()
        .then((value) => {
          if (active) setConnections(value ?? []);
        })
        .catch(() => {
          if (active) setConnections([]);
        });
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const request = ++sequence.current;
    let active = true;
    const timer = setTimeout(() => {
      void manageAgentHooks(provider, "status", distro, configDir || null).then(
        (value) => {
          if (active && sequence.current === request) setResult({ key, status: value });
        },
        (error: unknown) => {
          if (active && sequence.current === request) setResult({ key, error: String(error) });
        },
      );
    }, 200);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [provider, distro, configDir, key]);

  async function change(operation: "install" | "remove" | "update") {
    const request = ++sequence.current;
    setBusy(true);
    try {
      const value = await manageAgentHooksAndRefresh(
        provider,
        operation,
        distro,
        configDir || null,
      );
      if (sequence.current === request) setResult({ key, status: value });
    } catch (error) {
      if (sequence.current === request) setResult({ key, error: String(error) });
    } finally {
      setBusy(false);
    }
  }

  const observed = connections.filter(
    (entry) =>
      entry.provider === provider &&
      entry.distro === distro &&
      normalizeConfigPath(entry.configDir) === normalizeConfigPath(status?.configDir),
  ).length;
  const missing = status ? Math.max(0, status.expected - status.registered) : 0;
  const installed = Boolean(status?.installed);
  return (
    <SettingsGroup title={t("agentHooks.title")}>
      {onStateDetectionChange && (
        <SettingsField
          label={t("agentHooks.stateDetection")}
          desc={t("agentHooks.stateDetectionDesc")}
        >
          <FocusSelect
            data-testid="agent-hooks-detection"
            aria-label={t("agentHooks.stateDetection")}
            value={stateDetection}
            onChange={(e) => onStateDetectionChange(e.target.value as "heuristic" | "hooks")}
          >
            <option value="heuristic">{t("agentHooks.heuristic")}</option>
            <option value="hooks">{t("agentHooks.hooksFirst")}</option>
          </FocusSelect>
        </SettingsField>
      )}
      <div className="settings-field agent-hooks-panel" data-testid="agent-hooks-panel">
        <div className="agent-hooks-panel__heading">
          <div>
            <h4>{t("agentHooks.connection")}</h4>
            <p className="agent-hooks-muted">{t("agentHooks.environmentDesc")}</p>
          </div>
          <label className="agent-hooks-environment">
            <span>{t("agentHooks.environment")}</span>
            <FocusSelect
              data-testid="agent-hooks-environment"
              aria-label={t("agentHooks.environment")}
              value={environment}
              disabled={busy}
              onChange={(e) => {
                setEnvironment(e.target.value);
                setConfigDir("");
              }}
            >
              {environments.length ? (
                environments.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))
              ) : (
                <option value="native">{t("agentHooks.native")}</option>
              )}
            </FocusSelect>
          </label>
        </div>
        <div className="agent-hooks-summary" data-testid="agent-hooks-status" aria-live="polite">
          {configDir && (
            <p className="agent-hooks-path agent-hooks-muted" data-testid="agent-hooks-target">
              {configDir}
            </p>
          )}
          <div className="agent-hooks-status-line">
            <span
              className={`agent-hooks-status${installed ? " agent-hooks-status--installed" : ""}`}
            >
              {status
                ? t(
                    installed
                      ? "agentHooks.installed"
                      : status.registered > 0
                        ? "agentHooks.partial"
                        : "agentHooks.notInstalled",
                  )
                : t(error ? "agentHooks.checkFailed" : "agentHooks.checking")}
            </span>
            {status && (
              <span className="agent-hooks-muted">
                {t("agentHooks.registered", { count: status.registered, total: status.expected })}
              </span>
            )}
          </div>
          {status && (
            <p className="agent-hooks-plan" data-testid="agent-hooks-install-summary">
              {t(
                status.registered === 0
                  ? "agentHooks.addPlan"
                  : missing > 0
                    ? "agentHooks.repairPlan"
                    : "agentHooks.updatePlan",
                { count: missing > 0 ? missing : status.expected, total: status.expected },
              )}
            </p>
          )}
          {status?.updateRequired && (
            <p className="agent-hooks-notice" data-testid="agent-hooks-update-needed">
              {t("agentHooks.updateNeeded")}
            </p>
          )}
          {status?.updateWarning && (
            <p className="agent-hooks-notice" role="alert">
              {status.updateWarning}
            </p>
          )}
          {provider === "codex" && status?.titleBinding && (
            <p className="agent-hooks-muted" data-testid="agent-hooks-title-status">
              {t(
                status.titleBinding.configured
                  ? "agentHooks.titleConfigured"
                  : "agentHooks.titleMissing",
              )}
            </p>
          )}
          {stateDetection === "hooks" && (
            <p className="agent-hooks-muted" data-testid="agent-hooks-detection-status">
              {t("agentHooks.detected", { count: detected })}
            </p>
          )}
          {(status?.disabled || status?.warning || status?.titleBinding?.warning || error) && (
            <div className="agent-hooks-notice" role="alert">
              {status?.disabled && <p>{t("agentHooks.disabled")}</p>}
              {status?.warning && <p>{status.warning}</p>}
              {status?.titleBinding?.warning && <p>{status.titleBinding.warning}</p>}
              {error && <p>{error}</p>}
            </div>
          )}
        </div>
        <div className="agent-hooks-actions">
          <div className="agent-hooks-actions__buttons">
            <Button
              data-testid="agent-hooks-install"
              variant="primary"
              disabled={busy || !status}
              onClick={() => void change(status?.updateRequired ? "update" : "install")}
            >
              {t(
                status?.updateRequired
                  ? "agentHooks.update"
                  : installed || (status?.registered ?? 0) > 0
                    ? "agentHooks.reinstall"
                    : "agentHooks.install",
              )}
            </Button>
            <Button
              data-testid="agent-hooks-remove"
              disabled={
                busy ||
                !status ||
                (!status.registered &&
                  !status.ownedCommands &&
                  !status.helperPresent &&
                  !status.titleBinding?.managed)
              }
              onClick={() => void change("remove")}
            >
              {t("agentHooks.remove")}
            </Button>
            <Button
              data-testid="agent-hooks-refresh"
              disabled={busy}
              onClick={() => setRevision((v) => v + 1)}
            >
              {t("agentHooks.refresh")}
            </Button>
          </div>
          <p className="agent-hooks-muted">{t("agentHooks.immediate")}</p>
        </div>
        <details className="agent-hooks-details" data-testid="agent-hooks-details">
          <summary>{t("agentHooks.details")}</summary>
          <div className="agent-hooks-details__body">
            <label className="agent-hooks-directory">
              <span>{t("agentHooks.configDir")}</span>
              <FocusInput
                data-testid="agent-hooks-config-dir"
                aria-label={t("agentHooks.configDir")}
                value={configDir}
                placeholder={status?.configDir || t("agentHooks.defaultDir")}
                disabled={busy}
                onChange={(e) => setConfigDir(e.target.value)}
              />
              <span className="agent-hooks-muted">{t("agentHooks.configDirDesc")}</span>
            </label>
            {status && <p className="agent-hooks-path">{status.configPath}</p>}
            <p>{t("agentHooks.optionalDesc")}</p>
            {status?.installed && (
              <p>
                {observed ? t("agentHooks.received", { count: observed }) : t("agentHooks.waiting")}
              </p>
            )}
            {provider === "codex" && (
              <>
                <p>{t("agentHooks.codexDaemon")}</p>
                <p>{t("agentHooks.codexTrust")}</p>
              </>
            )}
          </div>
        </details>
      </div>
    </SettingsGroup>
  );
}
