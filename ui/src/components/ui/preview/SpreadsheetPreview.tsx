import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { readSpreadsheetForViewer, type SpreadsheetContent } from "@/lib/tauri-api";
import { PreviewNotice } from "./PreviewNotice";
import { SpreadsheetTable } from "./SpreadsheetTable";
import { toolbarStyle, inputStyle } from "./spreadsheet-styles";

export function SpreadsheetPreview({
  path,
  bodyStyle,
}: {
  path: string;
  bodyStyle?: React.CSSProperties;
}) {
  const { t } = useTranslation("common");
  const [sheet, setSheet] = useState<string>();
  const [loaded, setLoaded] = useState<{
    path: string;
    requestedSheet?: string;
    data?: SpreadsheetContent;
    error?: string;
  }>();
  useEffect(() => {
    let cancelled = false;
    readSpreadsheetForViewer(path, sheet).then(
      (data) => {
        if (!cancelled) setLoaded({ path, requestedSheet: sheet, data });
      },
      (error) => {
        if (!cancelled)
          setLoaded((previous) => ({
            path,
            requestedSheet: sheet,
            error: String(error),
            data: previous?.path === path ? previous.data : undefined,
          }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [path, sheet]);
  const current = loaded?.path === path && loaded.requestedSheet === sheet ? loaded : undefined;
  // Keep the selector usable after a failed sheet read.
  const names = loaded?.path === path ? loaded.data?.sheetNames : undefined;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col" data-testid="spreadsheet-preview">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2" style={toolbarStyle}>
        <label className="flex items-center gap-2">
          {t("spreadsheet.sheet")}
          <select
            aria-label={t("spreadsheet.sheet")}
            data-testid="spreadsheet-sheet"
            value={sheet ?? current?.data?.sheet ?? ""}
            onChange={(event) => setSheet(event.target.value)}
            style={{ ...inputStyle, maxWidth: "30ch" }}
          >
            {(names ?? (sheet ? [sheet] : [])).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <span style={{ color: "var(--text-muted)" }}>{t("spreadsheet.readOnly")}</span>
      </div>
      {current?.error ? (
        <PreviewNotice tone="error" testId="spreadsheet-error">
          {current.error}
        </PreviewNotice>
      ) : current?.data ? (
        <SpreadsheetTable
          key={path + "\u0000" + current.data.sheet}
          data={current.data}
          bodyStyle={bodyStyle}
        />
      ) : (
        <PreviewNotice tone="info">{t("spreadsheet.loading")}</PreviewNotice>
      )}
    </div>
  );
}
