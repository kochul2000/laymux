import { useCallback, useEffect, useState } from "react";
import { getCodexUsageSnapshot, type CodexUsageSnapshot } from "@/lib/tauri-api";

const pending: CodexUsageSnapshot = {
  status: { type: "failed", message: "Starting Codex usage reader" },
  limits: [],
  plan: null,
  capturedAtMs: null,
};

/** Poll Codex app-server only while a Codex UsageView is mounted. */
export function useCodexUsageSnapshot(refreshSeconds: number, configDir = "") {
  const [snapshot, setSnapshot] = useState<CodexUsageSnapshot>(pending);
  const refresh = useCallback(() => {
    getCodexUsageSnapshot(configDir)
      .then(setSnapshot)
      .catch((error: unknown) => {
        setSnapshot({
          status: { type: "failed", message: String(error) },
          limits: [],
          plan: null,
          capturedAtMs: null,
        });
      });
  }, [configDir]);

  useEffect(() => {
    refresh();
    const intervalMs = Math.min(3_600, Math.max(600, refreshSeconds)) * 1_000;
    const timer = setInterval(refresh, intervalMs);
    return () => clearInterval(timer);
  }, [refresh, refreshSeconds]);

  return { snapshot, refresh };
}
