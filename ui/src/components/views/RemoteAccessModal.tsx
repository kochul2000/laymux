import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  getRemoteAccessStatus,
  getRemoteControlStatus,
  getRemoteHostCandidates,
  reclaimRemoteControl,
  setRemoteRuntimeAccess,
  type HostCandidate,
  type RemoteAccessStatus,
  type RemoteControlStatus,
} from "@/lib/tauri-api";
import {
  buildLocalMobileModeUrl,
  buildRemoteHostOptions,
  buildRemoteUrlWithToken,
  chooseRemoteHost,
  generateRemoteToken,
  readLastRemoteHost,
  writeLastRemoteHost,
} from "@/lib/remote-hosts";
import { useLocalMobileModeStore } from "@/stores/local-mobile-mode-store";
import { useRemoteAccessStore } from "@/stores/remote-access-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";
import { ToggleSwitch } from "@/components/ui/ToggleSwitch";

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_1fr] gap-3 py-1.5 text-xs">
      <div style={{ color: "var(--text-secondary)" }}>{label}</div>
      <div className="min-w-0" style={{ color: "var(--text-primary)" }}>
        {children}
      </div>
    </div>
  );
}

function Value({ children }: { children: ReactNode }) {
  return (
    <code className="block select-all break-all font-mono text-[12px] leading-relaxed">
      {children}
    </code>
  );
}

export function RemoteAccessModal() {
  const { t } = useTranslation("common");
  const remote = useSettingsStore((state) => state.remote);
  const closeRemoteAccessModal = useUiStore((state) => state.closeRemoteAccessModal);
  const enterMobileMode = useLocalMobileModeStore((state) => state.enter);
  const setRemoteAccessStatus = useRemoteAccessStore((state) => state.setStatus);
  const [port, setPort] = useState<number | null>(null);
  const [accessStatus, setAccessStatus] = useState<RemoteAccessStatus | null>(null);
  const [status, setStatus] = useState<RemoteControlStatus | null>(null);
  const [hostCandidates, setHostCandidates] = useState<HostCandidate[]>([]);
  const [lastHost, setLastHost] = useState(() => readLastRemoteHost());
  const [selectedHost, setSelectedHost] = useState("");
  const [reclaiming, setReclaiming] = useState(false);
  const [actionPending, setActionPending] = useState<"runtime" | "mobile" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const hostOptions = useMemo(
    () => buildRemoteHostOptions(hostCandidates, remote.customHosts),
    [hostCandidates, remote.customHosts],
  );

  useEffect(() => {
    setSelectedHost((current) => {
      if (current && hostOptions.some((option) => option.host === current)) return current;
      return chooseRemoteHost(hostOptions, remote.preferredHost, lastHost);
    });
  }, [hostOptions, lastHost, remote.preferredHost]);

  const token = (accessStatus?.effectiveAuthToken ?? remote.authToken).trim();
  const tokenConfigured = token.length > 0;
  const effectiveEnabled = accessStatus?.effectiveEnabled ?? remote.enabled;
  const runtimeEnabled = accessStatus?.runtimeEnabled ?? false;
  const effectiveSelectedHost =
    selectedHost || chooseRemoteHost(hostOptions, remote.preferredHost, lastHost);
  const urlHost = effectiveSelectedHost || "<laymux-host>";
  const urlWithToken = tokenConfigured
    ? buildRemoteUrlWithToken(urlHost, port ?? "...", token)
    : t("remoteAccess.missing");

  useEffect(() => {
    let cancelled = false;
    invoke<{ port: number }>("get_automation_info")
      .then((info) => {
        if (!cancelled) setPort(info.port);
      })
      .catch(() => {
        // Keep copy disabled rather than exposing a stale or bogus port.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getRemoteHostCandidates()
      .then((candidates) => {
        if (!cancelled) setHostCandidates(candidates);
      })
      .catch(() => {
        if (!cancelled) setHostCandidates([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getRemoteControlStatus()
      .then((next) => {
        if (!cancelled) setStatus(next);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    getRemoteAccessStatus()
      .then((next) => {
        if (!cancelled) {
          setAccessStatus(next);
          setRemoteAccessStatus(next);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAccessStatus(null);
          setRemoteAccessStatus(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [setRemoteAccessStatus]);

  const handleReclaim = async () => {
    setReclaiming(true);
    setError(null);
    try {
      setStatus(await reclaimRemoteControl());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReclaiming(false);
    }
  };

  const handleCopy = async (key: string, value: string) => {
    await navigator.clipboard?.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1200);
  };

  const tokenForEnable = () => token || generateRemoteToken();

  const handleToggleRuntimeAccess = async () => {
    const nextEnabled = !runtimeEnabled;
    setActionPending("runtime");
    setError(null);
    try {
      const next = await setRemoteRuntimeAccess(nextEnabled, nextEnabled ? tokenForEnable() : null);
      setAccessStatus(next);
      setRemoteAccessStatus(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  };

  const handleOpenMobileMode = async () => {
    if (port === null) return;
    setActionPending("mobile");
    setError(null);
    try {
      let nextToken = token;
      if (!effectiveEnabled || nextToken.length === 0) {
        const enableToken = tokenForEnable();
        const next = await setRemoteRuntimeAccess(true, enableToken);
        setAccessStatus(next);
        setRemoteAccessStatus(next);
        nextToken = (next.effectiveAuthToken || enableToken).trim();
      }
      if (nextToken.length === 0) {
        throw new Error(t("remoteAccess.missingTokenForMobileMode"));
      }
      enterMobileMode(buildLocalMobileModeUrl(port, nextToken));
      closeRemoteAccessModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  };

  const copyButton = (key: string, value: string) => (
    <button
      type="button"
      onClick={() => void handleCopy(key, value)}
      disabled={!tokenConfigured || port === null}
      className="hover-bg shrink-0 rounded px-2 py-0.5 text-[11px]"
      style={{
        color: "var(--accent)",
        background: "transparent",
        border: "1px solid var(--border)",
        cursor: !tokenConfigured || port === null ? "default" : "pointer",
        opacity: !tokenConfigured || port === null ? 0.55 : 1,
      }}
    >
      {copied === key ? t("remoteAccess.copied") : t("remoteAccess.copy")}
    </button>
  );

  return (
    <div className="p-4">
      <div
        className="rounded px-3 py-2"
        style={{
          background: "var(--bg-overlay)",
          border: "1px solid var(--border)",
        }}
      >
        <Row label={t("remoteAccess.state")}>
          {effectiveEnabled ? t("remoteAccess.enabled") : t("remoteAccess.disabled")}
        </Row>
        <Row label={t("remoteAccess.host")}>
          {hostOptions.length > 0 ? (
            <select
              data-testid="remote-host-select"
              value={effectiveSelectedHost}
              onChange={(event) => {
                const host = event.target.value;
                setSelectedHost(host);
                setLastHost(host);
                writeLastRemoteHost(host);
              }}
              className="ui-focus-ring w-full rounded px-2 py-1 text-[12px]"
              style={{
                color: "var(--text-primary)",
                background: "var(--bg-base)",
                border: "1px solid var(--border)",
                outline: "none",
                colorScheme: "dark",
              }}
            >
              {hostOptions.map((option) => (
                <option key={`${option.kind}:${option.host}`} value={option.host}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            <Value>{"<laymux-host>"}</Value>
          )}
        </Row>
        <Row label={t("remoteAccess.urlWithToken")}>
          <div className="flex min-w-0 items-center gap-2">
            <Value>{urlWithToken}</Value>
            {copyButton("url", urlWithToken)}
          </div>
        </Row>
        <Row label={t("remoteAccess.token")}>
          {tokenConfigured ? (
            <div className="flex min-w-0 items-center gap-2">
              <Value>{token}</Value>
              {copyButton("token", token)}
            </div>
          ) : (
            t("remoteAccess.missing")
          )}
        </Row>
      </div>
      <div className="mt-3 flex flex-col items-start gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs" style={{ color: "var(--text-primary)" }}>
            {t("remoteAccess.runtimeThisRun")}
          </span>
          <ToggleSwitch
            data-testid="remote-runtime-toggle"
            aria-label={t("remoteAccess.runtimeThisRun")}
            checked={runtimeEnabled}
            onChange={() => void handleToggleRuntimeAccess()}
            disabled={actionPending !== null}
          />
          <span className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
            {runtimeEnabled
              ? t("remoteAccess.runtimeThisRunOn")
              : t("remoteAccess.runtimeThisRunOff")}
          </span>
        </div>
        <button
          type="button"
          data-testid="remote-mobile-mode-open"
          onClick={() => void handleOpenMobileMode()}
          disabled={actionPending !== null || port === null}
          className="hover-bg rounded px-3 py-1.5 text-xs"
          style={{
            color: "var(--accent)",
            background: "transparent",
            border: "1px solid var(--border)",
            cursor: actionPending !== null || port === null ? "default" : "pointer",
            opacity: actionPending !== null || port === null ? 0.65 : 1,
          }}
        >
          {actionPending === "mobile"
            ? t("remoteAccess.openingMobileMode")
            : t("remoteAccess.openMobileMode")}
        </button>
      </div>
      {status?.active && (
        <div className="mt-3">
          <button
            type="button"
            data-testid="remote-access-reclaim"
            onClick={() => void handleReclaim()}
            disabled={reclaiming}
            className="rounded px-3 py-1.5 text-xs"
            style={{
              color: "var(--bg-base)",
              background: "var(--accent)",
              border: "1px solid var(--accent)",
              cursor: reclaiming ? "default" : "pointer",
              opacity: reclaiming ? 0.7 : 1,
            }}
          >
            {reclaiming ? t("remoteControl.reclaiming") : t("remoteControl.reclaim")}
          </button>
        </div>
      )}
      {error && (
        <div className="mt-3 text-xs" style={{ color: "var(--red)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
