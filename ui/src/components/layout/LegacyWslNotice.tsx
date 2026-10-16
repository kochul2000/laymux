import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import { getLegacyWslNotice } from "@/lib/tauri-api";
import { useTerminalStore } from "@/stores/terminal-store";

/**
 * Warns that laymux's WSL runs fall back to the inbox (legacy) WSL client,
 * which creates a console per run (ADR-0337). The backend decides: it owns
 * both the client resolution and which sessions are WSL-backed. It is asked
 * again whenever a terminal session becomes ready, since WSL use starts with a
 * WSL-backed session. Closing hides the warning for this run only.
 */
export function LegacyWslNotice() {
  const { t } = useTranslation("settings");
  const readySessions = useTerminalStore(
    (s) => s.instances.filter((instance) => instance.sessionReady).length,
  );
  const [legacy, setLegacy] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (legacy || dismissed) return;
    let cancelled = false;
    getLegacyWslNotice()
      .then((inUse) => {
        if (!cancelled && inUse) setLegacy(true);
      })
      .catch(() => {
        // A failed check is no evidence of a legacy client.
      });
    return () => {
      cancelled = true;
    };
  }, [readySessions, legacy, dismissed]);

  if (!legacy || dismissed) return null;
  return (
    <aside className="legacy-wsl-notice" data-testid="legacy-wsl-notice" role="alert">
      <strong>{t("legacyWsl.title")}</strong>
      <p>{t("legacyWsl.description")}</p>
      <code className="legacy-wsl-notice__command">wsl --update</code>
      <div className="legacy-wsl-notice__actions">
        <Button data-testid="legacy-wsl-notice-dismiss" onClick={() => setDismissed(true)}>
          {t("legacyWsl.dismiss")}
        </Button>
      </div>
    </aside>
  );
}
