import { useState } from "react";
import {
  resetSettings,
  getSettingsPath,
  type SettingsLoadResult,
  type ValidationWarning,
} from "@/lib/tauri-api";

interface SettingsRecoveryModalProps {
  loadResult: SettingsLoadResult;
  onDismiss: () => void;
  onReset: () => void;
}

/**
 * Modal shown when settings.json has issues (parse error or validation warnings).
 * Offers the user choices: reset to defaults, view path for manual editing, or dismiss.
 */
export function SettingsRecoveryModal({
  loadResult,
  onDismiss,
  onReset,
}: SettingsRecoveryModalProps) {
  const [settingsPath, setSettingsPath] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const isParseError = loadResult.status === "parse_error";
  const warnings: ValidationWarning[] = loadResult.status === "repaired" ? loadResult.warnings : [];
  const parseError = isParseError ? loadResult.error : null;
  const parseErrorPath = isParseError ? loadResult.settingsPath : null;

  const handleShowPath = async () => {
    try {
      const path = parseErrorPath || (await getSettingsPath());
      setSettingsPath(path);
    } catch {
      setSettingsPath("(경로를 가져올 수 없습니다)");
    }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      await resetSettings();
      onReset();
    } catch (err) {
      console.error("[SettingsRecoveryModal] Reset failed:", err);
      setResetting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: "rgba(0, 0, 0, 0.6)" }}
      data-testid="settings-recovery-overlay"
    >
      <div
        className="flex flex-col gap-4 rounded-lg p-6"
        style={{
          background: "var(--bg-surface, #313244)",
          color: "var(--text-primary, #cdd6f4)",
          border: "1px solid var(--border, #45475a)",
          maxWidth: 520,
          width: "90vw",
          maxHeight: "80vh",
          fontFamily: "system-ui, sans-serif",
          fontSize: 14,
        }}
        data-testid="settings-recovery-modal"
      >
        {/* Title */}
        <div className="flex items-center gap-2" style={{ fontSize: 16, fontWeight: 600 }}>
          <span
            style={{ color: isParseError ? "var(--error, #f38ba8)" : "var(--warning, #f9e2af)" }}
          >
            {isParseError ? "\u26A0" : "\u2139"}
          </span>
          <span>{isParseError ? "설정 파일을 읽을 수 없습니다" : "설정 파일 검증 결과"}</span>
        </div>

        {/* Parse error details */}
        {isParseError && parseError && (
          <div className="flex flex-col gap-2">
            <div style={{ color: "var(--text-secondary, #a6adc8)" }}>
              settings.json 파일의 JSON 구문이 올바르지 않아 기본 설정으로 시작합니다.
            </div>
            <pre
              className="overflow-auto rounded p-3 text-xs"
              style={{
                background: "var(--bg-base, #1e1e2e)",
                color: "var(--error, #f38ba8)",
                maxHeight: 120,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
              }}
            >
              {parseError}
            </pre>
          </div>
        )}

        {/* Validation warnings */}
        {warnings.length > 0 && (
          <div className="flex flex-col gap-2">
            <div style={{ color: "var(--text-secondary, #a6adc8)" }}>
              {warnings.filter((w) => w.repaired).length}개 항목이 자동 수정되었습니다.
              {warnings.filter((w) => !w.repaired).length > 0 &&
                ` ${warnings.filter((w) => !w.repaired).length}개 항목은 수동 확인이 필요합니다.`}
            </div>
            <div
              className="overflow-auto rounded p-3 text-xs"
              style={{
                background: "var(--bg-base, #1e1e2e)",
                maxHeight: 200,
              }}
            >
              {warnings.map((w, i) => (
                <div key={i} className="flex gap-2 py-0.5" style={{ lineHeight: 1.5 }}>
                  <span
                    style={{
                      color: w.repaired ? "var(--success, #a6e3a1)" : "var(--warning, #f9e2af)",
                      flexShrink: 0,
                    }}
                  >
                    {w.repaired ? "\u2713" : "\u26A0"}
                  </span>
                  <span style={{ color: "var(--text-secondary, #a6adc8)" }}>
                    <span
                      style={{ color: "var(--text-primary, #cdd6f4)", fontFamily: "monospace" }}
                    >
                      {w.path}
                    </span>
                    {" \u2014 "}
                    {w.message}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Settings path */}
        {settingsPath && (
          <div
            className="select-all overflow-auto rounded p-2 text-xs"
            style={{
              background: "var(--bg-base, #1e1e2e)",
              color: "var(--accent, #89b4fa)",
              fontFamily: "monospace",
              wordBreak: "break-all",
            }}
          >
            {settingsPath}
          </div>
        )}

        {/* Buttons */}
        <div className="flex justify-end gap-2 pt-2">
          {!settingsPath && (
            <button
              onClick={handleShowPath}
              className="rounded px-4 py-1.5 text-sm hover-bg"
              style={{
                background: "var(--bg-base, #1e1e2e)",
                color: "var(--text-primary, #cdd6f4)",
                border: "1px solid var(--border, #45475a)",
              }}
              data-testid="settings-recovery-show-path"
            >
              경로 확인
            </button>
          )}
          <button
            onClick={handleReset}
            disabled={resetting}
            className="rounded px-4 py-1.5 text-sm"
            style={{
              background: "var(--error, #f38ba8)",
              color: "var(--bg-base, #1e1e2e)",
              opacity: resetting ? 0.5 : 1,
            }}
            data-testid="settings-recovery-reset"
          >
            {resetting ? "초기화 중..." : "기본값으로 초기화"}
          </button>
          <button
            onClick={onDismiss}
            className="rounded px-4 py-1.5 text-sm"
            style={{
              background: "var(--accent, #89b4fa)",
              color: "var(--bg-base, #1e1e2e)",
            }}
            data-testid="settings-recovery-dismiss"
          >
            {isParseError ? "기본 설정으로 계속" : "확인"}
          </button>
        </div>
      </div>
    </div>
  );
}
