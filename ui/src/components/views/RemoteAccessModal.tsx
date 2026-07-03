import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  getRemoteAccessStatus,
  getRemoteControlStatus,
  reclaimRemoteControl,
  setRemoteRuntimeAccess,
  type RemoteAccessStatus,
  type RemoteControlStatus,
} from "@/lib/tauri-api";
import { persistSession } from "@/lib/persist-session";
import { useLocalMobileModeStore } from "@/stores/local-mobile-mode-store";
import { useRemoteAccessStore } from "@/stores/remote-access-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useUiStore } from "@/stores/ui-store";

const LOOPBACK_ALLOWED_IPS = ["127.0.0.1/32", "::1/128"];
const TAILSCALE_ALLOWED_IPS = ["100.64.0.0/10", "fd7a:115c:a1e0::/48"];
const LOCAL_MOBILE_CLIENT_NAME = "laymux-mobile";

export function buildLocalMobileModeUrl(port: number, token: string): string {
  const params = new URLSearchParams({
    localApp: "1",
    autoConnect: "1",
    clientName: LOCAL_MOBILE_CLIENT_NAME,
  });
  return `http://127.0.0.1:${port}/remote/?${params.toString()}#token=${encodeURIComponent(token)}`;
}

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

function generateRemoteToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseAllowedIps(value: string): string[] {
  const seen = new Set<string>();
  return value
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => {
      if (seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });
}

function formatAllowedIps(allowedIps: string[]): string {
  return allowedIps.join("\n");
}

function appendAllowedIps(current: string, entries: string[]): string {
  return formatAllowedIps(parseAllowedIps([...parseAllowedIps(current), ...entries].join("\n")));
}

function sameAllowedIps(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function normalizeAutoMobileWidth(value: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

export function RemoteAccessModal() {
  const { t } = useTranslation("common");
  const remote = useSettingsStore((state) => state.remote);
  const setRemote = useSettingsStore((state) => state.setRemote);
  const closeRemoteAccessModal = useUiStore((state) => state.closeRemoteAccessModal);
  const enterMobileMode = useLocalMobileModeStore((state) => state.enter);
  const setRemoteAccessStatus = useRemoteAccessStore((state) => state.setStatus);
  const [port, setPort] = useState<number | null>(null);
  const [accessStatus, setAccessStatus] = useState<RemoteAccessStatus | null>(null);
  const [status, setStatus] = useState<RemoteControlStatus | null>(null);
  const [reclaiming, setReclaiming] = useState(false);
  const [actionPending, setActionPending] = useState<
    "runtime" | "persistent" | "allowedIps" | "autoWidth" | "mobile" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [allowedIpsDraft, setAllowedIpsDraft] = useState(() => formatAllowedIps(remote.allowedIps));
  const [autoWidthDraft, setAutoWidthDraft] = useState(() => String(remote.autoMobileModeMinWidth));

  const token = (accessStatus?.effectiveAuthToken ?? remote.authToken).trim();
  const tokenConfigured = token.length > 0;
  const effectiveEnabled = accessStatus?.effectiveEnabled ?? remote.enabled;
  const runtimeEnabled = accessStatus?.runtimeEnabled ?? false;
  const persistentEnabled = accessStatus?.persistentEnabled ?? remote.enabled;
  const encodedToken = encodeURIComponent(token);
  const urlWithToken = tokenConfigured
    ? `http://<laymux-host>:${port ?? "..."}/remote/#token=${encodedToken}`
    : t("remoteAccess.missing");
  const allowedIps = parseAllowedIps(allowedIpsDraft);
  const allowedIpsChanged = !sameAllowedIps(allowedIps, remote.allowedIps);
  const autoWidth = normalizeAutoMobileWidth(autoWidthDraft);
  const autoWidthChanged = autoWidth !== remote.autoMobileModeMinWidth;

  useEffect(() => {
    setAllowedIpsDraft(formatAllowedIps(remote.allowedIps));
  }, [remote.allowedIps]);

  useEffect(() => {
    setAutoWidthDraft(String(remote.autoMobileModeMinWidth));
  }, [remote.autoMobileModeMinWidth]);

  const refreshAccessStatus = useCallback(async () => {
    const next = await getRemoteAccessStatus();
    setAccessStatus(next);
    setRemoteAccessStatus(next);
  }, [setRemoteAccessStatus]);

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

  const handleTogglePersistentAccess = async () => {
    const nextEnabled = !persistentEnabled;
    setActionPending("persistent");
    setError(null);
    try {
      setRemote({
        enabled: nextEnabled,
        ...(nextEnabled && remote.authToken.trim().length === 0
          ? { authToken: tokenForEnable() }
          : {}),
      });
      await persistSession();

      if (nextEnabled || !runtimeEnabled) {
        const next = await setRemoteRuntimeAccess(false, null);
        setAccessStatus(next);
        setRemoteAccessStatus(next);
      } else {
        await refreshAccessStatus();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  };

  const handleSaveAllowedIps = async () => {
    const nextAllowedIps = allowedIps.length > 0 ? allowedIps : LOOPBACK_ALLOWED_IPS;
    setActionPending("allowedIps");
    setError(null);
    try {
      setRemote({ allowedIps: nextAllowedIps });
      setAllowedIpsDraft(formatAllowedIps(nextAllowedIps));
      await persistSession();
      await refreshAccessStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  };

  const handleSaveAutoMobileWidth = async () => {
    setActionPending("autoWidth");
    setError(null);
    try {
      setRemote({ autoMobileModeMinWidth: autoWidth });
      setAutoWidthDraft(String(autoWidth));
      await persistSession();
      await refreshAccessStatus();
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
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="remote-mobile-mode-open"
          onClick={() => void handleOpenMobileMode()}
          disabled={actionPending !== null || port === null}
          className="rounded px-3 py-1.5 text-xs"
          style={{
            color: "var(--bg-base)",
            background: "var(--accent)",
            border: "1px solid var(--accent)",
            cursor: actionPending !== null || port === null ? "default" : "pointer",
            opacity: actionPending !== null || port === null ? 0.65 : 1,
          }}
        >
          {actionPending === "mobile"
            ? t("remoteAccess.openingMobileMode")
            : t("remoteAccess.openMobileMode")}
        </button>
      </div>
      <div
        className="mt-3 rounded px-3 py-2"
        style={{
          background: "var(--bg-overlay)",
          border: "1px solid var(--border)",
        }}
      >
        <Row label={t("remoteAccess.allowedIps")}>
          <div className="flex min-w-0 flex-col gap-2">
            <textarea
              data-testid="remote-allowed-ips-input"
              value={allowedIpsDraft}
              onChange={(event) => setAllowedIpsDraft(event.target.value)}
              rows={4}
              spellCheck={false}
              className="w-full resize-y rounded px-2 py-1.5 font-mono text-[12px]"
              placeholder={t("remoteAccess.allowedIpsPlaceholder")}
              style={{
                color: "var(--text-primary)",
                background: "var(--bg-base)",
                border: "1px solid var(--border)",
                outline: "none",
              }}
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() =>
                  setAllowedIpsDraft(appendAllowedIps(allowedIpsDraft, TAILSCALE_ALLOWED_IPS))
                }
                disabled={actionPending !== null}
                className="hover-bg rounded px-2 py-1 text-[11px]"
                style={{
                  color: "var(--accent)",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  cursor: actionPending !== null ? "default" : "pointer",
                  opacity: actionPending !== null ? 0.7 : 1,
                }}
              >
                {t("remoteAccess.addTailscale")}
              </button>
              <button
                type="button"
                onClick={() => setAllowedIpsDraft(formatAllowedIps(LOOPBACK_ALLOWED_IPS))}
                disabled={actionPending !== null}
                className="hover-bg rounded px-2 py-1 text-[11px]"
                style={{
                  color: "var(--accent)",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  cursor: actionPending !== null ? "default" : "pointer",
                  opacity: actionPending !== null ? 0.7 : 1,
                }}
              >
                {t("remoteAccess.resetLoopback")}
              </button>
              <button
                type="button"
                data-testid="remote-allowed-ips-save"
                onClick={() => void handleSaveAllowedIps()}
                disabled={actionPending !== null || !allowedIpsChanged}
                className="rounded px-2 py-1 text-[11px]"
                style={{
                  color: "var(--bg-base)",
                  background: "var(--accent)",
                  border: "1px solid var(--accent)",
                  cursor: actionPending !== null || !allowedIpsChanged ? "default" : "pointer",
                  opacity: actionPending !== null || !allowedIpsChanged ? 0.55 : 1,
                }}
              >
                {t("remoteAccess.saveAllowedIps")}
              </button>
            </div>
          </div>
        </Row>
        <Row label={t("remoteAccess.autoMobileMinWidth")}>
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <input
                data-testid="remote-auto-mobile-width-input"
                type="number"
                min={0}
                step={1}
                value={autoWidthDraft}
                onChange={(event) => setAutoWidthDraft(event.target.value)}
                className="w-28 rounded px-2 py-1.5 text-[12px]"
                style={{
                  color: "var(--text-primary)",
                  background: "var(--bg-base)",
                  border: "1px solid var(--border)",
                  outline: "none",
                }}
              />
              <button
                type="button"
                data-testid="remote-auto-mobile-width-save"
                onClick={() => void handleSaveAutoMobileWidth()}
                disabled={actionPending !== null || !autoWidthChanged}
                className="rounded px-2 py-1 text-[11px]"
                style={{
                  color: "var(--bg-base)",
                  background: "var(--accent)",
                  border: "1px solid var(--accent)",
                  cursor: actionPending !== null || !autoWidthChanged ? "default" : "pointer",
                  opacity: actionPending !== null || !autoWidthChanged ? 0.55 : 1,
                }}
              >
                {t("remoteAccess.saveAutoMobileMinWidth")}
              </button>
            </div>
            <div className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
              {t("remoteAccess.autoMobileMinWidthHint")}
            </div>
          </div>
        </Row>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="remote-runtime-toggle"
          onClick={() => void handleToggleRuntimeAccess()}
          disabled={actionPending !== null}
          className="hover-bg rounded px-3 py-1.5 text-xs"
          style={{
            color: runtimeEnabled ? "var(--bg-base)" : "var(--accent)",
            background: runtimeEnabled ? "var(--accent)" : "transparent",
            border: "1px solid var(--accent)",
            cursor: actionPending !== null ? "default" : "pointer",
            opacity: actionPending !== null ? 0.7 : 1,
          }}
        >
          {runtimeEnabled ? t("remoteAccess.runtimeOff") : t("remoteAccess.runtimeOn")}
        </button>
        <button
          type="button"
          data-testid="remote-persistent-toggle"
          onClick={() => void handleTogglePersistentAccess()}
          disabled={actionPending !== null}
          className="hover-bg rounded px-3 py-1.5 text-xs"
          style={{
            color: persistentEnabled ? "var(--bg-base)" : "var(--accent)",
            background: persistentEnabled ? "var(--accent)" : "transparent",
            border: "1px solid var(--accent)",
            cursor: actionPending !== null ? "default" : "pointer",
            opacity: actionPending !== null ? 0.7 : 1,
          }}
        >
          {persistentEnabled ? t("remoteAccess.persistentOff") : t("remoteAccess.persistentOn")}
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
