import { useCallback, useEffect, useMemo, useState } from "react";
import { openExternal, readFileForViewer, type FileViewerContent } from "@/lib/tauri-api";
import { fileExtension, resolveViewer } from "@/lib/file-viewer";
import { htmlToSafePreviewDocument, markdownToSafePreviewDocument } from "@/lib/file-preview";
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
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStartupStore } from "@/stores/terminal-startup-store";
import { TerminalView } from "@/components/views/TerminalView";
import { PaneLoadingPlaceholder } from "@/components/ui/PaneLoadingPlaceholder";

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
  const extensionViewers = useSettingsStore((s) => s.fileExplorer.extensionViewers);
  const profiles = useSettingsStore((s) => s.profiles);
  const terminalStartupRevealed = useTerminalStartupStore((state) =>
    state.revealedPaneIds.has(viewerInstanceId),
  );

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
        style={{ color: "var(--text-primary)", margin: 0, ...bodyStyle }}
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

  if (content.kind === "image") {
    // SVG is the one image a developer also reads as markup, so it gets the
    // same Preview/Source toggle the text previews have.
    if (isSvgPath(path)) {
      return (
        <PreviewToggleShell renderMode={renderMode} setRenderMode={setRenderMode}>
          <SvgPreview
            dataUrl={content.dataUrl}
            path={path}
            showSource={renderMode === "source"}
            bodyStyle={bodyStyle}
          />
        </PreviewToggleShell>
      );
    }
    return (
      <div className="flex items-center justify-center h-full" style={bodyStyle}>
        <img
          src={content.dataUrl}
          alt={path}
          style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
          data-testid="file-viewer-image"
        />
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
        bodyStyle={bodyStyle}
      />
    );
  }

  if (content.kind === "binary") {
    return (
      <div
        className="flex flex-col items-center justify-center h-full gap-2"
        style={{ color: "var(--text-secondary)", ...bodyStyle }}
        data-testid="file-viewer-binary"
      >
        <div>Binary file ({(content.size / 1024).toFixed(1)} KB)</div>
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
        bodyStyle={bodyStyle}
      />
    );
  }

  return <SourceText content={content} bodyStyle={bodyStyle} />;
}

interface PreviewableTextFileProps {
  path: string;
  content: Extract<FileViewerContent, { kind: "text" }>;
  previewKind: FilePreviewKind;
  renderMode: "preview" | "source";
  setRenderMode: (mode: "preview" | "source") => void;
  bodyStyle?: React.CSSProperties;
}

function PreviewableTextFile({
  path,
  content,
  previewKind,
  renderMode,
  setRenderMode,
  bodyStyle,
}: PreviewableTextFileProps) {
  return (
    <PreviewToggleShell renderMode={renderMode} setRenderMode={setRenderMode}>
      {renderMode === "preview" ? (
        <TypedPreview
          path={path}
          content={content}
          previewKind={previewKind}
          bodyStyle={bodyStyle}
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
}: {
  path: string;
  content: Extract<FileViewerContent, { kind: "text" }>;
  previewKind: FilePreviewKind;
  bodyStyle?: React.CSSProperties;
}) {
  const documentHtml = useMemo(() => {
    if (previewKind === "markdown") return markdownToSafePreviewDocument(content.content);
    if (previewKind === "html") return htmlToSafePreviewDocument(content.content);
    return null;
  }, [content.content, previewKind]);

  if (isDocumentPreviewKind(previewKind)) {
    return <PreviewFrame documentHtml={documentHtml ?? ""} bodyStyle={bodyStyle} />;
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

/** The Preview/Source header shared by every toggleable viewer. */
function PreviewToggleShell({
  renderMode,
  setRenderMode,
  children,
}: {
  renderMode: "preview" | "source";
  setRenderMode: (mode: "preview" | "source") => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex h-full min-h-0 flex-1 flex-col"
      style={{ background: "var(--bg-surface)" }}
    >
      <div
        className="flex items-center gap-1 px-2 py-1"
        style={{
          background: "var(--bg-surface)",
          borderBottom: "1px solid var(--border)",
        }}
      >
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
      </div>
      <div
        className="flex min-h-0 flex-1 overflow-auto"
        style={{ background: "var(--bg-surface)" }}
      >
        {children}
      </div>
    </div>
  );
}

function PreviewFrame({
  documentHtml,
  bodyStyle,
}: {
  documentHtml: string;
  bodyStyle?: React.CSSProperties;
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
