import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { resolveFloatingToolbarPlacement } from "@/lib/floating-toolbar-placement";

/** A viewport-constrained menu that escapes dock scrolling and stacking contexts. */
export function ActionMenu({
  anchor,
  label,
  onClose,
  children,
}: {
  anchor: HTMLButtonElement;
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const place = () => {
      const bounds = menu.getBoundingClientRect();
      const viewport = { width: window.innerWidth, height: window.innerHeight };
      const placement = resolveFloatingToolbarPlacement({
        anchor: anchor.getBoundingClientRect(),
        pane: { top: 0, left: 0, right: viewport.width, bottom: viewport.height },
        menu: {
          width: bounds.width,
          height: bounds.height,
          intrinsicHeight: menu.scrollHeight + 2,
        },
        viewport,
      });
      Object.assign(menu.style, {
        top: `${placement.top}px`,
        left: `${placement.left}px`,
        maxHeight: `${placement.maxHeight ?? viewport.height - 16}px`,
        visibility: "visible",
      });
    };
    place();
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
    const pointer = (event: PointerEvent) => {
      if (!menu.contains(event.target as Node) && !anchor.contains(event.target as Node)) onClose();
    };
    const scroll = (event: Event) => {
      if (!menu.contains(event.target as Node)) onClose();
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        anchor.focus({ preventScroll: true });
      }
      if (event.key === "Tab") {
        onClose();
        anchor.focus({ preventScroll: true });
      }
      const items = [...menu.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
      const current = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        event.key === "ArrowDown"
          ? (current + 1) % items.length
          : event.key === "ArrowUp"
            ? (current - 1 + items.length) % items.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : -1;
      if (next >= 0) {
        event.preventDefault();
        items[next]?.focus();
      }
    };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", keyboard, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      document.removeEventListener("keydown", keyboard, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, onClose]);
  return createPortal(
    <div ref={ref} className="ui-action-menu" role="menu" aria-label={label}>
      {children}
    </div>,
    document.body,
  );
}
