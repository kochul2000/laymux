import { useEffect, useCallback, useRef, useState } from "react";
import type { ViewInstanceConfig } from "@/stores/types";
import { useSettingsStore } from "@/stores/settings-store";

export type EmptyViewContext = "pane" | "dock";

interface EmptyViewProps {
  onSelectView?: (config: ViewInstanceConfig) => void;
  context?: EmptyViewContext;
  isFocused?: boolean;
}

interface ViewOption {
  key: string;
  label: string;
  category: string;
  config: ViewInstanceConfig;
  testId: string;
}

function EmptyViewCard({
  option,
  index,
  hovered,
  dragging,
  dropPosition,
  onSelect,
  onHover,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}: {
  option: ViewOption;
  index: number;
  hovered: boolean;
  dragging: boolean;
  dropPosition: "top" | "bottom" | null;
  onSelect: () => void;
  onHover: (entering: boolean) => void;
  onDragStart: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDrop: () => void;
}) {
  const shortcutNum = index + 1;
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
      style={{
        opacity: dragging ? 0.4 : 1,
        borderTop: dropPosition === "top" ? "2px solid var(--accent)" : "2px solid transparent",
        borderBottom:
          dropPosition === "bottom" ? "2px solid var(--accent)" : "2px solid transparent",
        transition: "opacity 0.15s",
      }}
    >
      <button
        data-testid={option.testId}
        onClick={onSelect}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-md px-3 py-2.5 text-left transition-all duration-100"
        style={{
          border: `1px solid ${hovered ? "var(--accent)" : "var(--border)"}`,
          background: hovered ? "rgba(137,180,250,0.08)" : "var(--bg-surface)",
          color: "var(--text-primary)",
        }}
      >
        {/* Shortcut key badge */}
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[10px] font-bold"
          style={{
            background: hovered ? "var(--accent)" : "rgba(255,255,255,0.08)",
            color: hovered ? "var(--bg-base)" : "var(--text-secondary)",
            transition: "all 0.1s",
          }}
        >
          {shortcutNum <= 9 ? shortcutNum : ""}
        </span>

        {/* Label */}
        <span className="flex-1 text-xs font-medium">{option.label}</span>

        {/* Category tag */}
        <span
          className="shrink-0 text-[9px] uppercase tracking-wider"
          style={{ color: "var(--text-secondary)", opacity: 0.4 }}
        >
          {option.category}
        </span>

        {/* Drag handle — right edge */}
        <span
          className="shrink-0 pl-2 pr-0.5 text-[10px]"
          style={{
            color: "var(--text-secondary)",
            opacity: 0.25,
            cursor: "grab",
            userSelect: "none",
          }}
        >
          ⠿
        </span>
      </button>
    </div>
  );
}

/** Build the default options list (unordered). */
function buildOptions(visibleProfiles: { name: string }[]): ViewOption[] {
  const options: ViewOption[] = [];

  for (const p of visibleProfiles) {
    options.push({
      key: `terminal-${p.name}`,
      label: p.name,
      category: "terminal",
      config: { type: "TerminalView", profile: p.name },
      testId: `empty-view-terminal-${p.name}`,
    });
  }

  options.push({
    key: "memo",
    label: "Memo",
    category: "tool",
    config: { type: "MemoView" },
    testId: "empty-view-memo",
  });

  options.push({
    key: "file-explorer",
    label: "File Explorer",
    category: "tool",
    config: { type: "FileExplorerView" },
    testId: "empty-view-file-explorer",
  });

  options.push({
    key: "issue-reporter",
    label: "Report Issue",
    category: "tool",
    config: { type: "IssueReporterView" },
    testId: "empty-view-issue-reporter",
  });

  options.push({
    key: "ws-selector",
    label: "Workspaces",
    category: "dock",
    config: { type: "WorkspaceSelectorView" },
    testId: "empty-view-workspace-selector",
  });
  options.push({
    key: "settings",
    label: "Settings",
    category: "dock",
    config: { type: "SettingsView" },
    testId: "empty-view-settings",
  });

  return options;
}

/** Reorder options based on a stored key order. */
function applyOrder(options: ViewOption[], order: string[]): ViewOption[] {
  if (!order.length) return options;
  const map = new Map(options.map((o) => [o.key, o]));
  const ordered: ViewOption[] = [];
  for (const key of order) {
    const opt = map.get(key);
    if (opt) {
      ordered.push(opt);
      map.delete(key);
    }
  }
  // Append any new options not in the stored order
  for (const opt of map.values()) ordered.push(opt);
  return ordered;
}

export function EmptyView({ onSelectView, context: _context = "pane", isFocused }: EmptyViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const profiles = useSettingsStore((s) => s.profiles);
  const visibleProfiles = profiles.filter((p) => !p.hidden);
  const viewOrder = useSettingsStore((s) => s.viewOrder) ?? [];
  const setViewOrder = useSettingsStore((s) => s.setViewOrder);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Grab DOM focus when this pane becomes focused (e.g. via Alt+Arrow navigation)
  useEffect(() => {
    if (isFocused) {
      containerRef.current?.focus();
    }
  }, [isFocused]);

  const rawOptions = buildOptions(visibleProfiles);
  const options = applyOrder(rawOptions, viewOrder);

  // Drag state
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dropInfo, setDropInfo] = useState<{ index: number; position: "top" | "bottom" } | null>(
    null,
  );
  const dropPositionRef = useRef<{ index: number; position: "top" | "bottom" } | null>(null);

  const handleDragStart = (idx: number) => {
    setDragIdx(idx);
  };
  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === idx) {
      setDropInfo(null);
      dropPositionRef.current = null;
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    const position: "top" | "bottom" = e.clientY < rect.top + rect.height / 2 ? "top" : "bottom";
    const info = { index: idx, position };
    dropPositionRef.current = info;
    setDropInfo((prev) => (prev?.index === idx && prev?.position === position ? prev : info));
  };
  const handleDrop = () => {
    const target = dropPositionRef.current;
    if (dragIdx === null || !target || dragIdx === target.index) {
      setDragIdx(null);
      setDropInfo(null);
      dropPositionRef.current = null;
      return;
    }
    const reordered = [...options];
    const [moved] = reordered.splice(dragIdx, 1);
    // Recalculate insert index after removal
    let insertIdx = target.index;
    if (dragIdx < target.index) insertIdx--;
    if (target.position === "bottom") insertIdx++;
    reordered.splice(Math.min(insertIdx, reordered.length), 0, moved);
    setViewOrder(reordered.map((o) => o.key));
    setDragIdx(null);
    setDropInfo(null);
    dropPositionRef.current = null;
  };
  const handleDragEnd = () => {
    setDragIdx(null);
    setDropInfo(null);
    dropPositionRef.current = null;
  };

  const handleSelect = useCallback(
    (idx: number) => {
      if (idx >= 0 && idx < options.length) {
        onSelectView?.(options[idx].config);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options.length, onSelectView],
  );

  // Keyboard shortcut: number keys 1-9 select the corresponding option
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
      const num = parseInt(e.key);
      if (num >= 1 && num <= 9 && num <= options.length) {
        e.preventDefault();
        e.stopPropagation();
        handleSelect(num - 1);
      }
    };
    if (isFocused !== false) {
      document.addEventListener("keydown", handler);
      return () => document.removeEventListener("keydown", handler);
    }
  }, [isFocused, handleSelect, options.length]);

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      data-testid="empty-view"
      className="flex h-full flex-col items-center justify-center gap-3 p-6 outline-none"
      style={{ color: "var(--text-secondary)" }}
    >
      {/* Header */}
      <div className="mb-2 text-center">
        <p className="text-sm font-medium" style={{ color: "var(--text-primary)", opacity: 0.7 }}>
          Select a view
        </p>
        <p className="mt-0.5 text-[10px]" style={{ opacity: 0.4 }}>
          Press number key to quick-select · Drag to reorder
        </p>
      </div>

      {/* Options list */}
      <div className="flex w-full max-w-[240px] flex-col gap-1">
        {options.map((opt, i) => (
          <EmptyViewCard
            key={opt.key}
            option={opt}
            index={i}
            hovered={hoveredIdx === i}
            dragging={dragIdx === i}
            dropPosition={
              dropInfo && dropInfo.index === i && dragIdx !== i ? dropInfo.position : null
            }
            onSelect={() => handleSelect(i)}
            onHover={(entering) => setHoveredIdx(entering ? i : null)}
            onDragStart={() => handleDragStart(i)}
            onDragOver={(e) => handleDragOver(e, i)}
            onDragEnd={handleDragEnd}
            onDrop={handleDrop}
          />
        ))}
      </div>
    </div>
  );
}
