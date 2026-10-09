import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import {
  listPtySessions,
  terminateDetachedPtySessions,
  terminatePtySession,
  type PtySessionEntry,
  type PtySessionInventory,
} from "@/lib/pty-sessions-api";
import { SettingsGroup } from "./SettingsLayout";

/** Sessions held by this GUI's panes are ended by closing the pane, not here. */
const ENDABLE_STATES = new Set<PtySessionEntry["state"]>(["detached"]);

/**
 * PTY daemon session inventory (ADR-0306): what still runs in the daemon and
 * a way to end what no pane holds any more — work left behind when the GUI
 * crashed before its layout was saved.
 */
export function PtySessionsSection() {
  const { t } = useTranslation("settings");
  const [inventory, setInventory] = useState<PtySessionInventory>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  // Bumped after an action so the listing reloads at once.
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let active = true;
    const load = () =>
      void listPtySessions().then(
        (value) => {
          if (!active) return;
          setInventory(value);
          setError(undefined);
        },
        (reason) => {
          if (!active) return;
          // A daemon that does not answer is not "no sessions": keep showing
          // the failure instead of an empty list.
          setInventory(undefined);
          setError(String(reason));
        },
      );
    load();
    const timer = setInterval(load, 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [revision]);

  const run = async (action: () => Promise<string>) => {
    setBusy(true);
    try {
      setNotice(await action());
    } catch (reason) {
      setNotice(String(reason));
    } finally {
      setBusy(false);
      setRevision((value) => value + 1);
    }
  };

  const endOne = (entry: PtySessionEntry) =>
    run(async () => t(`ptySessions.outcome.${await terminatePtySession(entry)}`));
  const endDetached = () =>
    run(async () => t("ptySessions.endedCount", { count: await terminateDetachedPtySessions() }));

  const sessions = inventory?.sessions ?? [];
  const detached = sessions.filter((entry) => entry.state === "detached").length;

  return (
    <SettingsGroup title={t("ptySessions.title")} description={t("ptySessions.description")}>
      <div className="settings-field pty-sessions-panel" data-testid="pty-sessions-panel">
        <div className="pty-sessions-panel__heading">
          <p className="pty-sessions-muted" aria-live="polite" data-testid="pty-sessions-summary">
            {error
              ? t("ptySessions.unavailable", { error })
              : inventory === undefined
                ? t("ptySessions.loading")
                : !inventory.daemonRunning
                  ? t("ptySessions.notRunning")
                  : t("ptySessions.summary", { count: sessions.length, detached })}
          </p>
          <Button
            onClick={endDetached}
            disabled={busy || detached === 0}
            data-testid="pty-sessions-end-detached"
          >
            {t("ptySessions.endDetached")}
          </Button>
        </div>
        {sessions.length > 0 && (
          <table className="pty-sessions-table" data-testid="pty-sessions-table">
            <thead>
              <tr>
                <th>{t("ptySessions.terminal")}</th>
                <th>{t("ptySessions.pid")}</th>
                <th>{t("ptySessions.state")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((entry) => (
                <tr key={entry.sessionId} data-state={entry.state}>
                  <td className="pty-sessions-table__terminal">{entry.terminalId}</td>
                  <td>{entry.childPid ?? "—"}</td>
                  <td>{t(`ptySessions.states.${entry.state}`)}</td>
                  <td>
                    {ENDABLE_STATES.has(entry.state) && (
                      <Button
                        onClick={() => void endOne(entry)}
                        disabled={busy}
                        data-testid={`pty-session-end-${entry.sessionId}`}
                      >
                        {t("ptySessions.end")}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {notice && (
          <p className="pty-sessions-muted" data-testid="pty-sessions-notice">
            {notice}
          </p>
        )}
      </div>
    </SettingsGroup>
  );
}
