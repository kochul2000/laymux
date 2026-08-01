import { useCallback } from "react";
import { openExternal } from "@/lib/tauri-api";
import { decodeDataUrlBytes } from "@/lib/preview/base64";

/**
 * PDF handed to the host WebView's own viewer.
 *
 * No PDF engine is bundled (ADR-0109). The frame is an `<iframe>`, not an
 * `<object>`: WebView2 refuses to render a PDF through `<object>` (with or
 * without `type="application/pdf"`) and falls straight to the fallback slot,
 * while the same blob in an iframe loads Chromium's full viewer. Measured on
 * Windows — do not "simplify" this back to `<object>`.
 *
 * Losing `<object>` also loses its fallback children, so the escape hatch is a
 * permanent toolbar button instead. On an engine with no PDF viewer (Linux
 * WebKitGTK) the frame stays blank and that button is the way out. Render
 * parity across platforms is explicitly not a goal.
 */
export function PdfPreview({ dataUrl, path }: { dataUrl: string; path: string }) {
  /*
   * The blob URL is created and revoked by this ref callback rather than by an
   * effect writing state. Two reasons: an effect that calls `setState` in its
   * body is banned by `react-hooks/set-state-in-effect`, and a `useMemo` would
   * run twice under StrictMode, leaking one blob per open. A ref callback and
   * its cleanup are always invoked in pairs, so exactly one URL is alive.
   *
   * A blob is needed at all because Chromium refuses to load a frame from a
   * `data:` URL, which is the form the backend sends.
   */
  const attachDocument = useCallback(
    (node: HTMLIFrameElement) => {
      const url = createPdfObjectUrl(dataUrl);
      // Leaving `src` unset shows an empty frame, which is also the right
      // outcome for a PDF whose base64 failed to decode.
      if (url) node.src = url;
      return () => {
        if (url) URL.revokeObjectURL(url);
      };
    },
    [dataUrl],
  );

  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col"
      style={{ background: "var(--bg-surface)" }}
      data-testid="pdf-preview"
    >
      <div
        className="flex items-center justify-end px-2 py-1"
        style={{
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border)",
          flex: "0 0 auto",
        }}
      >
        <button
          type="button"
          className="hover-bg-strong rounded px-2 py-1 text-xs"
          style={{
            background: "transparent",
            border: "1px solid var(--border)",
            color: "var(--text-secondary)",
            cursor: "pointer",
          }}
          onClick={() => void openExternal(path)}
          data-testid="pdf-preview-open-external"
        >
          Open in the default app
        </button>
      </div>
      <iframe
        title="PDF preview"
        ref={attachDocument}
        style={{ width: "100%", flex: "1 1 auto", minHeight: 0, border: "none" }}
        data-testid="pdf-preview-frame"
      />
    </div>
  );
}

function createPdfObjectUrl(dataUrl: string): string | null {
  const bytes = decodeDataUrlBytes(dataUrl);
  if (!bytes) return null;
  return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
}
