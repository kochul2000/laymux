import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openExternal, readFileForViewer, type FileViewerContent } from "@/lib/tauri-api";
import { fileExtension, resolveViewer } from "@/lib/file-viewer";
import {
  htmlToSafePreviewDocument,
  markdownToSafePreviewDocument,
  type PreviewFont,
} from "@/lib/file-preview";
import {
  filePreviewKind,
  isDocumentPreviewKind,
  isSvgPath,
  type FilePreviewKind,
} from "@/lib/file-preview-kind";
import { previewLanguage } from "@/lib/preview/code-highlight";
import { ArchivePreview } from "@/components/ui/preview/ArchivePreview";
import { CodePreview } from "@/components/ui/preview/CodePreview";
import { CsvPreview } from "@/components/ui/preview/CsvPreview";
import { DiffPreview } from "@/components/ui/preview/DiffPreview";
import { JsonPreview } from "@/components/ui/preview/JsonPreview";
import { JsonlPreview } from "@/components/ui/preview/JsonlPreview";
import { LogPreview } from "@/components/ui/preview/LogPreview";
import { PdfPreview } from "@/components/ui/preview/PdfPreview";
import { PreviewNotice } from "@/components/ui/preview/PreviewNotice";
import { SvgPreview } from "@/components/ui/preview/SvgPreview";
import { ZoomableImage } from "@/components/ui/preview/ZoomableImage";
import { imageZoomAlignment } from "@/lib/image-zoom";
import { useSettingsStore } from "@/stores/settings-store";
import {
  useOverridesStore,
  FONT_ZOOM_MIN,
  FONT_ZOOM_MAX,
  IMAGE_ZOOM_MIN,
  IMAGE_ZOOM_MAX,
  IMAGE_ZOOM_STEP,
} from "@/stores/overrides-store";
import { useTerminalStartupStore } from "@/stores/terminal-startup-store";
import { TerminalView } from "@/components/views/TerminalView";
import { PaneLoadingPlaceholder } from "@/components/ui/PaneLoadingPlaceholder";
import { OsHandoffActions } from "@/components/ui/OsHandoffActions";
import { ZoomInIcon, ZoomOutIcon } from "@/components/ui/icons";

/**
 * Shared file-viewer body. The single rendering mechanism behind every entry
 * point (#277 / #279): File Explorer's inline viewer, the global "open anywhere"
 * shortcut, and the MCP `open_file_viewer` tool. Given a file `path`, it
 * classifies the file (text / image / binary) via the Rust `read_file_for_viewer`
 * command, or—when an extension viewer is configured—spawns a `TerminalView`
 * running the configured command. Hosts supply the surrounding chrome (titlebar,
 * close button, overlay vs. pane).
 */
export interface FileViewerProps {
  /** Absolute path of the file to display (already normalized). */
  path: string;
  /** Stable id used for the spawned viewer terminal (web viewers ignore it). */
  viewerInstanceId: string;
  /** Whether this viewer is currently focused (forwarded to TerminalView). */
  isFocused?: boolean;
  /** Inline style for the scrollable body (padding / font from settings). */
  bodyStyle?: React.CSSProperties;
}

export function FileViewer({ path, viewerInstanceId, isFocused, bodyStyle }: FileViewerProps) {
  const { t } = useTranslation("common");
  const extensionViewers = useSettingsStore((s) => s.fileExplorer.extensionViewers);
  const profiles = useSettingsStore((s) => s.profiles);
  const viewerSettings = useSettingsStore((s) => s.viewer);
  const appFont = useSettingsStore((s) => s.appearance.font);
  const terminalStartupRevealed = useTerminalStartupStore((state) =>
    state.revealedPaneIds.has(viewerInstanceId),
  );

  // Per-instance font zoom (Ctrl+Wheel / toolbar buttons), layered over the
  // `viewer` settings default — mirrors TerminalView/MemoView's overrides-store
  // pattern so a transient zoom never pollutes settings.json.
  const baseFontSize = viewerSettings.fontSize || appFont.size;
  const overrideFontSize = useOverridesStore((s) => s.viewOverrides[viewerInstanceId]?.fontSize);
  const effectiveFontSize = overrideFontSize ?? baseFontSize;
  const effectiveFontFamily = viewerSettings.fontFamily || appFont.face;

  // Per-instance image zoom (Ctrl+Wheel / toolbar buttons). Purely transient
  // display state — there is no "default zoom" setting for a picture.
  const overrideImageZoom = useOverridesStore((s) => s.viewOverrides[viewerInstanceId]?.imageZoom);
  const imageZoom = overrideImageZoom ?? 100;

  const adjustFontZoom = useCallback(
    (delta: number) => {
      const overrides = useOverridesStore.getState();
      const current = overrides.viewOverrides[viewerInstanceId]?.fontSize ?? baseFontSize;
      const next = Math.max(FONT_ZOOM_MIN, Math.min(FONT_ZOOM_MAX, current + delta));
      if (next !== current) overrides.setViewOverride(viewerInstanceId, { fontSize: next });
    },
    [viewerInstanceId, baseFontSize],
  );

  const adjustImageZoom = useCallback(
    (delta: number) => {
      const overrides = useOverridesStore.getState();
      const current = overrides.viewOverrides[viewerInstanceId]?.imageZoom ?? 100;
      const next = Math.max(IMAGE_ZOOM_MIN, Math.min(IMAGE_ZOOM_MAX, current + delta));
      if (next !== current) overrides.setViewOverride(viewerInstanceId, { imageZoom: next });
    },
    [viewerInstanceId],
  );

  // Ctrl+Wheel zooms font size for text content; browsers otherwise treat
  // Ctrl+Wheel as page zoom, so this must preventDefault when it fires.
  const handleFontWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      adjustFontZoom(e.deltaY < 0 ? 1 : -1);
    },
    [adjustFontZoom],
  );

  const handleImageWheel = useCallback(
    (e: React.WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      adjustImageZoom(e.deltaY < 0 ? IMAGE_ZOOM_STEP : -IMAGE_ZOOM_STEP);
    },
    [adjustImageZoom],
  );

  const effectiveBodyStyle: React.CSSProperties = {
    ...bodyStyle,
    fontFamily: effectiveFontFamily || "inherit",
    fontSize: effectiveFontSize,
  };

  const resolution = resolveViewer(path, extensionViewers);
  const previewKind = filePreviewKind(path);
  // Keyed on the path alone: `previewKind` is derived from it, so it cannot
  // change without the path changing.
  const [renderModeState, setRenderModeState] = useState<{
    path: string;
    mode: "preview" | "source";
  }>({ path, mode: "preview" });

  // A single result object tagged with the path it belongs to. We never reset
  // state synchronously inside the effect (which would be a render-time
  // setState); instead, while `loaded.path !== path` we render "Loading…", so a
  // path change automatically shows the loading state until the new result
  // lands. This keeps the effect free of synchronous setState calls.
  const [loaded, setLoaded] = useState<{
    path: string;
    content?: FileViewerContent;
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (resolution.viewerType !== "web") return;
    let cancelled = false;
    readFileForViewer(path)
      .then((c) => {
        if (!cancelled) setLoaded({ path, content: c });
      })
      .catch((e) => {
        if (!cancelled) setLoaded({ path, error: `Error reading file: ${e}` });
      });
    return () => {
      cancelled = true;
    };
  }, [path, resolution.viewerType]);

  const current = loaded && loaded.path === path ? loaded : null;
  const content = current?.content ?? null;
  const error = current?.error ?? null;
  const renderMode = renderModeState.path === path ? renderModeState.mode : "preview";
  const setRenderMode = useCallback(
    (mode: "preview" | "source") => setRenderModeState({ path, mode }),
    [path],
  );

  // Scope Ctrl+A to this viewer's own content instead of the browser default
  // (select the whole laymux document). Only the "web" render path below owns
  // this — a terminal-backed viewer (xterm) already handles its own Ctrl+A.
  const contentRootRef = useRef<HTMLDivElement>(null);
  const handleSelectAllKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
    if (e.key.toLowerCase() !== "a") return;
    const el = contentRootRef.current?.querySelector<HTMLElement>("[data-file-viewer-body]");
    const selection = window.getSelection();
    if (!el || !selection) return;
    e.preventDefault();
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
  }, []);
  // The host blurs its address bar once a file loads so the keyboard passes
  // to the viewer (see FileViewerOverlay's submitPath) — claim it here so
  // Ctrl+A (and other keys) land on this container instead of <body>.
  useEffect(() => {
    if (isFocused && content) contentRootRef.current?.focus();
  }, [isFocused, content]);

  if (resolution.viewerType === "terminal") {
    if (!profiles.some((candidate) => candidate.name === resolution.profile)) {
      return (
        <div
          className="flex h-full items-center justify-center px-4 text-center"
          style={{ color: "var(--red)" }}
          data-testid="file-viewer-error"
        >
          {`Terminal profile "${resolution.profile}" does not exist.`}
        </div>
      );
    }
    if (!terminalStartupRevealed) {
      return (
        <div className="h-full min-w-0 flex-1" data-testid="file-viewer-terminal">
          <PaneLoadingPlaceholder data-testid="file-viewer-terminal-startup-placeholder" />
        </div>
      );
    }
    return (
      <div className="h-full min-w-0 flex-1" data-testid="file-viewer-terminal">
        <TerminalView
          instanceId={viewerInstanceId}
          paneId={viewerInstanceId}
          profile={resolution.profile}
          syncGroup=""
          cwdSend={false}
          cwdReceive={false}
          isFocused={isFocused}
          viewerStartup={{ command: resolution.command, path }}
        />
      </div>
    );
  }

  if (resolution.viewerType === "error") {
    return (
      <div
        className="flex h-full items-center justify-center px-4 text-center"
        style={{ color: "var(--red)" }}
        data-testid="file-viewer-error"
      >
        {resolution.message}
      </div>
    );
  }

  if (error) {
    return (
      <pre
        className="whitespace-pre-wrap break-words"
        style={{ color: "var(--text-primary)", margin: 0, ...effectiveBodyStyle }}
        data-testid="file-viewer-text"
      >
        {error}
      </pre>
    );
  }

  if (!content) {
    return (
      <div
        className="flex items-center justify-center h-full"
        style={{ color: "var(--text-secondary)" }}
        data-testid="file-viewer-loading"
      >
        Loading...
      </div>
    );
  }

  return (
    <div
      ref={contentRootRef}
      tabIndex={-1}
      className="flex h-full min-h-0 w-full flex-1 flex-col outline-none"
      onKeyDown={handleSelectAllKeyDown}
      data-testid="file-viewer-content-root"
    >
      {renderLoadedContent(content)}
    </div>
  );

  function renderLoadedContent(content: FileViewerContent): React.ReactNode {
    if (content.kind === "image") {
      // SVG is the one image a developer also reads as markup, so it gets the
      // same Preview/Source toggle the text previews have.
      if (isSvgPath(path)) {
        return (
          <PreviewToggleShell
            renderMode={renderMode}
            setRenderMode={setRenderMode}
            onWheel={renderMode === "source" ? handleFontWheel : handleImageWheel}
            rightControls={
              renderMode === "source" ? (
                <FontZoomControls onZoom={adjustFontZoom} fontSize={effectiveFontSize} />
              ) : (
                <ImageZoomControls zoom={imageZoom} onZoom={adjustImageZoom} />
              )
            }
          >
            <SvgPreview
              dataUrl={content.dataUrl}
              path={path}
              showSource={renderMode === "source"}
              bodyStyle={effectiveBodyStyle}
              zoom={renderMode === "preview" ? imageZoom : undefined}
            />
          </PreviewToggleShell>
        );
      }
      return (
        <div
          className="flex h-full min-h-0 flex-1 flex-col"
          style={{ background: "var(--bg-surface)" }}
        >
          <ToolbarBar>
            <div className="ml-auto flex items-center gap-1">
              <ImageZoomControls zoom={imageZoom} onZoom={adjustImageZoom} />
            </div>
          </ToolbarBar>
          <div
            className="empty-view-scroll flex min-h-0 flex-1 overflow-auto"
            style={{
              ...bodyStyle,
              alignItems: imageZoomAlignment(imageZoom),
              justifyContent: imageZoomAlignment(imageZoom),
            }}
            onWheel={handleImageWheel}
            data-file-viewer-body
          >
            <ZoomableImage
              src={content.dataUrl}
              alt={path}
              zoom={imageZoom}
              testId="file-viewer-image"
            />
          </div>
        </div>
      );
    }

    if (content.kind === "pdf") {
      return <PdfPreview dataUrl={content.dataUrl} path={path} />;
    }

    if (content.kind === "archive") {
      return (
        <ArchivePreview
          format={content.format}
          entries={content.entries}
          totalEntries={content.totalEntries}
          totalBytes={content.totalBytes}
          truncated={content.truncated}
          bodyStyle={effectiveBodyStyle}
        />
      );
    }

    if (content.kind === "binary") {
      // ADR-0193: 미리보기가 없는 바로 그 자리에서 다음 행동을 제시한다. 헤더에
      // 같은 버튼이 있지만, 빈 화면만 보고 "지원 안 되는 파일"로 끝내는 사용자가
      // 그 글리프까지 찾아가지는 않는다.
      return (
        <div
          className="flex flex-col items-center justify-center h-full gap-2"
          style={{ color: "var(--text-secondary)", ...effectiveBodyStyle }}
          data-testid="file-viewer-binary"
          data-file-viewer-body
        >
          <div>{t("viewer.binaryFile", { size: (content.size / 1024).toFixed(1) })}</div>
          <div className="text-center text-xs">{t("osHandoff.noPreviewPrompt")}</div>
          <OsHandoffActions path={path} variant="cta" testIdPrefix="file-viewer-binary-os" />
        </div>
      );
    }

    if (previewKind) {
      return (
        <PreviewableTextFile
          path={path}
          content={content}
          previewKind={previewKind}
          renderMode={renderMode}
          setRenderMode={setRenderMode}
          bodyStyle={effectiveBodyStyle}
          onWheel={handleFontWheel}
          rightControls={<FontZoomControls onZoom={adjustFontZoom} fontSize={effectiveFontSize} />}
          font={{ family: effectiveFontFamily, size: effectiveFontSize }}
          onFontZoom={adjustFontZoom}
        />
      );
    }

    return (
      <PreviewToggleShell
        renderMode="source"
        setRenderMode={() => {}}
        showModeToggle={false}
        onWheel={handleFontWheel}
        rightControls={<FontZoomControls onZoom={adjustFontZoom} fontSize={effectiveFontSize} />}
      >
        <SourceText content={content} bodyStyle={effectiveBodyStyle} />
      </PreviewToggleShell>
    );
  }
}

interface PreviewableTextFileProps {
  path: string;
  content: Extract<FileViewerContent, { kind: "text" }>;
  previewKind: FilePreviewKind;
  renderMode: "preview" | "source";
  setRenderMode: (mode: "preview" | "source") => void;
  bodyStyle?: React.CSSProperties;
  onWheel?: (e: React.WheelEvent) => void;
  rightControls?: React.ReactNode;
  /** Baked into the html/markdown preview iframe's own `<style>` — it is a
   *  separate document and never inherits `bodyStyle`'s font. */
  font: PreviewFont;
  /** Ctrl+Wheel inside the preview iframe (a separate document — it never
   *  bubbles to this component's own onWheel) forwards here. */
  onFontZoom?: (delta: number) => void;
}

function PreviewableTextFile({
  path,
  content,
  previewKind,
  renderMode,
  setRenderMode,
  bodyStyle,
  onWheel,
  rightControls,
  font,
  onFontZoom,
}: PreviewableTextFileProps) {
  return (
    <PreviewToggleShell
      renderMode={renderMode}
      setRenderMode={setRenderMode}
      onWheel={onWheel}
      rightControls={rightControls}
    >
      {renderMode === "preview" ? (
        <TypedPreview
          path={path}
          content={content}
          previewKind={previewKind}
          bodyStyle={bodyStyle}
          font={font}
          onFontZoom={onFontZoom}
        />
      ) : (
        <SourceText content={content} bodyStyle={bodyStyle} />
      )}
    </PreviewToggleShell>
  );
}

/**
 * Route one text file to its renderer.
 *
 * The two families split here and the split is a trust boundary (ADR-0109):
 * `isDocumentPreviewKind` sends html/markdown through the sanitizer and the
 * sandboxed iframe, and every other kind is drawn from parsed values as React
 * DOM with no HTML string in between.
 */
function TypedPreview({
  path,
  content,
  previewKind,
  bodyStyle,
  font,
  onFontZoom,
}: {
  path: string;
  content: Extract<FileViewerContent, { kind: "text" }>;
  previewKind: FilePreviewKind;
  bodyStyle?: React.CSSProperties;
  font: PreviewFont;
  onFontZoom?: (delta: number) => void;
}) {
  const documentHtml = useMemo(() => {
    if (previewKind === "markdown") return markdownToSafePreviewDocument(content.content, font);
    if (previewKind === "html") return htmlToSafePreviewDocument(content.content, font);
    return null;
  }, [content.content, previewKind, font]);

  if (isDocumentPreviewKind(previewKind)) {
    return (
      <PreviewFrame
        documentHtml={documentHtml ?? ""}
        bodyStyle={bodyStyle}
        onFontZoom={onFontZoom}
      />
    );
  }

  // A structured renderer that is handed a truncated file parses a fragment and
  // has no way to know it. Without this banner a cut-off CSV looks complete and
  // a cut-off JSON reports a syntax error the file does not actually have — the
  // renderers' own caps only cover what *they* dropped, never the backend read
  // limit. Silent truncation is exactly what ADR-0109 forbids.
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      {content.truncated && (
        <PreviewNotice testId="file-viewer-source-truncated">
          This file is larger than the viewer&rsquo;s read limit, so only the beginning was loaded.
          Anything below is parsed from that fragment.
        </PreviewNotice>
      )}
      <StructuredPreview
        path={path}
        content={content}
        previewKind={previewKind}
        bodyStyle={bodyStyle}
      />
    </div>
  );
}

/** The React-rendered half of the split; never builds an HTML string. */
function StructuredPreview({
  path,
  content,
  previewKind,
  bodyStyle,
}: {
  path: string;
  content: Extract<FileViewerContent, { kind: "text" }>;
  previewKind: Exclude<FilePreviewKind, "html" | "markdown">;
  bodyStyle?: React.CSSProperties;
}) {
  switch (previewKind) {
    case "json":
      return (
        <JsonPreview
          content={content.content}
          allowComments={fileExtension(path) !== ".json"}
          sourceTruncated={content.truncated}
          bodyStyle={bodyStyle}
        />
      );
    case "jsonl":
      return <JsonlPreview content={content.content} bodyStyle={bodyStyle} />;
    case "diff":
      return <DiffPreview content={content.content} bodyStyle={bodyStyle} />;
    case "csv":
      return <CsvPreview content={content.content} path={path} bodyStyle={bodyStyle} />;
    case "log":
      return <LogPreview content={content.content} bodyStyle={bodyStyle} />;
    case "code":
      return (
        <CodePreview
          content={content.content}
          language={previewLanguage(path) ?? "text"}
          bodyStyle={bodyStyle}
        />
      );
  }
}

/** The header row shared by every viewer toolbar (mode toggle, zoom controls). */
function ToolbarBar({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-center gap-1 px-2 py-1"
      style={{
        background: "var(--bg-surface)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      {children}
    </div>
  );
}

/** The Preview/Source header (+ optional zoom controls) shared by every toggleable viewer. */
function PreviewToggleShell({
  renderMode,
  setRenderMode,
  children,
  showModeToggle = true,
  rightControls,
  onWheel,
}: {
  renderMode: "preview" | "source";
  setRenderMode: (mode: "preview" | "source") => void;
  children: React.ReactNode;
  /** Hide the Preview/Source buttons for content with only one render mode. */
  showModeToggle?: boolean;
  rightControls?: React.ReactNode;
  onWheel?: (e: React.WheelEvent) => void;
}) {
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col"
      style={{ background: "var(--bg-surface)" }}
    >
      <ToolbarBar>
        {showModeToggle && (
          <>
            <button
              type="button"
              className="hover-bg-strong rounded px-2 py-1 text-xs"
              style={{
                background: renderMode === "preview" ? "var(--accent-20)" : "transparent",
                color: renderMode === "preview" ? "var(--text-primary)" : "var(--text-secondary)",
                border: "1px solid var(--border)",
                cursor: "pointer",
              }}
              onClick={() => setRenderMode("preview")}
              data-testid="file-viewer-preview-mode"
            >
              Preview
            </button>
            <button
              type="button"
              className="hover-bg-strong rounded px-2 py-1 text-xs"
              style={{
                background: renderMode === "source" ? "var(--accent-20)" : "transparent",
                color: renderMode === "source" ? "var(--text-primary)" : "var(--text-secondary)",
                border: "1px solid var(--border)",
                cursor: "pointer",
              }}
              onClick={() => setRenderMode("source")}
              data-testid="file-viewer-source-mode"
            >
              Source
            </button>
          </>
        )}
        {rightControls && <div className="ml-auto flex items-center gap-1">{rightControls}</div>}
      </ToolbarBar>
      <div
        className="empty-view-scroll flex min-h-0 flex-1 overflow-auto"
        style={{ background: "var(--bg-surface)" }}
        onWheel={onWheel}
        data-file-viewer-body
        data-testid="file-viewer-selectable-content"
      >
        {children}
      </div>
    </div>
  );
}

const zoomButtonStyle: React.CSSProperties = {
  color: "var(--text-secondary)",
  border: "1px solid var(--border)",
  cursor: "pointer",
};

/** Font size +/- for text content — mirrors the Ctrl+Wheel gesture over the same view. */
function FontZoomControls({
  onZoom,
  fontSize,
}: {
  onZoom: (delta: number) => void;
  fontSize: number;
}) {
  return (
    <>
      <button
        type="button"
        onClick={() => onZoom(-1)}
        disabled={fontSize <= FONT_ZOOM_MIN}
        title="Decrease font size (Ctrl+Scroll)"
        data-testid="file-viewer-font-decrease"
        className="hover-bg-strong rounded px-1.5 py-1 text-xs"
        style={zoomButtonStyle}
      >
        A−
      </button>
      <button
        type="button"
        onClick={() => onZoom(1)}
        disabled={fontSize >= FONT_ZOOM_MAX}
        title="Increase font size (Ctrl+Scroll)"
        data-testid="file-viewer-font-increase"
        className="hover-bg-strong rounded px-1.5 py-1 text-xs"
        style={zoomButtonStyle}
      >
        A+
      </button>
    </>
  );
}

/** Zoom in/out for image content — mirrors the Ctrl+Wheel gesture over the same view. */
function ImageZoomControls({ zoom, onZoom }: { zoom: number; onZoom: (delta: number) => void }) {
  return (
    <>
      <button
        type="button"
        onClick={() => onZoom(-IMAGE_ZOOM_STEP)}
        disabled={zoom <= IMAGE_ZOOM_MIN}
        title="Zoom out (Ctrl+Scroll)"
        data-testid="file-viewer-zoom-out"
        className="hover-bg-strong rounded px-1.5 py-1 text-xs"
        style={zoomButtonStyle}
      >
        <ZoomOutIcon />
      </button>
      <span
        className="px-1 text-xs"
        style={{ color: "var(--text-secondary)" }}
        data-testid="file-viewer-zoom-level"
      >
        {zoom}%
      </span>
      <button
        type="button"
        onClick={() => onZoom(IMAGE_ZOOM_STEP)}
        disabled={zoom >= IMAGE_ZOOM_MAX}
        title="Zoom in (Ctrl+Scroll)"
        data-testid="file-viewer-zoom-in"
        className="hover-bg-strong rounded px-1.5 py-1 text-xs"
        style={zoomButtonStyle}
      >
        <ZoomInIcon />
      </button>
    </>
  );
}

function PreviewFrame({
  documentHtml,
  bodyStyle,
  onFontZoom,
}: {
  documentHtml: string;
  bodyStyle?: React.CSSProperties;
  /** Ctrl+Wheel over the iframe's own document — it never bubbles to the
   *  parent's onWheel, so it must be forwarded from inside `doc` directly. */
  onFontZoom?: (delta: number) => void;
}) {
  const handleLoad = (event: React.SyntheticEvent<HTMLIFrameElement>) => {
    const doc = event.currentTarget.contentDocument;
    if (!doc) return;
    doc.addEventListener("click", (clickEvent) => {
      const view = doc.defaultView;
      if (!view) return;
      const target = clickEvent.target;
      if (!(target instanceof view.Element)) return;
      const link = target.closest("a[href]");
      if (!(link instanceof view.HTMLAnchorElement)) return;
      const href = link.getAttribute("href") ?? "";
      if (href.startsWith("#")) return;
      clickEvent.preventDefault();
      void openExternal(link.href || href);
    });
    doc.addEventListener(
      "wheel",
      (wheelEvent) => {
        if (!wheelEvent.ctrlKey || !onFontZoom) return;
        wheelEvent.preventDefault();
        onFontZoom(wheelEvent.deltaY < 0 ? 1 : -1);
      },
      { passive: false },
    );
  };

  return (
    <div
      className="relative flex min-h-0 flex-1"
      style={{ background: "var(--bg-surface)", ...bodyStyle }}
    >
      <div
        aria-hidden="true"
        className="absolute inset-0"
        style={{ background: "var(--bg-surface)" }}
      />
      <iframe
        title="File preview"
        sandbox="allow-same-origin"
        srcDoc={documentHtml}
        className="relative z-10 min-h-0 flex-1 w-full"
        style={{ height: "100%", border: "none", background: "var(--bg-surface)" }}
        onLoad={handleLoad}
        data-testid="file-viewer-preview"
      />
    </div>
  );
}

function SourceText({
  content,
  bodyStyle,
}: {
  content: Extract<FileViewerContent, { kind: "text" }>;
  bodyStyle?: React.CSSProperties;
}) {
  return (
    <pre
      className="whitespace-pre-wrap break-words"
      style={{ color: "var(--text-primary)", margin: 0, ...bodyStyle }}
      data-testid="file-viewer-text"
    >
      {content.content}
      {content.truncated && (
        <div style={{ color: "var(--text-secondary)", marginTop: 8 }}>(truncated)</div>
      )}
    </pre>
  );
}
