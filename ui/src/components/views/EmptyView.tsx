import { useEffect, useCallback, useState, useRef } from "react";
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
  dragOver,
  onSelect,
  onHover,
  onHandlePointerDown,
}: {
  option: ViewOption;
  index: number;
  hovered: boolean;
  dragging: boolean;
  dragOver: "above" | "below" | null;
  onSelect: () => void;
  onHover: (entering: boolean) => void;
  onHandlePointerDown: (e: React.PointerEvent) => void;
}) {
  const shortcutNum = index + 1;
  return (
    <div
      data-card-index={index}
      style={{
        opacity: dragging ? 0.4 : 1,
        borderTop: dragOver === "above" ? "2px solid var(--accent)" : "2px solid transparent",
        borderBottom: dragOver === "below" ? "2px solid var(--accent)" : "2px solid transparent",
        transition: "opacity 0.15s",
      }}
    >
      <div
        role="button"
        tabIndex={0}
        data-testid={option.testId}
        onClick={onSelect}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(); } }}
        onMouseEnter={() => onHover(true)}
        onMouseLeave={() => onHover(false)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-md pl-3 pr-1.5 py-2.5 text-left transition-all duration-100"
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

        {/* Drag handle */}
        <span
          data-testid={`drag-handle-${index}`}
          onPointerDown={onHandlePointerDown}
          onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
          className="shrink-0 text-[10px]"
          style={{ color: "var(--text-secondary)", opacity: 0.25, cursor: "grab", userSelect: "none", touchAction: "none", padding: "4px 12px 4px 8px" }}
        >
          ⠿
        </span>
      </div>
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
    key: "browser",
    label: "Browser Preview",
    category: "browser",
    config: { type: "BrowserPreviewView" },
    testId: "empty-view-browser",
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

/** Find which card index the pointer is over by walking up from the event target. */
function cardIndexFromPoint(listEl: HTMLElement, clientY: number): { index: number; half: "above" | "below" } | null {
  const cards = listEl.querySelectorAll<HTMLElement>("[data-card-index]");
  for (const card of cards) {
    const rect = card.getBoundingClientRect();
    if (clientY >= rect.top && clientY <= rect.bottom) {
      const idx = Number(card.dataset.cardIndex);
      const half = clientY < rect.top + rect.height / 2 ? "above" : "below";
      return { index: idx, half };
    }
  }
  return null;
}

export function EmptyView({ onSelectView, context: _context = "pane", isFocused }: EmptyViewProps) {
  const profiles = useSettingsStore((s) => s.profiles);
  const visibleProfiles = profiles.filter((p) => !p.hidden);
  const viewOrder = useSettingsStore((s) => s.viewOrder) ?? [];
  const setViewOrder = useSettingsStore((s) => s.setViewOrder);
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const rawOptions = buildOptions(visibleProfiles);
  const options = applyOrder(rawOptions, viewOrder);

  // Pointer-based drag state
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [dragOverInfo, setDragOverInfo] = useState<{ index: number; half: "above" | "below" } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const dragOverRef = useRef(dragOverInfo);
  dragOverRef.current = dragOverInfo;
  const optionsRef = useRef(options);
  optionsRef.current = options;

  const handlePointerDown = (e: React.PointerEvent, idx: number) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.target as HTMLElement;
    if (el.setPointerCapture) el.setPointerCapture(e.pointerId);
    setDragIdx(idx);
    draggingRef.current = true;
  };

  useEffect(() => {
    if (dragIdx === null) return;

    const handlePointerMove = (e: PointerEvent) => {
      if (!draggingRef.current || !listRef.current) return;
      const hit = cardIndexFromPoint(listRef.current, e.clientY);
      setDragOverInfo(hit && hit.index !== dragIdx ? hit : null);
    };

    const handlePointerUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;

      const overInfo = dragOverRef.current;
      const opts = optionsRef.current;
      if (overInfo && dragIdx !== null && overInfo.index !== dragIdx) {
        const reordered = [...opts];
        const [moved] = reordered.splice(dragIdx, 1);
        let targetIdx = overInfo.index;
        // Adjust for the removal shifting indices
        if (dragIdx < targetIdx) targetIdx--;
        if (overInfo.half === "below") targetIdx++;
        reordered.splice(Math.min(targetIdx, reordered.length), 0, moved);
        setViewOrder(reordered.map((o) => o.key));
      }

      setDragIdx(null);
      setDragOverInfo(null);
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dragIdx]);

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
      data-testid="empty-view"
      className="flex h-full flex-col items-center justify-center gap-3 p-6"
      style={{ color: "var(--text-secondary)" }}
    >
      {/* Header */}
      <div className="mb-2 text-center">
        <p className="text-sm font-medium" style={{ color: "var(--text-primary)", opacity: 0.7 }}>
          Select a view
        </p>
        <p className="mt-0.5 text-[10px]" style={{ opacity: 0.4 }}>
          Press number key to quick-select · Drag handle to reorder
        </p>
      </div>

      {/* Options list */}
      <div ref={listRef} className="flex w-full max-w-[240px] flex-col gap-1">
        {options.map((opt, i) => (
          <EmptyViewCard
            key={opt.key}
            option={opt}
            index={i}
            hovered={hoveredIdx === i}
            dragging={dragIdx === i}
            dragOver={
              dragOverInfo && dragOverInfo.index === i && dragIdx !== i
                ? dragOverInfo.half
                : null
            }
            onSelect={() => handleSelect(i)}
            onHover={(entering) => setHoveredIdx(entering ? i : null)}
            onHandlePointerDown={(e) => handlePointerDown(e, i)}
          />
        ))}
      </div>
    </div>
  );
}
