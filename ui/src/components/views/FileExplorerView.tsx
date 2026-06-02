import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useFileViewerStore } from "@/stores/file-viewer-store";
import {
  clipboardWriteText,
  listDirectory,
  getHomeDirectory,
  statPath,
  onTerminalCwdChanged,
  handleLxMessage,
  type DirEntry,
} from "@/lib/tauri-api";
// convertFileSrc no longer needed — images are returned as data URLs
import {
  joinPath,
  parentPath,
  normalizeAddressInput,
  resolveAddressNavigation,
} from "@/lib/file-explorer-parse";
import { ViewShell } from "@/components/ui/ViewShell";
import { ViewHeader } from "@/components/ui/ViewHeader";
import { ViewBody } from "@/components/ui/ViewBody";

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

export function FileExplorerView({
  instanceId,
  syncGroup,
  cwdSend = true,
  cwdReceive = true,
  isFocused,
  lastCwd,
}: FileExplorerViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const settings = useSettingsStore((s) => s.fileExplorer);
  const openFileViewer = useFileViewerStore((s) => s.openFileViewer);

  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [currentCwd, setCurrentCwd] = useState<string>(lastCwd || "");
  const [loading, setLoading] = useState(true);
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set());
  const [focusIndex, setFocusIndex] = useState(0);
  const [lastClickIndex, setLastClickIndex] = useState(0);

  // --- Editable address bar (#278) ---
  const [addressEditing, setAddressEditing] = useState(false);
  const [addressValue, setAddressValue] = useState("");
  const [addressError, setAddressError] = useState(false);
  const addressInputRef = useRef<HTMLInputElement>(null);

  // --- History stack for back/forward navigation ---
  const [history, setHistory] = useState<string[]>(lastCwd ? [lastCwd] : []);
  const [historyIndex, setHistoryIndex] = useState(0);
  const canGoBack = historyIndex > 0;
  const canGoForward = historyIndex < history.length - 1;

  const currentCwdRef = useRef(currentCwd);
  currentCwdRef.current = currentCwd;
  const historyIndexRef = useRef(historyIndex);
  historyIndexRef.current = historyIndex;

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
      // Skip if source terminal has cwdSend disabled
      if (data.cwdSend === false) return;
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
    let cancelled = false;

    const applyInitialCwd = (cwd: string) => {
      if (cancelled) return;
      setCurrentCwd(cwd);
      refreshListing(cwd);
      // Only initialize history (and reset the index to 0) when it is still
      // empty; if entries already exist, leave navigation state untouched.
      setHistory((prev) => (prev.length ? prev : [cwd]));
      setHistoryIndex((prev) => (history.length ? prev : 0));
    };

    const initialCwd = lastCwd || initialGroupCwd;
    if (initialCwd) {
      applyInitialCwd(initialCwd);
      return;
    }

    // No lastCwd and no syncGroup CWD available. Rather than getting stuck
    // showing "..." with an empty listing (#274), fall back to the user's
    // home directory so the explorer always has a valid, navigable path.
    getHomeDirectory()
      .then((home) => {
        if (cancelled || !home) {
          if (!cancelled) setLoading(false);
          return;
        }
        // If a syncGroup CWD arrived while we were resolving, prefer it.
        if (currentCwdRef.current) {
          setLoading(false);
          return;
        }
        applyInitialCwd(home);
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Focus management ---
  useEffect(() => {
    if (isFocused) {
      containerRef.current?.focus();
    }
  }, [isFocused]);

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

  // --- Open file in the shared global viewer overlay (#277/#279) ---
  // The viewer is a single floating overlay rendered in AppLayout, so it is no
  // longer constrained to this pane's size.
  const openFile = useCallback(
    (entry: DirEntry) => {
      const filePath = joinPath(currentCwd, entry.name);
      openFileViewer(filePath);
    },
    [currentCwd, openFileViewer],
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

  // --- Address bar: begin editing (click/focus) ---
  const beginAddressEdit = useCallback(() => {
    setAddressValue(currentCwdRef.current);
    setAddressError(false);
    setAddressEditing(true);
  }, []);

  // --- Address bar: cancel editing (Esc / blur) → revert to current path ---
  const cancelAddressEdit = useCallback(() => {
    setAddressEditing(false);
    setAddressError(false);
  }, []);

  // --- Address bar: commit (Enter) ---
  // Validates the typed/pasted path against the Rust backend, then either
  // navigates to a directory, or navigates to a file's parent + opens the file
  // in the shared viewer. Invalid paths keep the editor open and flag an error.
  const commitAddress = useCallback(async () => {
    const normalized = normalizeAddressInput(addressValue);
    if (!normalized) {
      setAddressError(true);
      return;
    }
    let info: { exists: boolean; isDirectory: boolean };
    try {
      info = await statPath(normalized);
    } catch {
      info = { exists: false, isDirectory: false };
    }
    const action = resolveAddressNavigation(normalized, info);
    if (action.kind === "invalid") {
      setAddressError(true);
      return;
    }
    setAddressEditing(false);
    setAddressError(false);
    if (action.kind === "navigate") {
      navigateTo(action.dir);
    } else {
      // File: move into its directory AND open it in the shared viewer (#278).
      navigateTo(action.dir);
      openFileViewer(action.file);
    }
  }, [addressValue, navigateTo, openFileViewer]);

  // --- Focus the input when entering edit mode ---
  useEffect(() => {
    if (addressEditing) {
      const input = addressInputRef.current;
      if (input) {
        input.focus();
        input.select();
      }
    }
  }, [addressEditing]);

  const handleAddressKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Keep arrow/typing keys from reaching the list's keyboard handler.
      e.stopPropagation();
      if (e.key === "Enter") {
        e.preventDefault();
        void commitAddress();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancelAddressEdit();
      }
    },
    [commitAddress, cancelAddressEdit],
  );

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
        goBack();
      } else if (e.button === 4) {
        e.preventDefault();
        goForward();
      }
    },
    [goBack, goForward],
  );

  // --- Keyboard handler ---
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
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
        case "Backspace": {
          e.preventDefault();
          navigateToDir("..");
          break;
        }
      }
    },
    [
      displayEntries,
      focusIndex,
      selectSingle,
      selectRange,
      activateEntry,
      scrollToIndex,
      navigateToDir,
    ],
  );

  // --- Copy event handler: responds to system copy (Ctrl+C, Cmd+C, context menu) ---
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handleCopy = (e: ClipboardEvent) => {
      if (selectedIndices.size === 0) return;
      e.preventDefault();
      copySelectedPaths();
    };
    el.addEventListener("copy", handleCopy);
    return () => el.removeEventListener("copy", handleCopy);
  }, [selectedIndices, copySelectedPaths]);

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

  // ===== RENDER (file listing) =====
  return (
    <ViewShell
      ref={containerRef}
      testId="file-explorer-view"
      className="outline-none"
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onMouseDown={handleMouseDown}
      onContextMenu={handleContextMenu}
    >
      <ViewHeader className="px-1" testId="file-explorer-path-bar">
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
        {addressEditing ? (
          <input
            ref={addressInputRef}
            type="text"
            className="text-xs ml-1 flex-1 min-w-0 outline-none rounded px-1"
            style={{
              background: "var(--bg-base)",
              color: "var(--text-primary)",
              border: addressError ? "1px solid var(--red)" : "1px solid var(--accent)",
            }}
            value={addressValue}
            spellCheck={false}
            autoComplete="off"
            data-testid="file-explorer-address-input"
            aria-invalid={addressError}
            onChange={(e) => {
              setAddressValue(e.target.value);
              if (addressError) setAddressError(false);
            }}
            onKeyDown={handleAddressKeyDown}
            onBlur={cancelAddressEdit}
          />
        ) : (
          <span
            className="text-xs truncate ml-1 flex-1 min-w-0 cursor-text"
            style={{ color: "var(--text-primary)" }}
            data-testid="file-explorer-address"
            title="Click to edit path"
            onClick={beginAddressEdit}
          >
            {currentCwd || "..."}
          </span>
        )}
      </ViewHeader>

      <ViewBody ref={listRef} style={listStyle} testId="file-explorer-list">
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
      </ViewBody>
    </ViewShell>
  );
}
