import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/Button";
import {
  getAutomationServerStatus,
  retryAutomationServer,
  type AutomationServerStatus,
} from "@/lib/automation-server";

const STATUS_POLL_MS = 3000;

/** Native IPC remains available when the shared HTTP/MCP listener is down. */
export function McpServerNotice() {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<AutomationServerStatus | null>(null);
  const [ipcError, setIpcError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [recovered, setRecovered] = useState(false);

  const observe = useCallback((next: AutomationServerStatus) => {
    // An older poll may finish after the retry IPC has already succeeded.
    setStatus((previous) => (previous && previous.revision >= next.revision ? previous : next));
    setIpcError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await getAutomationServerStatus();
        if (!cancelled) observe(next);
      } catch (error) {
        if (!cancelled) setIpcError(String(error));
      } finally {
        if (!cancelled) timer = setTimeout(() => void poll(), STATUS_POLL_MS);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [observe]);

  const retry = async () => {
    setRetrying(true);
    try {
      const next = await retryAutomationServer();
      observe(next);
      setRecovered(next.phase === "running");
    } catch (error) {
      setIpcError(String(error));
    } finally {
      setRetrying(false);
    }
  };

  const failed = status?.phase === "failed" || ipcError !== null;
  const title =
    ipcError !== null
      ? "mcpServer.unknownTitle"
      : recovered && !failed
        ? "mcpServer.recoveredTitle"
        : "mcpServer.title";
  const description =
    ipcError !== null
      ? "mcpServer.unknownDescription"
      : recovered && !failed
        ? "mcpServer.recoveredDescription"
        : "mcpServer.description";
  if (!failed && !retrying && !recovered) return null;

  return (
    <aside
      className="mcp-server-notice"
      data-testid="mcp-server-notice"
      data-screenshot-occluder="true"
      role={failed ? "alert" : "status"}
    >
      <strong>{t(title)}</strong>
      <p>{t(description)}</p>
      {(ipcError || status?.error) && (
        <p className="mcp-server-notice__error">{ipcError || status?.error}</p>
      )}
      <div className="mcp-server-notice__actions">
        {failed || retrying ? (
          <Button
            variant="primary"
            data-testid="mcp-server-retry"
            disabled={retrying}
            title={retrying ? t("mcpServer.retrying") : undefined}
            onClick={() => void retry()}
          >
            {t(retrying ? "mcpServer.retrying" : "mcpServer.retry")}
          </Button>
        ) : (
          <Button data-testid="mcp-server-dismiss" onClick={() => setRecovered(false)}>
            {t("mcpServer.dismiss")}
          </Button>
        )}
      </div>
    </aside>
  );
}
