import { useEffect, useState } from "react";
import { readFileForViewer, type FileViewerContent } from "@/lib/tauri-api";
import { resolveViewer, resolveViewerProfile } from "@/lib/file-viewer";
import { shellEscape, parentPath } from "@/lib/file-explorer-parse";
import { useSettingsStore } from "@/stores/settings-store";
import { TerminalView } from "@/components/views/TerminalView";

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
  /** Terminal profile to use when rendering via an external command viewer. */
  profile: string;
  /** Stable id used for the spawned viewer terminal (web viewers ignore it). */
  viewerInstanceId: string;
  /** Whether this viewer is currently focused (forwarded to TerminalView). */
  isFocused?: boolean;
  /** Inline style for the scrollable body (padding / font from settings). */
  bodyStyle?: React.CSSProperties;
}

export function FileViewer({
  path,
  profile,
  viewerInstanceId,
  isFocused,
  bodyStyle,
}: FileViewerProps) {
  const extensionViewers = useSettingsStore((s) => s.fileExplorer.extensionViewers);
  const profiles = useSettingsStore((s) => s.profiles);

  const resolution = resolveViewer(path, extensionViewers);

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

  if (resolution.viewerType === "terminal") {
    const viewerProfile = resolveViewerProfile(path, profile, profiles);
    return (
      <div className="h-full" data-testid="file-viewer-terminal">
        <TerminalView
          instanceId={viewerInstanceId}
          profile={viewerProfile}
          syncGroup=""
          cwdSend={false}
          cwdReceive={false}
          isFocused={isFocused}
          lastCwd={parentPath(path)}
          startupCommandOverride={`${resolution.command} ${shellEscape(path)}`}
        />
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
