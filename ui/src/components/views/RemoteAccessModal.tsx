import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useSettingsStore } from "@/stores/settings-store";

const REMOTE_PORT = import.meta.env.DEV ? 19281 : 19280;

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

  const tokenConfigured = remote.authToken.trim().length > 0;
  const encodedToken = encodeURIComponent(remote.authToken.trim());
  const urlWithToken = tokenConfigured
    ? `http://<laymux-host>:${REMOTE_PORT}/remote/#token=${encodedToken}`
    : t("remoteAccess.missing");

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
          <Value>{urlWithToken}</Value>
        </Row>
        <Row label={t("remoteAccess.token")}>
          {tokenConfigured ? <Value>{remote.authToken}</Value> : t("remoteAccess.missing")}
        </Row>
      </div>
    </div>
  );
}
