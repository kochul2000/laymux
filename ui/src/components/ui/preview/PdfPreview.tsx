import { useCallback } from "react";
import { openExternal } from "@/lib/tauri-api";

/**
 * PDF handed to the host WebView's own viewer.
 *
 * No PDF engine is bundled (ADR-0109): Windows' WebView2 has Chromium's viewer
 * built in, and where the engine has none — Linux WebKitGTK — the `<object>`
 * fallback slot renders instead of a blank rectangle, offering the host app.
 * Cross-platform render parity is explicitly not a goal here.
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
    (node: HTMLObjectElement) => {
      const url = createPdfObjectUrl(dataUrl);
      // Leaving `data` unset makes the element render its fallback children,
      // which is also the right outcome for a PDF that failed to decode.
      if (url) node.data = url;
      return () => {
        if (url) URL.revokeObjectURL(url);
      };
    },
    [dataUrl],
  );

  return (
    <div className="h-full min-h-0 flex-1" data-testid="pdf-preview">
      <object
        ref={attachDocument}
        type="application/pdf"
        style={{ width: "100%", height: "100%", border: "none" }}
      >
        <div
          className="flex h-full flex-col items-center justify-center gap-3 px-4 text-center"
          style={{ color: "var(--text-secondary)" }}
          data-testid="pdf-preview-fallback"
        >
          <div>This platform&rsquo;s WebView cannot display PDFs inline.</div>
          <button
            type="button"
            className="hover-bg-strong rounded px-2 py-1"
            style={{
              background: "transparent",
              border: "1px solid var(--border)",
              color: "var(--text-primary)",
              cursor: "pointer",
            }}
            onClick={() => void openExternal(path)}
          >
            Open in the default app
          </button>
        </div>
      </object>
    </div>
  );
}

function createPdfObjectUrl(dataUrl: string): string | null {
  try {
    const binary = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  } catch {
    return null;
  }
}
