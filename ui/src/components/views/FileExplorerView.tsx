import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import {
  clipboardWriteText,
  readFileForViewer,
  listDirectory,
  onTerminalCwdChanged,
  handleLxMessage,
  type DirEntry,
} from "@/lib/tauri-api";
// convertFileSrc no longer needed — images are returned as data URLs
import { shellEscape, joinPath, parentPath } from "@/lib/file-explorer-parse";
import { TerminalView } from "./TerminalView";

export interface FileExplorerViewProps {
  instanceId: string;
  paneId?: string;
  profile: string;
  syncGroup: string;
  cwdSend?: boolean;
  cwdReceive?: boolean;
  workspaceId?: string;
  isFocused?: boolean;
  lastCwd?: string;
}

type ExplorerMode =
  | { type: "listing" }
  | { type: "viewing"; filePath: string; viewerType: "web" | "terminal"; command?: string };

export function FileExplorerView({
  instanceId,
  paneId,
  profile,
  syncGroup,
  cwdSend = true,
  cwdReceive = true,
  isFocused,
  lastCwd,
}: FileExplorerViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const settings = useSettingsStore((s) => s.fileExplorer);

  const [entries, setEntries] = useState<DirEntry[]>([]);
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

  // --- History stack for back/forward navigation ---
  const [history, setHistory] = useState<string[]>(lastCwd ? [lastCwd] : []);
  const [historyIndex, setHistoryIndex] = useState(0);
  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  const currentCwdRef = useRef(currentCwd);
  currentCwdRef.current = currentCwd;
  const historyIndexRef = useRef(historyIndex);
  historyIndexRef.current = historyIndex;
  const pendingRefreshRef = useRef(false);

  // --- Get initial CWD from syncGroup terminal store (one-time) ---
  const initialGroupCwd = useTerminalStore((s) => {
    if (!syncGroup) return undefined;
    const groupTerminals = s.instances.filter((t) => t.syncGroup === syncGroup && t.cwd);
    if (groupTerminals.length === 0) return undefined;
    return groupTerminals[0].cwd;
  });

  // --- Prepend ".." entry to file list ---
  const displayEntries = useMemo(() => {
    if (!currentCwd || currentCwd === "/") return entries;
    const parentEntry: DirEntry = {
      name: "..",
      isDirectory: true,
      isSymlink: false,
      isExecutable: false,
      size: 0,
    };
    return [parentEntry, ...entries];
  }, [entries, currentCwd]);

  // --- Refresh listing via Rust backend ---
  const refreshListing = useCallback(async (cwd?: string) => {
    const targetCwd = cwd ?? currentCwdRef.current;
    if (!targetCwd) return;
    setLoading(true);
    try {
      const result = await listDirectory(targetCwd);
      setEntries(result);
      setFocusIndex(0);
      setSelectedIndices(new Set());
    } catch (err) {
      console.error("FileExplorer: Failed to list directory", err);
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, []);

  // --- Navigate to a new CWD (pushes to history) ---
  const navigateTo = useCallback(
    (newCwd: string) => {
      setCurrentCwd(newCwd);
      refreshListing(newCwd);

      // Push to history: truncate forward stack, then push
      setHistory((prev) => [...prev.slice(0, historyIndex + 1), newCwd]);
      setHistoryIndex((prev) => prev + 1);

      // Propagate CWD to sync group
      if (cwdSend && syncGroup) {
        handleLxMessage(
          JSON.stringify({
            action: "sync-cwd",
            path: newCwd,
            terminal_id: instanceId,
            group_id: syncGroup,
          }),
        ).catch(() => {});
      }
    },
    [cwdSend, syncGroup, instanceId, refreshListing, historyIndex],
  );

  // --- Navigate to directory (resolve ".." or child) ---
  const navigateToDir = useCallback(
    (dirName: string) => {
      const newCwd =
        dirName === ".."
          ? parentPath(currentCwdRef.current)
          : joinPath(currentCwdRef.current, dirName);
      if (newCwd) navigateTo(newCwd);
    },
    [navigateTo],
  );

  // --- Go back/forward in history ---
  const goBack = useCallback(() => {
    if (!canGoBack) return;
    const newIndex = historyIndex - 1;
    const target = history[newIndex];
    setHistoryIndex(newIndex);
    setCurrentCwd(target);
    refreshListing(target);
    if (cwdSend && syncGroup) {
      handleLxMessage(
        JSON.stringify({
          action: "sync-cwd",
          path: target,
          terminal_id: instanceId,
          group_id: syncGroup,
        }),
      ).catch(() => {});
    }
  }, [canGoBack, historyIndex, history, refreshListing, cwdSend, syncGroup, instanceId]);

  const goForward = useCallback(() => {
    if (!canGoForward) return;
    const newIndex = historyIndex + 1;
    const target = history[newIndex];
    setHistoryIndex(newIndex);
    setCurrentCwd(target);
    refreshListing(target);
    if (cwdSend && syncGroup) {
      handleLxMessage(
        JSON.stringify({
          action: "sync-cwd",
          path: target,
          terminal_id: instanceId,
          group_id: syncGroup,
        }),
      ).catch(() => {});
    }
  }, [canGoForward, historyIndex, history, refreshListing, cwdSend, syncGroup, instanceId]);

  // --- Listen for CWD changes from syncGroup terminals ---
  useEffect(() => {
    if (!cwdReceive || !syncGroup) return;
    let cancelled = false;
    const promise = onTerminalCwdChanged((data) => {
      if (cancelled) return;
      // Check if the changed terminal belongs to our syncGroup
      const terminal = useTerminalStore.getState().instances.find((t) => t.id === data.terminalId);
      if (!terminal || terminal.syncGroup !== syncGroup) return;
      if (data.cwd === currentCwdRef.current) return;
      setCurrentCwd(data.cwd);
      refreshListing(data.cwd);
      setHistory((prev) => [...prev.slice(0, historyIndexRef.current + 1), data.cwd]);
      setHistoryIndex((prev) => prev + 1);
    });
    return () => {
      cancelled = true;
      promise.then((unlisten) => unlisten());
    };
  }, [cwdReceive, syncGroup, refreshListing]);

  // --- Initial listing ---
  useEffect(() => {
    const initialCwd = lastCwd || initialGroupCwd;
    if (initialCwd) {
      setCurrentCwd(initialCwd);
      refreshListing(initialCwd);
      if (!history.length) {
        setHistory([initialCwd]);
        setHistoryIndex(0);
      }
    } else {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
        const entry = displayEntries[i];
        if (!entry || entry.name === "..") return "";
        return joinPath(currentCwd, entry.name);
      })
      .filter(Boolean)
      .join("\n");
    if (paths) clipboardWriteText(paths).catch(console.error);
  }, [selectedIndices, displayEntries, currentCwd]);

  // --- Copy on select ---
  useEffect(() => {
    if (settings.copyOnSelect && selectedIndices.size > 0) {
      copySelectedPaths();
    }
  }, [settings.copyOnSelect, selectedIndices, copySelectedPaths]);

  // --- Open file viewer ---
  const openFile = useCallback(
    async (entry: DirEntry) => {
      const filePath = joinPath(currentCwd, entry.name);

      const ext = entry.name.includes(".") ? "." + entry.name.split(".").pop()!.toLowerCase() : "";
      const viewer = settings.extensionViewers.find((v) =>
        v.extensions.some((e) => e.toLowerCase() === ext),
      );

      if (viewer) {
        setMode({ type: "viewing", filePath, viewerType: "terminal", command: viewer.command });
        return;
      }

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
          setViewerContent({ kind: "image", imageSrc: content.dataUrl });
        } else {
          setViewerContent({ kind: "binary", size: content.size });
        }
      } catch (err) {
        setViewerContent({ kind: "text", content: `Error reading file: ${err}` });
      }
    },
    [currentCwd, settings.extensionViewers],
  );

  // --- Handle item activation (double-click or Enter) ---
  const activateEntry = useCallback(
    (entry: DirEntry) => {
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

  // --- Mouse back/forward buttons (button 3 = back, button 4 = forward) ---
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 3) {
        e.preventDefault();
        if (mode.type === "viewing") {
          closeViewer();
        } else {
          goBack();
        }
      } else if (e.button === 4) {
        e.preventDefault();
        goForward();
      }
    },
    [mode.type, goBack, goForward, closeViewer],
  );

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

      const len = displayEntries.length;
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
          const entry = displayEntries[focusIndex];
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
        case "Backspace": {
          e.preventDefault();
          navigateToDir("..");
          break;
        }
      }
    },
    [
      mode.type,
      displayEntries,
      focusIndex,
      selectSingle,
      selectRange,
      activateEntry,
      closeViewer,
      copySelectedPaths,
      scrollToIndex,
      navigateToDir,
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
      const entry = displayEntries[index];
      if (entry) activateEntry(entry);
    },
    [displayEntries, activateEntry],
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

  const navBtnStyle = {
    background: "none",
    border: "none",
    cursor: "pointer",
    padding: "0 4px",
    fontSize: 14,
    lineHeight: 1,
  };

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
        onMouseDown={handleMouseDown}
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
            className="ml-2 mr-1 px-1 text-xs hover:opacity-80"
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
                startupCommandOverride={`${mode.command} ${shellEscape(mode.filePath)}`}
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
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
    >
      {/* Path bar with back/forward buttons */}
      <div
        className="flex items-center shrink-0 px-1 border-b"
        style={{
          height: 28,
          borderColor: "var(--border)",
          background: "var(--bg-surface)",
        }}
        data-testid="file-explorer-path-bar"
      >
        <button
          onClick={goBack}
          disabled={!canGoBack}
          style={{
            ...navBtnStyle,
            color: canGoBack ? "var(--text-primary)" : "var(--text-secondary)",
            opacity: canGoBack ? 1 : 0.3,
          }}
          data-testid="file-explorer-back"
          title="Back (Alt+Left)"
        >
          ←
        </button>
        <button
          onClick={goForward}
          disabled={!canGoForward}
          style={{
            ...navBtnStyle,
            color: canGoForward ? "var(--text-primary)" : "var(--text-secondary)",
            opacity: canGoForward ? 1 : 0.3,
          }}
          data-testid="file-explorer-forward"
          title="Forward (Alt+Right)"
        >
          →
        </button>
        <span className="text-xs truncate ml-1" style={{ color: "var(--text-primary)" }}>
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
        ) : displayEntries.length === 0 ? (
          <div
            className="flex items-center justify-center h-full"
            style={{ color: "var(--text-secondary)" }}
          >
            Empty directory
          </div>
        ) : (
          displayEntries.map((entry, i) => (
            <div
              key={`${entry.name}-${i}`}
              className="flex items-center px-2 cursor-pointer select-none"
              style={{
                height: 24,
                background:
                  i === focusIndex && selectedIndices.has(i)
                    ? "var(--accent)"
                    : selectedIndices.has(i)
                      ? "var(--accent-50)"
                      : i === focusIndex
                        ? "var(--accent-20)"
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
                {entry.name === ".."
                  ? "📁 .."
                  : entry.isDirectory
                    ? `📁 ${entry.name}/`
                    : entry.isSymlink
                      ? `🔗 ${entry.name}`
                      : `📄 ${entry.name}`}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
