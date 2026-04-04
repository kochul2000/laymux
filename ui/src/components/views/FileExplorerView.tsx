import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import {
  createTerminalSession,
  writeToTerminal,
  closeTerminalSession,
  onTerminalOutput,
  onTerminalCwdChanged,
  clipboardWriteText,
  readFileForViewer,
} from "@/lib/tauri-api";
import { convertFileSrc } from "@tauri-apps/api/core";
import { parseLsOutput, stripAnsi, type FileEntry } from "@/lib/file-explorer-parse";
import { TerminalView } from "./TerminalView";

export interface FileExplorerViewProps {
  instanceId: string;
  paneId?: string;
  profile: string;
  syncGroup: string;
  cwdReceive?: boolean;
  workspaceId?: string;
  isFocused?: boolean;
  lastCwd?: string;
}

/** Sentinel marker to detect end of ls output. */
const LS_SENTINEL = "___LXFE_END___";

type ExplorerMode =
  | { type: "listing" }
  | { type: "viewing"; filePath: string; viewerType: "web" | "terminal"; command?: string };

export function FileExplorerView({
  instanceId,
  paneId,
  profile,
  syncGroup,
  cwdReceive = true,
  isFocused,
  lastCwd,
}: FileExplorerViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const settings = useSettingsStore((s) => s.fileExplorer);

  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [currentCwd, setCurrentCwd] = useState<string>(lastCwd || "");
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<ExplorerMode>({ type: "listing" });
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [focusIndex, setFocusIndex] = useState(0);
  const [lastClickIndex, setLastClickIndex] = useState(0);
  const [viewerContent, setViewerContent] = useState<{
    kind: "text" | "image" | "binary";
    content?: string;
    imageSrc?: string;
    size?: number;
    truncated?: boolean;
  } | null>(null);

  // Track whether shell session is alive
  const shellAliveRef = useRef(false);
  const outputBufferRef = useRef("");
  const generationRef = useRef(0);
  // Pending listing refresh while in viewer mode
  const pendingRefreshRef = useRef(false);

  // --- Background shell lifecycle ---
  useEffect(() => {
    let unlistenOutput: (() => void) | null = null;
    let unlistenCwd: (() => void) | null = null;
    let disposed = false;

    async function init() {
      try {
        await createTerminalSession(instanceId, profile, 200, 50, syncGroup, cwdReceive, lastCwd);
        if (disposed) {
          await closeTerminalSession(instanceId).catch(() => {});
          return;
        }
        shellAliveRef.current = true;

        // Listen for output
        unlistenOutput = await onTerminalOutput(instanceId, (data) => {
          const text = new TextDecoder().decode(data);
          handleShellOutput(text);
        });

        // Listen for CWD changes from sync system
        unlistenCwd = await onTerminalCwdChanged((data) => {
          if (data.terminalId === instanceId) {
            setCurrentCwd(data.cwd);
            refreshListing();
          }
        });

        // Initial ls
        refreshListing();
      } catch (err) {
        console.error("FileExplorer: Failed to create shell session", err);
        setLoading(false);
      }
    }

    init();

    return () => {
      disposed = true;
      shellAliveRef.current = false;
      unlistenOutput?.();
      unlistenCwd?.();
      closeTerminalSession(instanceId).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instanceId, profile, syncGroup, cwdReceive]);

  // --- Shell output handling ---
  const handleShellOutput = useCallback(
    (text: string) => {
      outputBufferRef.current += text;
      const stripped = stripAnsi(outputBufferRef.current);
      const sentinelIdx = stripped.indexOf(LS_SENTINEL);
      if (sentinelIdx !== -1) {
        // Extract content before sentinel
        const lsOutput = stripped.substring(0, sentinelIdx);
        outputBufferRef.current = "";

        // Find the actual ls output (skip the command echo line)
        const lines = lsOutput.split("\n");
        // Skip first line (command echo) if it contains our sentinel command
        const startIdx = lines.findIndex(
          (l) => !l.includes(settings.lsCommand) && !l.includes(LS_SENTINEL),
        );
        const cleanOutput = startIdx >= 0 ? lines.slice(startIdx).join("\n") : lsOutput;

        const parsed = parseLsOutput(cleanOutput);
        setEntries(parsed);
        setLoading(false);
        setFocusIndex(0);
        setSelectedIndices(new Set());
      }
    },
    [settings.lsCommand],
  );

  // --- Refresh listing ---
  const refreshListing = useCallback(() => {
    if (!shellAliveRef.current) return;
    generationRef.current += 1;
    outputBufferRef.current = "";
    setLoading(true);
    const cmd = `${settings.lsCommand}; echo "${LS_SENTINEL}"\n`;
    writeToTerminal(instanceId, cmd).catch(console.error);
  }, [instanceId, settings.lsCommand]);

  // --- Focus management ---
  useEffect(() => {
    if (isFocused && mode.type === "listing") {
      containerRef.current?.focus();
    }
  }, [isFocused, mode.type]);

  // --- Selection helpers ---
  const selectSingle = useCallback((index: number) => {
    setSelectedIndices(new Set([index]));
    setFocusIndex(index);
    setLastClickIndex(index);
  }, []);

  const selectToggle = useCallback((index: number) => {
    setSelectedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
    setFocusIndex(index);
    setLastClickIndex(index);
  }, []);

  const selectRange = useCallback(
    (index: number) => {
      const start = Math.min(lastClickIndex, index);
      const end = Math.max(lastClickIndex, index);
      const range = new Set<number>();
      for (let i = start; i <= end; i++) range.add(i);
      setSelectedIndices(range);
      setFocusIndex(index);
    },
    [lastClickIndex],
  );

  // --- Copy paths to clipboard ---
  const copySelectedPaths = useCallback(() => {
    const paths = [...selectedIndices]
      .sort((a, b) => a - b)
      .map((i) => {
        const entry = entries[i];
        if (!entry) return "";
        const cwd = currentCwd.endsWith("/") ? currentCwd : currentCwd + "/";
        return cwd + entry.name;
      })
      .filter(Boolean)
      .join("\n");
    if (paths) clipboardWriteText(paths).catch(console.error);
  }, [selectedIndices, entries, currentCwd]);

  // --- Copy on select ---
  useEffect(() => {
    if (settings.copyOnSelect && selectedIndices.size > 0) {
      copySelectedPaths();
    }
  }, [settings.copyOnSelect, selectedIndices, copySelectedPaths]);

  // --- Navigate to directory ---
  const navigateToDir = useCallback(
    (dirName: string) => {
      if (!shellAliveRef.current) return;
      // Send cd command - the shell's OSC 7 will trigger CWD sync automatically
      writeToTerminal(instanceId, `cd ${JSON.stringify(dirName)}\n`).catch(console.error);
      // Give shell time to cd, then refresh
      setTimeout(() => refreshListing(), 150);
    },
    [instanceId, refreshListing],
  );

  // --- Open file viewer ---
  const openFile = useCallback(
    async (entry: FileEntry) => {
      const cwd = currentCwd.endsWith("/") ? currentCwd : currentCwd + "/";
      const filePath = cwd + entry.name;

      // Check extension viewers setting
      const ext = entry.name.includes(".") ? "." + entry.name.split(".").pop()!.toLowerCase() : "";
      const viewer = settings.extensionViewers.find((v) =>
        v.extensions.some((e) => e.toLowerCase() === ext),
      );

      if (viewer) {
        setMode({
          type: "viewing",
          filePath,
          viewerType: "terminal",
          command: viewer.command,
        });
        return;
      }

      // Default: web viewer
      setMode({ type: "viewing", filePath, viewerType: "web" });
      try {
        const content = await readFileForViewer(filePath);
        if (content.kind === "text") {
          setViewerContent({
            kind: "text",
            content: content.content,
            truncated: content.truncated,
          });
        } else if (content.kind === "image") {
          setViewerContent({
            kind: "image",
            imageSrc: convertFileSrc(content.path),
          });
        } else {
          setViewerContent({ kind: "binary", size: content.size });
        }
      } catch (err) {
        setViewerContent({
          kind: "text",
          content: `Error reading file: ${err}`,
        });
      }
    },
    [currentCwd, settings.extensionViewers],
  );

  // --- Handle item activation (double-click or Enter) ---
  const activateEntry = useCallback(
    (entry: FileEntry) => {
      if (entry.isDirectory) {
        navigateToDir(entry.name);
      } else {
        openFile(entry);
      }
    },
    [navigateToDir, openFile],
  );

  // --- Close viewer ---
  const closeViewer = useCallback(() => {
    setMode({ type: "listing" });
    setViewerContent(null);
    if (pendingRefreshRef.current) {
      pendingRefreshRef.current = false;
      refreshListing();
    }
  }, [refreshListing]);

  // --- Scroll focused item into view ---
  const scrollToIndex = useCallback((index: number) => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[index] as HTMLElement | undefined;
    item?.scrollIntoView({ block: "nearest" });
  }, []);

  // --- Keyboard handler ---
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (mode.type === "viewing") {
        if (e.key === "Escape") {
          e.preventDefault();
          closeViewer();
        }
        return;
      }

      const len = entries.length;
      if (!len) return;

      switch (e.key) {
        case "ArrowUp": {
          e.preventDefault();
          const next = Math.max(0, focusIndex - 1);
          if (e.shiftKey) {
            selectRange(next);
          } else {
            selectSingle(next);
          }
          setFocusIndex(next);
          scrollToIndex(next);
          break;
        }
        case "ArrowDown": {
          e.preventDefault();
          const next = Math.min(len - 1, focusIndex + 1);
          if (e.shiftKey) {
            selectRange(next);
          } else {
            selectSingle(next);
          }
          setFocusIndex(next);
          scrollToIndex(next);
          break;
        }
        case "Home": {
          e.preventDefault();
          selectSingle(0);
          scrollToIndex(0);
          break;
        }
        case "End": {
          e.preventDefault();
          selectSingle(len - 1);
          scrollToIndex(len - 1);
          break;
        }
        case "Enter": {
          e.preventDefault();
          const entry = entries[focusIndex];
          if (entry) activateEntry(entry);
          break;
        }
        case "Escape": {
          e.preventDefault();
          setSelectedIndices(new Set());
          break;
        }
        case "c": {
          if (e.ctrlKey) {
            e.preventDefault();
            copySelectedPaths();
          }
          break;
        }
      }
    },
    [
      mode.type,
      entries,
      focusIndex,
      selectSingle,
      selectRange,
      activateEntry,
      closeViewer,
      copySelectedPaths,
      scrollToIndex,
    ],
  );

  // --- Item click handler ---
  const handleItemClick = useCallback(
    (index: number, e: React.MouseEvent) => {
      if (e.ctrlKey || e.metaKey) {
        selectToggle(index);
      } else if (e.shiftKey) {
        selectRange(index);
      } else {
        selectSingle(index);
      }
    },
    [selectSingle, selectToggle, selectRange],
  );

  // --- Item double-click ---
  const handleItemDoubleClick = useCallback(
    (index: number) => {
      const entry = entries[index];
      if (entry) activateEntry(entry);
    },
    [entries, activateEntry],
  );

  // --- Right-click context menu ---
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (selectedIndices.size > 0) {
        copySelectedPaths();
      }
    },
    [selectedIndices, copySelectedPaths],
  );

  // --- Style values from settings ---
  const listStyle = useMemo(
    () => ({
      paddingTop: settings.paddingTop,
      paddingRight: settings.paddingRight,
      paddingBottom: settings.paddingBottom,
      paddingLeft: settings.paddingLeft,
      fontFamily: settings.fontFamily || "inherit",
      fontSize: settings.fontSize,
    }),
    [settings],
  );

  // ===== RENDER =====

  if (mode.type === "viewing") {
    return (
      <div
        ref={containerRef}
        data-testid="file-explorer-view"
        className="flex h-full w-full flex-col"
        tabIndex={-1}
        style={{ outline: "none" }}
        onKeyDown={handleKeyDown}
      >
        {/* Viewer title bar */}
        <div
          className="flex items-center shrink-0 px-3 border-b"
          style={{
            height: 28,
            borderColor: "var(--border)",
            background: "var(--bg-surface)",
          }}
          data-testid="file-explorer-viewer-titlebar"
        >
          <span className="flex-1 text-xs truncate" style={{ color: "var(--text-primary)" }}>
            {mode.filePath}
          </span>
          <button
            onClick={closeViewer}
            className="ml-2 px-1 text-xs hover:opacity-80"
            style={{ color: "var(--text-secondary)" }}
            data-testid="file-explorer-viewer-close"
          >
            ✕
          </button>
        </div>

        {/* Viewer content */}
        <div className="flex-1 overflow-auto" style={listStyle}>
          {mode.viewerType === "terminal" && mode.command ? (
            <div className="h-full" data-testid="file-explorer-viewer-terminal">
              <TerminalView
                instanceId={paneId ? `file-viewer-${paneId}` : `file-viewer-${instanceId}`}
                profile={profile}
                syncGroup=""
                cwdSend={false}
                cwdReceive={false}
                isFocused={isFocused}
                lastCwd={currentCwd}
                startupCommandOverride={`${mode.command} ${JSON.stringify(mode.filePath)}`}
              />
            </div>
          ) : viewerContent?.kind === "image" ? (
            <div className="flex items-center justify-center h-full">
              <img
                src={viewerContent.imageSrc}
                alt={mode.filePath}
                style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
                data-testid="file-explorer-viewer-image"
              />
            </div>
          ) : viewerContent?.kind === "text" ? (
            <pre
              className="whitespace-pre-wrap break-words"
              style={{ color: "var(--text-primary)", margin: 0 }}
              data-testid="file-explorer-viewer-text"
            >
              {viewerContent.content}
              {viewerContent.truncated && (
                <div style={{ color: "var(--text-secondary)", marginTop: 8 }}>(truncated)</div>
              )}
            </pre>
          ) : viewerContent?.kind === "binary" ? (
            <div
              className="flex flex-col items-center justify-center h-full gap-2"
              style={{ color: "var(--text-secondary)" }}
            >
              <div>Binary file ({((viewerContent.size ?? 0) / 1024).toFixed(1)} KB)</div>
            </div>
          ) : (
            <div
              className="flex items-center justify-center h-full"
              style={{ color: "var(--text-secondary)" }}
            >
              Loading...
            </div>
          )}
        </div>
      </div>
    );
  }

  // --- Listing mode ---
  return (
    <div
      ref={containerRef}
      data-testid="file-explorer-view"
      className="flex h-full w-full flex-col"
      tabIndex={-1}
      style={{ outline: "none" }}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
    >
      {/* Path bar */}
      <div
        className="flex items-center shrink-0 px-3 border-b"
        style={{
          height: 28,
          borderColor: "var(--border)",
          background: "var(--bg-surface)",
        }}
        data-testid="file-explorer-path-bar"
      >
        <span className="text-xs truncate" style={{ color: "var(--text-primary)" }}>
          {currentCwd || "..."}
        </span>
      </div>

      {/* File list */}
      <div
        ref={listRef}
        className="flex-1 overflow-auto"
        style={listStyle}
        data-testid="file-explorer-list"
      >
        {loading ? (
          <div
            className="flex items-center justify-center h-full"
            style={{ color: "var(--text-secondary)" }}
          >
            Loading...
          </div>
        ) : entries.length === 0 ? (
          <div
            className="flex items-center justify-center h-full"
            style={{ color: "var(--text-secondary)" }}
          >
            Empty directory
          </div>
        ) : (
          entries.map((entry, i) => (
            <div
              key={`${entry.name}-${i}`}
              className="flex items-center px-2 cursor-pointer select-none"
              style={{
                height: 24,
                background:
                  i === focusIndex && selectedIndices.has(i)
                    ? "var(--accent)"
                    : selectedIndices.has(i)
                      ? "color-mix(in srgb, var(--accent) 50%, transparent)"
                      : i === focusIndex
                        ? "color-mix(in srgb, var(--accent) 20%, transparent)"
                        : "transparent",
                color:
                  selectedIndices.has(i) && i === focusIndex
                    ? "var(--bg-base)"
                    : entry.isDirectory
                      ? "var(--accent)"
                      : entry.isSymlink
                        ? "var(--green)"
                        : "var(--text-primary)",
              }}
              data-testid={`file-explorer-item-${i}`}
              data-selected={selectedIndices.has(i)}
              data-focused={i === focusIndex}
              onClick={(e) => handleItemClick(i, e)}
              onDoubleClick={() => handleItemDoubleClick(i)}
            >
              <span className="truncate text-xs">
                {entry.isDirectory ? "📁 " : entry.isSymlink ? "🔗 " : "📄 "}
                {entry.rawLine}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
