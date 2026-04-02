import { useCallback, useRef } from "react";
import { useWorkspaceStore } from "@/stores/workspace-store";
import {
  findPaneBoundaries,
  calcResizeDelta,
  shouldMergeOnDragEnd,
  type PaneBoundary,
} from "@/hooks/usePaneResize";

const HANDLE_THICKNESS = 8; // px

/** Generic pane with x/y/w/h — shared by workspace and dock */
type GridPane = { x: number; y: number; w: number; h: number };

interface Props {
  containerWidth: number;
  containerHeight: number;
  /** Override panes source (for dock). If omitted, reads from workspace store. */
  panes?: GridPane[];
  /** Get latest panes during drag. If omitted, reads from workspace store. */
  getLatestPanes?: () => GridPane[];
  /** Resize callback by index. If omitted, calls workspace store. */
  onResizePane?: (index: number, delta: Partial<GridPane>) => void;
  /** Remove callback by index. If omitted, calls workspace store. */
  onRemovePane?: (index: number) => void;
}

export function PaneBoundaryHandles({
  containerWidth,
  containerHeight,
  panes: propPanes,
  getLatestPanes: propGetLatestPanes,
  onResizePane: propOnResizePane,
  onRemovePane: propOnRemovePane,
}: Props) {
  const activeWorkspace = useWorkspaceStore((s) => s.getActiveWorkspace());
  const storeResizePane = useWorkspaceStore((s) => s.resizePane);
  const storeRemovePane = useWorkspaceStore((s) => s.removePane);

  const panes = propPanes ?? activeWorkspace?.panes ?? [];
  const getLatestPanes =
    propGetLatestPanes ?? (() => useWorkspaceStore.getState().getActiveWorkspace()?.panes ?? []);
  const resizePane = propOnResizePane ?? storeResizePane;
  const removePane = propOnRemovePane ?? storeRemovePane;

  const dragging = useRef<{
    boundary: PaneBoundary;
    startPos: number;
  } | null>(null);

  const handleMouseDown = useCallback(
    (boundary: PaneBoundary, e: React.MouseEvent) => {
      e.preventDefault();
      const startPos = boundary.direction === "vertical" ? e.clientX : e.clientY;
      dragging.current = { boundary, startPos };

      const handleMouseMove = (me: MouseEvent) => {
        if (!dragging.current) return;
        const { boundary: bd, startPos: sp } = dragging.current;
        const currentPos = bd.direction === "vertical" ? me.clientX : me.clientY;
        const containerSize = bd.direction === "vertical" ? containerWidth : containerHeight;
        if (containerSize === 0) return;

        const rawDelta = (currentPos - sp) / containerSize;
        const currentPanes = getLatestPanes();
        if (!currentPanes || currentPanes.length === 0) return;

        const delta = calcResizeDelta(bd, rawDelta, currentPanes);
        if (Math.abs(delta) < 0.001) return;

        for (const idx of bd.leftPaneIndices) {
          const p = currentPanes[idx];
          if (bd.direction === "vertical") {
            resizePane(idx, { w: p.w + delta });
          } else {
            resizePane(idx, { h: p.h + delta });
          }
        }
        for (const idx of bd.rightPaneIndices) {
          const p = currentPanes[idx];
          if (bd.direction === "vertical") {
            resizePane(idx, { x: p.x + delta, w: p.w - delta });
          } else {
            resizePane(idx, { y: p.y + delta, h: p.h - delta });
          }
        }

        dragging.current.startPos = currentPos;
      };

      const handleMouseUp = () => {
        if (dragging.current) {
          const currentPanes = getLatestPanes();
          if (currentPanes && currentPanes.length > 0) {
            const mergeIndices = shouldMergeOnDragEnd(dragging.current.boundary, currentPanes);
            if (mergeIndices) {
              const sorted = [...mergeIndices].sort((a, b) => b - a);
              for (const idx of sorted) {
                removePane(idx);
              }
            }
          }
        }
        dragging.current = null;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [containerWidth, containerHeight, resizePane, getLatestPanes, removePane],
  );

  const handleDoubleClick = useCallback(
    (boundary: PaneBoundary) => {
      const currentPanes = getLatestPanes();
      if (!currentPanes || currentPanes.length === 0) return;

      const leftSize = boundary.leftPaneIndices.reduce((sum, idx) => {
        const p = currentPanes[idx];
        return sum + p.w * p.h;
      }, 0);
      const rightSize = boundary.rightPaneIndices.reduce((sum, idx) => {
        const p = currentPanes[idx];
        return sum + p.w * p.h;
      }, 0);

      const indicesToRemove =
        leftSize <= rightSize ? boundary.leftPaneIndices : boundary.rightPaneIndices;

      const sorted = [...indicesToRemove].sort((a, b) => b - a);
      for (const idx of sorted) {
        removePane(idx);
      }
    },
    [removePane, getLatestPanes],
  );

  if (panes.length <= 1) return null;

  const boundaries = findPaneBoundaries(panes);

  return (
    <>
      {boundaries.map((bd, i) => {
        const isVertical = bd.direction === "vertical";
        const style: React.CSSProperties = isVertical
          ? {
              position: "absolute",
              left: `${bd.position * 100}%`,
              top: `${bd.start * 100}%`,
              width: `${HANDLE_THICKNESS}px`,
              height: `${(bd.end - bd.start) * 100}%`,
              transform: "translateX(-50%)",
              cursor: "col-resize",
              zIndex: 10,
              background: "transparent",
            }
          : {
              position: "absolute",
              left: `${bd.start * 100}%`,
              top: `${bd.position * 100}%`,
              width: `${(bd.end - bd.start) * 100}%`,
              height: `${HANDLE_THICKNESS}px`,
              transform: "translateY(-50%)",
              cursor: "row-resize",
              zIndex: 10,
              background: "transparent",
            };

        return (
          <div
            key={`boundary-${i}`}
            data-testid={`boundary-handle-${i}`}
            style={style}
            onMouseDown={(e) => handleMouseDown(bd, e)}
            onDoubleClick={() => handleDoubleClick(bd)}
          />
        );
      })}
    </>
  );
}
