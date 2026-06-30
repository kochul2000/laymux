import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useSettingsStore } from "@/stores/settings-store";

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
  const [port, setPort] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const token = remote.authToken.trim();
  const tokenConfigured = token.length > 0;
  const encodedToken = encodeURIComponent(token);
  const urlWithToken = tokenConfigured
    ? `http://<laymux-host>:${port ?? "..."}/remote/#token=${encodedToken}`
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

  const handleCopy = async (key: string, value: string) => {
    await navigator.clipboard?.writeText(value);
    setCopied(key);
    window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1200);
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
    </div>
  );
}
