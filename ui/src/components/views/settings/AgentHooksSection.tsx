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

function normalizeConfigPath(path: string | null | undefined) {
  if (!path) return undefined;
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith("//")
    ? normalized.toLowerCase()
    : normalized;
}

export function AgentHooksSection({ provider }: { provider: HookProvider }) {
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

  async function change(operation: "install" | "remove") {
    const request = ++sequence.current;
    setBusy(true);
    try {
      const value = await manageAgentHooks(provider, operation, distro, configDir || null);
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
      entry.event !== "SessionEnd" &&
      normalizeConfigPath(entry.configDir) === normalizeConfigPath(status?.configDir),
  ).length;
  return (
    <SettingsGroup title={t("agentHooks.title")}>
      <SettingsField label={t("agentHooks.environment")} desc={t("agentHooks.environmentDesc")}>
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
      </SettingsField>
      <SettingsField
        label={t("agentHooks.configDir")}
        desc={t("agentHooks.configDirDesc")}
        layout="stack"
      >
        <FocusInput
          data-testid="agent-hooks-config-dir"
          aria-label={t("agentHooks.configDir")}
          value={configDir}
          placeholder={status?.configDir || t("agentHooks.defaultDir")}
          disabled={busy}
          onChange={(e) => setConfigDir(e.target.value)}
        />
      </SettingsField>
      <SettingsField
        label={t("agentHooks.connection")}
        desc={t("agentHooks.optionalDesc")}
        layout="stack"
      >
        <div className="space-y-2" data-testid="agent-hooks-status" aria-live="polite">
          <p>
            {status
              ? t(
                  status.installed
                    ? "agentHooks.installed"
                    : status.registered > 0
                      ? "agentHooks.partial"
                      : "agentHooks.notInstalled",
                )
              : error
                ? t("agentHooks.checkFailed")
                : t("agentHooks.checking")}
          </p>
          {status && (
            <p className="text-[13px] break-all" style={{ color: "var(--text-secondary)" }}>
              {status.configPath}
            </p>
          )}
          {status?.disabled && <p>{t("agentHooks.disabled")}</p>}
          {status?.warning && <p className="break-all">{status.warning}</p>}
          {status?.installed && (
            <p>
              {observed ? t("agentHooks.received", { count: observed }) : t("agentHooks.waiting")}
            </p>
          )}
          {status?.installed && provider === "codex" && (
            <p className="text-[13px]" style={{ color: "var(--text-secondary)" }}>
              {t("agentHooks.codexTrust")}
            </p>
          )}
          {error && (
            <p role="alert" className="break-all" style={{ color: "var(--red)" }}>
              {error}
            </p>
          )}
          <div className="flex gap-2 flex-wrap">
            <Button
              data-testid="agent-hooks-install"
              variant="primary"
              disabled={busy || !status}
              onClick={() => void change("install")}
            >
              {t(status?.installed ? "agentHooks.reinstall" : "agentHooks.install")}
            </Button>
            <Button
              data-testid="agent-hooks-remove"
              disabled={busy || !status || (!status.registered && !status.helperPresent)}
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
        </div>
      </SettingsField>
    </SettingsGroup>
  );
}
