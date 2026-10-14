import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { FocusInput, FocusSelect } from "@/components/ui/FormControls";
import {
  listAgentHookEnvironments,
  manageAgentMcp,
  type HookEnvironment,
  type McpProvider,
  type McpStatus,
} from "@/lib/agent-hooks-api";
import { SettingsGroup } from "./SettingsLayout";

const CONFIG_DIR_ENV: Record<McpProvider, string> = {
  claude: "CLAUDE_CONFIG_DIR",
  codex: "CODEX_HOME",
  grok: "GROK_HOME",
};

/** Laymux MCP registration per execution environment (ADR-0325). */
export function AgentMcpSection({ provider }: { provider: McpProvider }) {
  const { t } = useTranslation("settings");
  const [environments, setEnvironments] = useState<HookEnvironment[]>([]);
  const [environment, setEnvironment] = useState("native");
  const [configDir, setConfigDir] = useState("");
  // Typed text becomes a target only when committed, so partial paths are
  // never checked (each new target costs one helper run per app lifetime).
  const [configDraft, setConfigDraft] = useState("");
  const [result, setResult] = useState<{ key: string; status?: McpStatus; error?: string }>();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  // Startup already checked the defaults; only an explicit refresh re-reads.
  const refreshed = useRef(false);
  const sequence = useRef(0);
  const distro = environment === "native" ? null : environment.slice(4);
  const key = JSON.stringify([provider, distro, configDir, revision]);
  const status = result?.key === key ? result.status : undefined;
  const error = result?.key === key ? result.error : undefined;

  useEffect(() => {
    let active = true;
    void listAgentHookEnvironments()
      .then((value) => {
        if (active) setEnvironments(value ?? []);
      })
      .catch(() => {
        /* Native status still reports a useful error. */
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const request = ++sequence.current;
    let active = true;
    // Debounced so typing a folder does not probe each keystroke.
    const timer = setTimeout(() => {
      const cached = !refreshed.current;
      refreshed.current = false;
      void manageAgentMcp(provider, "status", distro, configDir || null, cached).then(
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

  async function change(operation: "install" | "remove") {
    const request = ++sequence.current;
    setBusy(true);
    try {
      const value = await manageAgentMcp(provider, operation, distro, configDir || null);
      if (sequence.current === request) setResult({ key, status: value });
    } catch (error) {
      // Nothing was written on failure, so the last known status still holds.
      if (sequence.current === request)
        setResult((prev) => ({
          key,
          status: prev?.key === key ? prev.status : undefined,
          error: String(error),
        }));
    } finally {
      setBusy(false);
    }
  }

  const installed = status?.state === "installed";
  return (
    <SettingsGroup title={t("agentMcp.title")}>
      <div className="settings-field agent-hooks-panel" data-testid="agent-mcp-panel">
        <div className="agent-hooks-panel__heading">
          <div>
            <h4>{t("agentMcp.connection")}</h4>
            <p className="agent-hooks-muted">{t("agentMcp.environmentDesc")}</p>
          </div>
          <label className="agent-hooks-environment">
            <span>{t("agentHooks.environment")}</span>
            <FocusSelect
              data-testid="agent-mcp-environment"
              aria-label={t("agentHooks.environment")}
              value={environment}
              disabled={busy}
              onChange={(e) => {
                setEnvironment(e.target.value);
                setConfigDir("");
                setConfigDraft("");
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
        <div className="agent-hooks-summary" data-testid="agent-mcp-status" aria-live="polite">
          <div className="agent-hooks-status-line">
            <span
              className={`agent-hooks-status${installed ? " agent-hooks-status--installed" : ""}`}
            >
              {status
                ? t(`agentMcp.${status.state}`)
                : t(error ? "agentHooks.checkFailed" : "agentHooks.checking")}
            </span>
            {status && <span className="agent-hooks-muted">{status.name}</span>}
          </div>
          {status && (
            <p className="agent-hooks-plan" data-testid="agent-mcp-plan">
              {status.url
                ? t(
                    installed
                      ? "agentMcp.installedPlan"
                      : status.state !== "different"
                        ? "agentMcp.addPlan"
                        : status.currentUrl === status.url
                          ? "agentMcp.repairPlan"
                          : "agentMcp.updatePlan",
                    { name: status.name, url: status.url },
                  )
                : t("agentMcp.unreachable")}
            </p>
          )}
          {status && !installed && status.currentUrl && status.currentUrl !== status.url && (
            <p className="agent-hooks-muted" data-testid="agent-mcp-current">
              {t("agentMcp.current", { url: status.currentUrl })}
            </p>
          )}
          {(status?.disabled || error) && (
            <div className="agent-hooks-notice" role="alert">
              {status?.disabled && <p>{t("agentMcp.disabled")}</p>}
              {error && <p>{error}</p>}
            </div>
          )}
        </div>
        <div className="agent-hooks-actions">
          <div className="agent-hooks-actions__buttons">
            <Button
              data-testid="agent-mcp-install"
              variant="primary"
              disabled={busy || !status?.url || installed}
              onClick={() => void change("install")}
            >
              {t(status?.state === "different" ? "agentMcp.update" : "agentMcp.install")}
            </Button>
            <Button
              data-testid="agent-mcp-remove"
              disabled={busy || !status || status.state === "missing"}
              onClick={() => void change("remove")}
            >
              {t("agentMcp.remove")}
            </Button>
            <Button
              data-testid="agent-mcp-refresh"
              disabled={busy}
              onClick={() => {
                refreshed.current = true;
                setRevision((v) => v + 1);
              }}
            >
              {t("agentHooks.refresh")}
            </Button>
          </div>
          <p className="agent-hooks-muted">{t("agentMcp.immediate")}</p>
        </div>
        <details className="agent-hooks-details" data-testid="agent-mcp-details">
          <summary>{t("agentMcp.details")}</summary>
          <div className="agent-hooks-details__body">
            <label className="agent-hooks-directory">
              <span>{t("agentHooks.configDir")}</span>
              <FocusInput
                data-testid="agent-mcp-config-dir"
                aria-label={t("agentHooks.configDir")}
                value={configDraft}
                placeholder={t("agentHooks.defaultDir")}
                disabled={busy}
                onChange={(e) => setConfigDraft(e.target.value)}
                onBlur={() => setConfigDir(configDraft.trim())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") setConfigDir(configDraft.trim());
                }}
              />
              <span className="agent-hooks-muted">
                {t("agentMcp.configDirDesc", { env: CONFIG_DIR_ENV[provider] })}
              </span>
            </label>
            {status && (
              <p className="agent-hooks-path" data-testid="agent-mcp-path">
                {status.configPath}
              </p>
            )}
            {provider === "grok" && <p>{t("agentMcp.grokCompat")}</p>}
          </div>
        </details>
      </div>
    </SettingsGroup>
  );
}
