import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import {
  createAndroidPairingQr,
  getAndroidPairingStatus,
  getRemoteAccessStatus,
  getRemoteControlStatus,
  reclaimRemoteControl,
  revokeAndroidPairing,
  setRemoteRuntimeAccess,
  type AndroidPairingStatus,
  type RemoteAccessStatus,
  type RemoteControlStatus,
} from "@/lib/tauri-api";
import {
  buildLocalMobileModeUrl,
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
import { FocusSelect } from "@/components/ui/FormControls";
import { useRemoteHostOptions } from "@/hooks/useRemoteHostOptions";

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
  const [androidPairing, setAndroidPairing] = useState<AndroidPairingStatus | null>(null);
  const [androidQrSvg, setAndroidQrSvg] = useState<string | null>(null);
  // Read once at mount. It is a render input (it decides which host resolves by
  // default), so it lives in lazily-initialised state rather than a ref —
  // refs must not be read during render.
  const [lastHost] = useState(readLastRemoteHost);
  // Raw user pick; "" means "no explicit choice yet, follow the resolved host".
  const [pickedHost, setPickedHost] = useState("");
  const [reclaiming, setReclaiming] = useState(false);
  const [actionPending, setActionPending] = useState<
    "runtime" | "mobile" | "android-create" | "android-revoke" | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const hostOptions = useRemoteHostOptions(remote.customHosts);
  const resolvedHost = chooseRemoteHost(hostOptions, remote.preferredHost, lastHost);
  // Derive instead of mirroring the pick into state from an effect: the pick
  // only wins while it is still an offered option, so a candidate list that
  // changes under us can never leave a dangling selection.
  const effectiveSelectedHost =
    pickedHost && hostOptions.some((option) => option.host === pickedHost)
      ? pickedHost
      : resolvedHost;

  const token = (accessStatus?.effectiveAuthToken ?? remote.authToken).trim();
  const tokenConfigured = token.length > 0;
  const effectiveEnabled = accessStatus?.effectiveEnabled ?? remote.enabled;
  const runtimeEnabled = accessStatus?.runtimeEnabled ?? false;
  const urlHost = effectiveSelectedHost || "<laymux-host>";
  const urlWithToken = tokenConfigured
    ? buildRemoteUrlWithToken(urlHost, port ?? "...", token)
    : t("remoteAccess.missing");
  const canCreateAndroidPairing = Boolean(
    remote.cloudEnabled && remote.cloudInstanceId && remote.cloudServerBaseUrl,
  );
  const androidQrSrc =
    androidQrSvg && androidPairing?.phase === "pending"
      ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(androidQrSvg)}`
      : null;

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
    if (androidPairing?.phase !== "pending") return;
    let cancelled = false;
    const refresh = () => {
      getAndroidPairingStatus()
        .then((next) => {
          if (cancelled) return;
          setAndroidPairing(next);
          if (next.phase !== "pending") setAndroidQrSvg(null);
        })
        .catch(() => {});
    };
    const timer = window.setInterval(refresh, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [androidPairing?.phase]);

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

  useEffect(() => {
    let cancelled = false;
    getAndroidPairingStatus()
      .then((next) => {
        if (!cancelled) setAndroidPairing((current) => current ?? next);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

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

  const handleCreateAndroidPairing = async () => {
    setActionPending("android-create");
    setError(null);
    try {
      const created = await createAndroidPairingQr();
      setAndroidPairing(created.status);
      setAndroidQrSvg(created.qrSvg);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActionPending(null);
    }
  };

  const handleRevokeAndroidPairing = async () => {
    setActionPending("android-revoke");
    setError(null);
    try {
      setAndroidPairing(await revokeAndroidPairing());
      setAndroidQrSvg(null);
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
            <FocusSelect
              data-testid="remote-host-select"
              value={effectiveSelectedHost}
              onChange={(event) => {
                const host = event.target.value;
                setPickedHost(host);
                writeLastRemoteHost(host);
              }}
              className="w-full rounded px-2 py-1 text-[12px]"
            >
              {hostOptions.map((option) => (
                <option key={`${option.kind}:${option.host}`} value={option.host}>
                  {option.label}
                </option>
              ))}
            </FocusSelect>
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
      <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
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
      <div
        data-testid="android-pairing-section"
        className="mt-3 rounded px-3 py-3"
        style={{
          background: "var(--bg-overlay)",
          border: "1px solid var(--border)",
        }}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
              {t("remoteAccess.androidPairingTitle")}
            </div>
            <div
              className="mt-1 text-[11px] leading-relaxed"
              style={{ color: "var(--text-secondary)" }}
            >
              {canCreateAndroidPairing
                ? t("remoteAccess.androidPairingDescription")
                : t("remoteAccess.androidPairingNeedsCloud")}
            </div>
            {androidPairing?.paired && (
              <div
                className="mt-1 text-[11px]"
                style={{
                  color: androidPairing.phase === "confirmed" ? "var(--green)" : "var(--yellow)",
                }}
              >
                {androidPairing.phase === "confirmed"
                  ? t("remoteAccess.androidPairingConfirmed")
                  : t("remoteAccess.androidPairingPending", {
                      time: androidPairing.expiresAt
                        ? new Date(androidPairing.expiresAt * 1000).toLocaleTimeString()
                        : "-",
                    })}
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              data-testid="android-pairing-generate"
              onClick={() => void handleCreateAndroidPairing()}
              disabled={!canCreateAndroidPairing || actionPending !== null}
              className="hover-bg rounded px-3 py-1.5 text-xs"
              style={{
                color: "var(--accent)",
                background: "transparent",
                border: "1px solid var(--border)",
                cursor: !canCreateAndroidPairing || actionPending !== null ? "default" : "pointer",
                opacity: !canCreateAndroidPairing || actionPending !== null ? 0.55 : 1,
              }}
            >
              {actionPending === "android-create"
                ? t("remoteAccess.androidPairingCreating")
                : androidPairing?.paired
                  ? t("remoteAccess.androidPairingRotate")
                  : t("remoteAccess.androidPairingCreate")}
            </button>
            {androidPairing?.paired && (
              <button
                type="button"
                data-testid="android-pairing-revoke"
                onClick={() => void handleRevokeAndroidPairing()}
                disabled={actionPending !== null}
                className="hover-bg rounded px-3 py-1.5 text-xs"
                style={{
                  color: "var(--red)",
                  background: "transparent",
                  border: "1px solid var(--border)",
                  cursor: actionPending !== null ? "default" : "pointer",
                  opacity: actionPending !== null ? 0.55 : 1,
                }}
              >
                {actionPending === "android-revoke"
                  ? t("remoteAccess.androidPairingRevoking")
                  : t("remoteAccess.androidPairingRevoke")}
              </button>
            )}
          </div>
        </div>
        {androidQrSrc && (
          <div className="mt-3 flex flex-col items-center gap-2">
            <img
              src={androidQrSrc}
              alt={t("remoteAccess.androidPairingQrAlt")}
              className="h-64 w-64 max-w-full rounded bg-white p-2"
            />
            <div className="text-center text-[11px]" style={{ color: "var(--text-secondary)" }}>
              {t("remoteAccess.androidPairingScanHint")}
            </div>
          </div>
        )}
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
