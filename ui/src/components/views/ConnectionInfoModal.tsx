import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface AutomationInfo {
  port: number;
  key: string;
}

export function ConnectionInfoModal() {
  const [info, setInfo] = useState<AutomationInfo | null>(null);

  useEffect(() => {
    invoke<AutomationInfo>("get_automation_info")
      .then(setInfo)
      .catch(() => {});
  }, []);

  if (!info) {
    return (
      <div className="p-4 text-sm" style={{ color: "var(--text-secondary)" }}>
        Loading...
      </div>
    );
  }

  const lines = [
    `LX_AUTOMATION_HOST=127.0.0.1`,
    `LX_AUTOMATION_PORT=${info.port}`,
    `LX_AUTOMATION_KEY=${info.key}`,
  ].join("\n");

  return (
    <div className="p-4">
      <pre
        className="select-all rounded p-3 font-mono text-[12px] leading-relaxed"
        style={{
          background: "var(--bg-base)",
          color: "var(--text-primary)",
          border: "1px solid var(--border)",
        }}
      >
        {lines}
      </pre>
    </div>
  );
}
