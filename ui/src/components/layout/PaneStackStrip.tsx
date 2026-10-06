import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { PlusIcon, XIcon } from "@/components/ui/icons";
import { useResolvedKeybinding } from "@/lib/keybinding-registry";
import { getLayerDragData, LAYER_DND_MIME, setLayerDragData } from "@/lib/pane-dnd";
import { toTerminalId } from "@/lib/pane-ids";
import { layerTabTitle } from "@/lib/pane-stack-title";
import { useNotificationStore } from "@/stores/notification-store";
import { useTerminalStore } from "@/stores/terminal-store";
import type { PaneLayer } from "@/stores/types";

export interface PaneStackStripProps {
  /** The slot's layers in stack order. */
  layers: readonly PaneLayer[];
  activeLayerId: string;
  /** Spatial numbers keyed by layer id (ADR-0295), or null when unnumbered. */
  paneNumbers?: Map<string, number> | null;
  onActivate: (layerId: string) => void;
  onClose?: (layerId: string) => void;
  onAdd?: () => void;
  /** Pull a layer out into its own split slot (tab context menu). */
  onSplitOut?: (layerId: string, direction: "horizontal" | "vertical") => void;
  /** Tab drag lifecycle, so the grid knows a layer (not a slot) is in flight. */
  onTabDragStart?: (layerId: string) => void;
  onTabDragEnd?: () => void;
  /** Layer currently being dragged anywhere in the grid, if any. */
  draggingLayerId?: string | null;
  /** Drop a dragged layer at `index` among this strip's other layers. */
  onDropLayer?: (layerId: string, index: number) => void;
}

interface TabState {
  title: string;
  dot: "unread" | "active" | null;
}

type DropMark = { layerId: string; side: "before" | "after" } | null;

function isLayerDrag(e: React.DragEvent, draggingLayerId?: string | null): boolean {
  return Boolean(draggingLayerId) || (e.dataTransfer?.types?.includes(LAYER_DND_MIME) ?? false);
}

/**
 * Fixed top row of a stacked slot (ADR-0295): one tab per layer plus an add
 * button. Click activates, middle-click or × closes, `+` stacks a new layer,
 * dragging a tab reorders it or moves it to another slot, and the tab context
 * menu splits a layer out into its own slot. Only rendered for slots holding
 * two or more layers.
 */
export function PaneStackStrip({
  layers,
  activeLayerId,
  paneNumbers,
  onActivate,
  onClose,
  onAdd,
  onSplitOut,
  onTabDragStart,
  onTabDragEnd,
  draggingLayerId,
  onDropLayer,
}: PaneStackStripProps) {
  const stackKeys = useResolvedKeybinding("pane.stack");
  const layerKeys = useResolvedKeybinding("pane.layer");
  const [dropMark, setDropMark] = useState<DropMark>(null);
  const [menu, setMenu] = useState<{ layerId: string; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const terminalIds = layers.map((layer) =>
    layer.view.type === "TerminalView" ? toTerminalId(layer.id) : null,
  );

  // Primitive per-tab facts so the strip re-renders only when a tab changes.
  const titles = useTerminalStore(
    useShallow((s) =>
      layers.map((layer, index) => {
        const id = terminalIds[index];
        const instance = id ? s.instances.find((candidate) => candidate.id === id) : undefined;
        return layerTabTitle({
          viewType: layer.view.type,
          title: instance?.title,
          label: instance?.label,
          profile:
            instance?.profile ||
            (typeof layer.view.profile === "string" ? layer.view.profile : undefined),
          cwd:
            instance?.cwd ||
            (typeof layer.view.lastCwd === "string" ? layer.view.lastCwd : undefined),
        });
      }),
    ),
  );
  const active = useTerminalStore(
    useShallow((s) =>
      terminalIds.map((id) =>
        id ? s.instances.some((candidate) => candidate.id === id && candidate.outputActive) : false,
      ),
    ),
  );
  const unread = useNotificationStore(
    useShallow((s) =>
      terminalIds.map((id) =>
        id ? s.notifications.some((n) => n.terminalId === id && n.readAt === null) : false,
      ),
    ),
  );

  const tabs: TabState[] = layers.map((_layer, index) => ({
    title: titles[index],
    dot: unread[index] ? "unread" : active[index] ? "active" : null,
  }));

  // Close the tab menu on any outside press or Escape.
  useEffect(() => {
    if (!menu) return;
    const onPointer = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  const dropEnabled = Boolean(onDropLayer);

  /** Position among this strip's layers once the dragged one is taken out. */
  const dropIndex = (draggedId: string, mark: NonNullable<DropMark>): number => {
    const others = layers.filter((layer) => layer.id !== draggedId);
    const at = others.findIndex((layer) => layer.id === mark.layerId);
    return at < 0 ? others.length : at + (mark.side === "after" ? 1 : 0);
  };

  const finishDrop = (e: React.DragEvent, mark: DropMark) => {
    e.preventDefault();
    e.stopPropagation();
    setDropMark(null);
    const draggedId = draggingLayerId ?? getLayerDragData(e);
    if (!draggedId || !onDropLayer) return;
    if (mark && mark.layerId === draggedId) return;
    const others = layers.filter((layer) => layer.id !== draggedId);
    onDropLayer(draggedId, mark ? dropIndex(draggedId, mark) : others.length);
  };

  return (
    <div
      className="pane-stack-strip"
      role="tablist"
      aria-label="Pane stack"
      data-testid="pane-stack-strip"
      title={layerKeys ? `Switch layer: ${layerKeys}` : undefined}
      onDragOver={
        dropEnabled
          ? (e) => {
              if (!isLayerDrag(e, draggingLayerId)) return;
              e.preventDefault();
              e.stopPropagation();
              e.dataTransfer.dropEffect = "move";
            }
          : undefined
      }
      onDrop={dropEnabled ? (e) => finishDrop(e, null) : undefined}
    >
      {layers.map((layer, index) => {
        const isActive = layer.id === activeLayerId;
        const number = paneNumbers?.get(layer.id);
        const tab = tabs[index];
        return (
          <div
            key={layer.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={-1}
            className="pane-stack-tab"
            data-active={isActive ? "true" : "false"}
            data-drop={dropMark?.layerId === layer.id ? dropMark.side : undefined}
            data-testid={`pane-stack-tab-${layer.id}`}
            title={tab.title}
            draggable={Boolean(onTabDragStart)}
            onClick={() => onActivate(layer.id)}
            onAuxClick={(e) => {
              if (e.button !== 1 || !onClose) return;
              e.preventDefault();
              onClose(layer.id);
            }}
            onMouseDown={(e) => {
              // Middle-click must not start autoscroll on the strip.
              if (e.button === 1) e.preventDefault();
            }}
            onContextMenu={
              onSplitOut || onClose
                ? (e) => {
                    e.preventDefault();
                    setMenu({ layerId: layer.id, x: e.clientX, y: e.clientY });
                  }
                : undefined
            }
            onDragStart={
              onTabDragStart
                ? (e) => {
                    e.stopPropagation();
                    setLayerDragData(e, layer.id);
                    onTabDragStart(layer.id);
                  }
                : undefined
            }
            onDragEnd={
              onTabDragStart
                ? () => {
                    setDropMark(null);
                    onTabDragEnd?.();
                  }
                : undefined
            }
            onDragOver={
              dropEnabled
                ? (e) => {
                    if (!isLayerDrag(e, draggingLayerId)) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.dataTransfer.dropEffect = "move";
                    const rect = e.currentTarget.getBoundingClientRect();
                    // Without layout (zero width) the drop counts as "before".
                    const side =
                      rect.width <= 0 || e.clientX - rect.left < rect.width / 2
                        ? "before"
                        : "after";
                    if (dropMark?.layerId !== layer.id || dropMark.side !== side) {
                      setDropMark({ layerId: layer.id, side });
                    }
                  }
                : undefined
            }
            onDragLeave={
              dropEnabled
                ? () => {
                    if (dropMark?.layerId === layer.id) setDropMark(null);
                  }
                : undefined
            }
            onDrop={
              dropEnabled
                ? (e) => finishDrop(e, dropMark ?? { layerId: layer.id, side: "before" })
                : undefined
            }
          >
            {number != null && <span className="pane-stack-tab-number">{number}</span>}
            {tab.dot && (
              <span
                className="pane-stack-tab-dot"
                data-kind={tab.dot}
                data-testid={`pane-stack-tab-dot-${layer.id}`}
              />
            )}
            <span className="pane-stack-tab-title">{tab.title}</span>
            {onClose && (
              <button
                type="button"
                className="pane-stack-tab-close"
                data-testid={`pane-stack-tab-close-${layer.id}`}
                aria-label={`Close ${tab.title}`}
                title="Close layer"
                draggable={false}
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(layer.id);
                }}
              >
                <XIcon size={12} />
              </button>
            )}
          </div>
        );
      })}
      {onAdd && (
        <button
          type="button"
          className="pane-stack-add"
          data-testid="pane-stack-add"
          aria-label="Stack new layer"
          title={`Stack new layer${stackKeys ? ` (${stackKeys})` : ""}`}
          onClick={onAdd}
        >
          <PlusIcon />
        </button>
      )}
      {menu &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="pane-control-popover pane-stack-menu"
            data-testid="pane-stack-menu"
            style={{ left: menu.x, top: menu.y }}
          >
            {onSplitOut && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="pane-stack-menu-item"
                  data-testid="pane-stack-menu-split-right"
                  onClick={() => {
                    setMenu(null);
                    onSplitOut(menu.layerId, "vertical");
                  }}
                >
                  Split out right
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="pane-stack-menu-item"
                  data-testid="pane-stack-menu-split-down"
                  onClick={() => {
                    setMenu(null);
                    onSplitOut(menu.layerId, "horizontal");
                  }}
                >
                  Split out down
                </button>
              </>
            )}
            {onClose && (
              <button
                type="button"
                role="menuitem"
                className="pane-stack-menu-item"
                data-testid="pane-stack-menu-close"
                onClick={() => {
                  setMenu(null);
                  onClose(menu.layerId);
                }}
              >
                Close layer
              </button>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
