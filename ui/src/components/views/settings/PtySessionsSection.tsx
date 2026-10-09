import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { TwoClickConfirmButton } from "@/components/ui/TwoClickConfirmButton";
import {
  listPtySessions,
  terminateDetachedPtySessions,
  terminatePtySession,
  type PtySessionEntry,
  type PtySessionInventory,
} from "@/lib/pty-sessions-api";
import { SettingsGroup } from "./SettingsLayout";

/**
 * Only sessions nothing will ever hold again can be ended here. A pane's
 * session ends with its pane, and one the saved layout awaits (an unopened
 * workspace, a dock) is adopted when that pane mounts.
 */
const ENDABLE_STATES = new Set<PtySessionEntry["state"]>(["detached"]);

/**
 * PTY daemon session inventory (ADR-0306): what still runs in the daemon and
 * a way to end what no pane holds or will hold — work left behind when the
 * GUI crashed before its layout was saved. Sessions of every daemon
 * generation are listed; one per build, so an update leaves the earlier
 * build's sessions running in its own daemon (ADR-0308).
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

  const sessions = inventory?.sessions ?? [];
  const unavailableDaemons = inventory?.unavailableDaemons ?? [];
  const detachedEntries = sessions.filter((entry) => entry.state === "detached");
  const detached = detachedEntries.length;

  const endOne = (entry: PtySessionEntry) =>
    run(async () => t(`ptySessions.outcome.${await terminatePtySession(entry)}`));
  // Exactly the sessions shown (and confirmed) as detached, with their epochs.
  const endDetached = () =>
    run(async () => {
      const result = await terminateDetachedPtySessions(detachedEntries);
      const ended = t("ptySessions.endedCount", { count: result.ended });
      return result.failed.length === 0
        ? ended
        : `${ended} ${t("ptySessions.failedSome", { failures: result.failed.join("; ") })}`;
    });

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
          <TwoClickConfirmButton
            className="ui-btn ui-btn-secondary"
            onConfirm={() => void endDetached()}
            confirmLabel={t("ptySessions.endDetachedConfirm", { count: detached })}
            confirmChildren={t("ptySessions.confirm")}
            disabled={busy || detached === 0}
            data-testid="pty-sessions-end-detached"
          >
            {t("ptySessions.endDetached")}
          </TwoClickConfirmButton>
        </div>
        {unavailableDaemons.map((daemon) => (
          <p
            key={daemon.daemon}
            className="pty-sessions-muted"
            role="alert"
            data-testid={`pty-sessions-unavailable-${daemon.daemon}`}
          >
            {daemon.problem === "incompatible"
              ? t("ptySessions.daemonIncompatible", {
                  daemon: daemon.daemon,
                  protocol: daemon.protocolVersion,
                })
              : t("ptySessions.daemonNotAnswering", { daemon: daemon.daemon })}
          </p>
        ))}
        {sessions.length > 0 && (
          <table className="pty-sessions-table" data-testid="pty-sessions-table">
            <thead>
              <tr>
                <th>{t("ptySessions.terminal")}</th>
                <th>{t("ptySessions.profile")}</th>
                <th>{t("ptySessions.daemon")}</th>
                <th>{t("ptySessions.pid")}</th>
                <th>{t("ptySessions.state")}</th>
                <th aria-label={t("ptySessions.actions")} />
              </tr>
            </thead>
            <tbody>
              {sessions.map((entry) => (
                <tr key={`${entry.daemon}/${entry.sessionId}`} data-state={entry.state}>
                  <td className="pty-sessions-table__terminal">{entry.terminalId}</td>
                  <td>{entry.profile ?? "—"}</td>
                  <td title={entry.daemon}>
                    {entry.daemon === inventory?.currentDaemon
                      ? t("ptySessions.daemonCurrent")
                      : t("ptySessions.daemonPrevious")}
                  </td>
                  <td>{entry.childPid ?? "—"}</td>
                  <td>{t(`ptySessions.states.${entry.state}`)}</td>
                  <td>
                    {ENDABLE_STATES.has(entry.state) && (
                      <TwoClickConfirmButton
                        className="ui-btn ui-btn-secondary"
                        onConfirm={() => void endOne(entry)}
                        aria-label={t("ptySessions.endOne", { terminal: entry.terminalId })}
                        confirmLabel={t("ptySessions.endOneConfirm", {
                          terminal: entry.terminalId,
                        })}
                        confirmChildren={t("ptySessions.confirm")}
                        disabled={busy}
                        data-testid={`pty-session-end-${entry.sessionId}`}
                      >
                        {t("ptySessions.end")}
                      </TwoClickConfirmButton>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {notice && (
          <p className="pty-sessions-muted" aria-live="polite" data-testid="pty-sessions-notice">
            {notice}
          </p>
        )}
      </div>
    </SettingsGroup>
  );
}
