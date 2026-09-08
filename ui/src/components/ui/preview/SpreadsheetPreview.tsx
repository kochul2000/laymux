import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  openSpreadsheetForViewer,
  nextSpreadsheetForViewer,
  closeSpreadsheetForViewer,
  type SpreadsheetContent,
} from "@/lib/tauri-api";
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
  const pending = useRef<string | undefined>(undefined);
  const [loaded, setLoaded] = useState<{
    path: string;
    requestedSheet?: string;
    data?: SpreadsheetContent;
    error?: string;
    sessionId?: string;
    hasMore?: boolean;
  }>();
  useEffect(() => {
    let cancelled = false;
    let sessionId: string | undefined;
    openSpreadsheetForViewer(path, sheet).then(
      (window) => {
        sessionId = window.sessionId;
        if (cancelled) void closeSpreadsheetForViewer(sessionId).catch(() => {});
        else
          setLoaded({
            path,
            requestedSheet: sheet,
            sessionId,
            hasMore: window.hasMore,
            data: { ...window.content, totalRows: window.loadedRows },
          });
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
      if (sessionId) void closeSpreadsheetForViewer(sessionId).catch(() => {});
    };
  }, [path, sheet]);
  const current = loaded?.path === path && loaded.requestedSheet === sheet ? loaded : undefined;
  // Keep the selector usable after a failed sheet read.
  const names = loaded?.path === path ? loaded.data?.sheetNames : undefined;
  async function loadMore() {
    const id = current?.sessionId;
    if (!id || !current.hasMore || pending.current === id) return;
    pending.current = id;
    try {
      const window = await nextSpreadsheetForViewer(id);
      setLoaded((previous) =>
        previous?.sessionId !== id || !previous.data
          ? previous
          : {
              ...previous,
              hasMore: window.hasMore,
              data: {
                ...window.content,
                cells: [...previous.data.cells, ...window.content.cells],
                totalRows: window.loadedRows,
                totalColumns: Math.max(previous.data.totalColumns, window.content.totalColumns),
              },
            },
      );
    } catch (error) {
      setLoaded((previous) =>
        previous?.sessionId === id
          ? { ...previous, error: String(error), hasMore: false }
          : previous,
      );
    } finally {
      if (pending.current === id) pending.current = undefined;
    }
  }
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
          hasMore={current.hasMore}
          onNeedMore={() => void loadMore()}
        />
      ) : (
        <PreviewNotice tone="info">{t("spreadsheet.loading")}</PreviewNotice>
      )}
    </div>
  );
}
