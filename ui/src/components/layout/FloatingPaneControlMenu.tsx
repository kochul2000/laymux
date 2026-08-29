import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  resolveFloatingToolbarPlacement,
  type FloatingToolbarPlacement,
  type RectLike,
} from "@/lib/floating-toolbar-placement";

interface FloatingPaneControlMenuProps {
  children: ReactNode;
  openReason: "manual" | "hover";
  onRequestClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
  paneRef: RefObject<HTMLDivElement | null>;
}

interface AnchorSnapshot {
  rect: RectLike;
  paneTop: number;
  paneRight: number;
}

const HOVER_EXIT_GRACE_MS = 120;

/**
 * Portalled pane toolbar that cannot be clipped by a pane's overflow/stacking
 * context. It wraps before placement, prefers the pane row below its anchor,
 * flips above when that row is too short, and constrains only as a final
 * physically-small-viewport fallback.
 */
export function FloatingPaneControlMenu({
  children,
  openReason,
  onRequestClose,
  triggerRef,
  paneRef,
}: FloatingPaneControlMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const lastAnchorRef = useRef<AnchorSnapshot | null>(null);
  const [placement, setPlacement] = useState<FloatingToolbarPlacement | null>(null);

  const updatePlacement = useCallback(() => {
    const menu = menuRef.current;
    const pane = paneRef.current;
    if (!menu || !pane) return;

    const paneRect = pane.getBoundingClientRect();
    const triggerRect = triggerRef.current?.getBoundingClientRect();
    const hasTriggerRect = triggerRect && triggerRect.width > 0 && triggerRect.height > 0;
    if (hasTriggerRect) {
      lastAnchorRef.current = {
        rect: {
          top: triggerRect.top,
          right: triggerRect.right,
          bottom: triggerRect.bottom,
          left: triggerRect.left,
        },
        paneTop: paneRect.top,
        paneRight: paneRect.right,
      };
    }
    // Hovering the portal unmounts the trigger along with the pane's hover
    // controls. Retain its last measured rect for this menu lifetime; falling
    // back to pane.top at that moment would move the surface out from under the
    // pointer. The pane corner remains the initial no-trigger fallback.
    const lastAnchor = lastAnchorRef.current;
    const anchor: RectLike = lastAnchor
      ? {
          top: lastAnchor.rect.top + paneRect.top - lastAnchor.paneTop,
          bottom: lastAnchor.rect.bottom + paneRect.top - lastAnchor.paneTop,
          right: lastAnchor.rect.right + paneRect.right - lastAnchor.paneRight,
          left: lastAnchor.rect.left + paneRect.right - lastAnchor.paneRight,
        }
      : {
          top: paneRect.top,
          right: paneRect.right,
          bottom: paneRect.top,
          left: paneRect.right,
        };
    // Give wrapping the pane's own width first. If one intrinsic control is
    // wider than that (for example the view selector in an extremely narrow
    // pane), widen only enough for that control, up to the safe viewport.
    // This write happens while the unplaced menu is hidden and is immediately
    // followed by measurement, so no intermediate geometry is painted.
    const safeViewportWidth = Math.max(0, window.innerWidth - 16);
    const paneMaxWidth = Math.min(Math.max(0, paneRect.width), safeViewportWidth);
    menu.style.width = `${paneMaxWidth}px`;
    menu.style.maxWidth = `${paneMaxWidth}px`;
    let menuRect = menu.getBoundingClientRect();
    if (menu.scrollWidth > menuRect.width + 1) {
      const intrinsicWidth = Math.min(safeViewportWidth, Math.ceil(menu.scrollWidth));
      menu.style.width = `${intrinsicWidth}px`;
      menu.style.maxWidth = `${intrinsicWidth}px`;
      menuRect = menu.getBoundingClientRect();
    }
    const next = resolveFloatingToolbarPlacement({
      anchor,
      pane: paneRect,
      menu: { width: menuRect.width, height: menuRect.height, scrollWidth: menu.scrollWidth },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    setPlacement((previous) =>
      previous &&
      previous.placement === next.placement &&
      previous.top === next.top &&
      previous.left === next.left &&
      previous.maxWidth === next.maxWidth &&
      previous.maxHeight === next.maxHeight &&
      previous.constrained === next.constrained &&
      previous.constrainedX === next.constrainedX &&
      previous.escapedPane === next.escapedPane
        ? previous
        : next,
    );
  }, [paneRef, triggerRef]);

  // Measure after the portalled content has its wrapped dimensions, then keep
  // the context-menu-like placement current while panes or the viewport move.
  useEffect(() => {
    let frame = requestAnimationFrame(updatePlacement);
    const schedulePlacement = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updatePlacement);
    };
    const observer = new ResizeObserver(schedulePlacement);
    if (menuRef.current) observer.observe(menuRef.current);
    if (paneRef.current) observer.observe(paneRef.current);
    if (triggerRef.current) observer.observe(triggerRef.current);
    window.addEventListener("resize", schedulePlacement);
    window.addEventListener("scroll", schedulePlacement, true);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedulePlacement);
      window.removeEventListener("scroll", schedulePlacement, true);
    };
  }, [paneRef, triggerRef, updatePlacement]);

  // Outside click / Escape are shared by explicit and hover-opened toolbars.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      onRequestClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onRequestClose();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [onRequestClose, triggerRef]);

  // The portal may sit outside the pane DOM subtree. Hover-opened controls stay
  // alive while the pointer owns either surface. A short grace period bridges
  // the intentional placement gap, whose underlying DOM owns one pointermove
  // while the user crosses from the pane into the portalled surface.
  useEffect(() => {
    if (openReason !== "hover") return;
    let closeTimer: number | undefined;
    const cancelPendingClose = () => {
      if (closeTimer === undefined) return;
      window.clearTimeout(closeTimer);
      closeTimer = undefined;
    };
    const onPointerMove = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || paneRef.current?.contains(target)) {
        cancelPendingClose();
        return;
      }
      if (closeTimer !== undefined) return;
      closeTimer = window.setTimeout(onRequestClose, HOVER_EXIT_GRACE_MS);
    };
    document.addEventListener("pointermove", onPointerMove, true);
    return () => {
      cancelPendingClose();
      document.removeEventListener("pointermove", onPointerMove, true);
    };
  }, [onRequestClose, openReason, paneRef]);

  return createPortal(
    <div
      ref={menuRef}
      data-testid="pane-control-floating-menu"
      data-placement={placement?.placement}
      data-constrained={placement?.constrained ? "true" : undefined}
      data-constrained-x={placement?.constrainedX ? "true" : undefined}
      data-escaped-pane={placement?.escapedPane ? "true" : undefined}
      className="fixed z-50 p-1"
      role="toolbar"
      aria-label="Pane controls"
      style={{
        top: placement?.top ?? 0,
        left: placement?.left ?? 0,
        width: placement?.maxWidth ?? "max-content",
        maxWidth: placement?.maxWidth ?? "calc(100vw - 16px)",
        maxHeight: placement?.maxHeight,
        overflowX: placement?.constrainedX ? "auto" : "visible",
        overflowY: placement?.constrained ? "auto" : "visible",
        visibility: placement ? "visible" : "hidden",
        background: "var(--bar-bg-hover)",
        border: "1px solid var(--separator-bg)",
        borderRadius: "var(--radius-sm)",
        boxShadow: "0 8px 18px #00000059",
        backdropFilter: "blur(8px)",
      }}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
