import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  resetSettings,
  acknowledgeSettingsRecovery,
  loadSettingsValidated,
  getSettingsPath,
  type Settings,
  type SettingsLoadResult,
  type ValidationWarning,
} from "@/lib/tauri-api";
import { setBlockPersist } from "@/lib/persist-session";

interface SettingsRecoveryModalProps {
  loadResult: SettingsLoadResult;
  onDismiss: (acknowledgedSettings?: Settings) => void;
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
  const { t } = useTranslation("settings");
  const [currentLoadResult, setCurrentLoadResult] = useState(loadResult);
  const [settingsPath, setSettingsPath] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [acknowledging, setAcknowledging] = useState(false);

  const isParseError = currentLoadResult.status === "parse_error";
  const isRecovered = currentLoadResult.status === "recovered";
  /** Values the user wrote and lost. Only these count as "removed". */
  const dropped: ValidationWarning[] = isRecovered ? currentLoadResult.dropped : [];
  /** Structures the loader fixed up — reported, but not a loss. */
  const repairs: ValidationWarning[] = isParseError ? [] : currentLoadResult.warnings;
  const warnings: ValidationWarning[] = [...dropped, ...repairs];
  const parseError = isParseError ? currentLoadResult.error : null;
  const settingsPathFromResult =
    isParseError || isRecovered ? currentLoadResult.settingsPath : null;

  const handleShowPath = async () => {
    try {
      const path = settingsPathFromResult || (await getSettingsPath());
      setSettingsPath(path);
    } catch {
      setSettingsPath(t("recovery.pathUnavailable"));
    }
  };

  const handleReset = async () => {
    setResetting(true);
    // Block persistence so any in-flight persistSession() doesn't overwrite the fresh defaults
    setBlockPersist(true);
    try {
      await resetSettings();
      onReset();
    } catch (err) {
      console.error("[SettingsRecoveryModal] Reset failed:", err);
      setBlockPersist(false);
      setResetting(false);
    }
  };

  const handleDismiss = async () => {
    if (!isRecovered) {
      onDismiss();
      return;
    }
    setAcknowledging(true);
    try {
      const acknowledgedSettings = await acknowledgeSettingsRecovery(
        currentLoadResult.recoveryRevision,
      );
      onDismiss(acknowledgedSettings);
    } catch (error) {
      console.error("[SettingsRecoveryModal] Recovery acknowledgement failed:", error);
      // A manual edit may have changed which typed values would be dropped.
      // Reload that protected document and show the new loss list; the user
      // must explicitly acknowledge this exact revision before any write.
      try {
        const latest = await loadSettingsValidated();
        if (latest.status === "ok" || latest.status === "repaired") {
          onDismiss(latest.settings);
          return;
        }
        setCurrentLoadResult(latest);
      } catch (reloadError) {
        console.error("[SettingsRecoveryModal] Recovery reload failed:", reloadError);
      }
      setAcknowledging(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: "#00000099" }}
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
            {isParseError || isRecovered ? "\u26A0" : "\u2139"}
          </span>
          <span>
            {isParseError
              ? t("recovery.parseErrorTitle")
              : isRecovered
                ? t("recovery.recoveredTitle")
                : t("recovery.validationTitle")}
          </span>
        </div>

        {/* Recovered: values were dropped and writes are held back until confirm */}
        {isRecovered && (
          <div className="flex flex-col gap-1" style={{ color: "var(--text-secondary, #a6adc8)" }}>
            <div>{t("recovery.recoveredDescription")}</div>
            <div>{t("recovery.recoveredWriteBlocked")}</div>
          </div>
        )}

        {/* Parse error details */}
        {isParseError && parseError && (
          <div className="flex flex-col gap-2">
            <div style={{ color: "var(--text-secondary, #a6adc8)" }}>
              {t("recovery.parseErrorDescription")}
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
              {isRecovered && t("recovery.droppedCount", { num: dropped.length })}
              {repairs.filter((w) => w.repaired).length > 0 &&
                t("recovery.repairedCount", {
                  num: repairs.filter((w) => w.repaired).length,
                })}
              {repairs.filter((w) => !w.repaired).length > 0 &&
                t("recovery.manualCount", { num: repairs.filter((w) => !w.repaired).length })}
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
              {t("recovery.showPath")}
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
            {resetting ? t("recovery.resetting") : t("recovery.resetToDefault")}
          </button>
          <button
            onClick={handleDismiss}
            disabled={acknowledging}
            className="rounded px-4 py-1.5 text-sm"
            style={{
              background: "var(--accent, #89b4fa)",
              color: "var(--bg-base, #1e1e2e)",
              opacity: acknowledging ? 0.5 : 1,
            }}
            data-testid="settings-recovery-dismiss"
          >
            {isParseError
              ? t("recovery.continueWithDefaults")
              : isRecovered
                ? t("recovery.recoveredConfirm")
                : t("recovery.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
