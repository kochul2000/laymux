import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getRemoteControlStatus,
  reclaimRemoteControl,
  type RemoteControlStatus,
} from "@/lib/tauri-api";
import { useSettingsStore } from "@/stores/settings-store";

const REMOTE_PORT = import.meta.env.DEV ? 19281 : 19280;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[112px_1fr] gap-3 py-1.5 text-xs">
      <div style={{ color: "var(--text-secondary)" }}>{label}</div>
      <div className="min-w-0" style={{ color: "var(--text-primary)" }}>
        {children}
      </div>
    </div>
  );
}

function InlineCode({ children }: { children: React.ReactNode }) {
  return (
    <code className="min-w-0 flex-1 select-all break-all font-mono text-[12px]">{children}</code>
  );
}

export function RemoteAccessModal() {
  const { t } = useTranslation("common");
  const remote = useSettingsStore((state) => state.remote);
  const [status, setStatus] = useState<RemoteControlStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [reclaiming, setReclaiming] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const tokenConfigured = remote.authToken.trim().length > 0;
  const encodedToken = encodeURIComponent(remote.authToken.trim());
  const remoteUrl = `http://<laymux-host>:${REMOTE_PORT}/remote/`;
  const remoteUrlWithToken = `${remoteUrl}#token=${encodedToken}`;
  const localUrl = `http://127.0.0.1:${REMOTE_PORT}/remote/`;
  const localUrlWithToken = `${localUrl}#token=${encodedToken}`;

  const refresh = async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await getRemoteControlStatus());
    } catch (err) {
      setStatus(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const accessState = useMemo(() => {
    if (status?.active) return "active";
    if (!remote.enabled) return "disabled";
    if (!tokenConfigured) return "needsToken";
    return "ready";
  }, [remote.enabled, status?.active, tokenConfigured]);

  const accessColor =
    accessState === "active"
      ? "var(--green)"
      : accessState === "ready"
        ? "var(--accent)"
        : accessState === "needsToken"
          ? "var(--claude)"
          : "var(--text-secondary)";

  const controller =
    status?.clientName || status?.remoteAddr || t("remoteAccess.fallbackController");

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
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyButtonStyle: React.CSSProperties = {
    color: "var(--accent)",
    background: "transparent",
    border: "1px solid var(--border)",
    cursor: "pointer",
  };

  const renderCopyButton = (key: string, value: string) => (
    <button
      type="button"
      onClick={() => void handleCopy(key, value)}
      className="hover-bg shrink-0 rounded px-2 py-0.5 text-[11px]"
      style={copyButtonStyle}
    >
      {copied === key ? t("remoteAccess.copied") : t("remoteAccess.copy")}
    </button>
  );

  return (
    <div className="p-4">
      <div
        className="mb-3 rounded px-3 py-2 text-xs"
        style={{
          background: "var(--bg-base)",
          border: "1px solid var(--border)",
          color: accessColor,
        }}
      >
        {t(`remoteAccess.state.${accessState}`, { controller })}
      </div>

      <div
        className="rounded px-3 py-2"
        style={{
          background: "var(--bg-overlay)",
          border: "1px solid var(--border)",
        }}
      >
        <Row label={t("remoteAccess.enabled")}>
          {remote.enabled ? t("remoteAccess.yes") : t("remoteAccess.no")}
        </Row>
        <Row label={t("remoteAccess.token")}>
          {tokenConfigured ? (
            <div className="flex min-w-0 items-center gap-2">
              <InlineCode>{remote.authToken}</InlineCode>
              {renderCopyButton("token", remote.authToken)}
            </div>
          ) : (
            t("remoteAccess.missing")
          )}
        </Row>
        <Row label={t("remoteAccess.remoteUrl")}>
          <div className="flex min-w-0 items-center gap-2">
            <InlineCode>{remoteUrl}</InlineCode>
            {renderCopyButton("remoteUrl", remoteUrl)}
          </div>
        </Row>
        {tokenConfigured && (
          <Row label={t("remoteAccess.remoteUrlWithToken")}>
            <div className="flex min-w-0 items-center gap-2">
              <InlineCode>{remoteUrlWithToken}</InlineCode>
              {renderCopyButton("remoteUrlWithToken", remoteUrlWithToken)}
            </div>
          </Row>
        )}
        <Row label={t("remoteAccess.localUrl")}>
          <div className="flex min-w-0 items-center gap-2">
            <InlineCode>{localUrl}</InlineCode>
            {renderCopyButton("localUrl", localUrl)}
          </div>
        </Row>
        {tokenConfigured && (
          <Row label={t("remoteAccess.localUrlWithToken")}>
            <div className="flex min-w-0 items-center gap-2">
              <InlineCode>{localUrlWithToken}</InlineCode>
              {renderCopyButton("localUrlWithToken", localUrlWithToken)}
            </div>
          </Row>
        )}
        <Row label={t("remoteAccess.allowedIps")}>
          <span className="break-words">
            {remote.allowedIps.length > 0 ? remote.allowedIps.join(", ") : t("remoteAccess.none")}
          </span>
        </Row>
        <Row label={t("remoteAccess.allowedOrigins")}>
          <span className="break-words">
            {remote.allowedOrigins.length > 0
              ? remote.allowedOrigins.join(", ")
              : t("remoteAccess.none")}
          </span>
        </Row>
        <Row label={t("remoteAccess.lease")}>
          {loading
            ? t("remoteAccess.loading")
            : status?.active
              ? t("remoteAccess.activeLease", { controller })
              : t("remoteAccess.noLease")}
        </Row>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          data-testid="remote-access-refresh"
          onClick={() => void refresh()}
          className="hover-bg rounded px-3 py-1.5 text-xs"
          style={{
            color: "var(--text-primary)",
            background: "transparent",
            border: "1px solid var(--border)",
            cursor: "pointer",
          }}
        >
          {t("remoteAccess.refresh")}
        </button>
        {status?.active && (
          <button
            type="button"
            data-testid="remote-access-reclaim"
            onClick={handleReclaim}
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
            {reclaiming ? t("remoteAccess.reclaiming") : t("remoteAccess.reclaim")}
          </button>
        )}
      </div>

      {error && (
        <div className="mt-3 text-xs" style={{ color: "var(--red)" }}>
          {error}
        </div>
      )}
    </div>
  );
}
