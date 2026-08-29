export interface RectLike {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface SizeLike {
  width: number;
  height: number;
  scrollWidth?: number;
  /** Full content height, retained even when the rendered box has max-height. */
  scrollHeight?: number;
}

export interface FloatingToolbarPlacement {
  placement: "down" | "up";
  top: number;
  left: number;
  maxWidth: number;
  maxHeight?: number;
  constrained: boolean;
  constrainedX: boolean;
  escapedPane: boolean;
}

const DEFAULT_MARGIN = 8;
const DEFAULT_GAP = 2;

function nonNegative(value: number): number {
  return Math.max(0, value);
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Places a portalled toolbar without changing pane layout.
 *
 * The preferred surface is the pane row immediately below the anchor. When
 * that cannot contain the whole toolbar, the toolbar flips above the anchor
 * (and may cross the pane boundary) before it is allowed to escape downward.
 * A physically smaller viewport is the only case that constrains height; the
 * caller keeps every action reachable with internal scrolling in that case.
 */
export function resolveFloatingToolbarPlacement({
  anchor,
  pane,
  menu,
  viewport,
  margin = DEFAULT_MARGIN,
  gap = DEFAULT_GAP,
}: {
  anchor: RectLike;
  pane: RectLike;
  menu: SizeLike;
  viewport: SizeLike;
  margin?: number;
  gap?: number;
}): FloatingToolbarPlacement {
  const safeMargin = Math.max(
    0,
    Math.min(margin, nonNegative(viewport.width) / 2, nonNegative(viewport.height) / 2),
  );
  const safeGap = nonNegative(gap);
  const viewportMaxWidth = nonNegative(viewport.width - safeMargin * 2);
  // The caller measures the menu after first constraining it to the pane. Its
  // resulting width is therefore either the wrapped pane width or the width of
  // an intrinsically unbreakable child. Preserve that width instead of
  // stretching the surface to the viewport; only the latter case escapes the
  // pane horizontally.
  const paneWidth = nonNegative(pane.right - pane.left);
  const maxWidth = Math.min(viewportMaxWidth, Math.max(paneWidth, nonNegative(menu.width)));
  const constrainedX = nonNegative(menu.scrollWidth ?? menu.width) > maxWidth + 1;
  const effectiveWidth = Math.min(nonNegative(menu.width), maxWidth);
  // ResizeObserver sees the constrained border box after max-height is applied.
  // Keep placement decisions tied to the intrinsic content height or the menu
  // would alternate between constrained and unconstrained on every frame.
  const menuHeight = Math.max(
    nonNegative(menu.height),
    nonNegative(menu.scrollHeight ?? menu.height),
  );
  const left = clamp(
    anchor.right - effectiveWidth,
    safeMargin,
    viewport.width - safeMargin - effectiveWidth,
  );

  const downTop = anchor.bottom + safeGap;
  const paneBottom = Math.min(pane.bottom, viewport.height - safeMargin);
  const paneDownSpace = nonNegative(paneBottom - downTop);
  const viewportDownSpace = nonNegative(viewport.height - safeMargin - downTop);
  const upBottom = anchor.top - safeGap;
  const viewportUpSpace = nonNegative(upBottom - safeMargin);

  if (menuHeight <= paneDownSpace) {
    return {
      placement: "down",
      top: downTop,
      left,
      maxWidth,
      constrained: false,
      constrainedX,
      escapedPane: false,
    };
  }

  if (menuHeight <= viewportUpSpace) {
    return {
      placement: "up",
      top: upBottom - menuHeight,
      left,
      maxWidth,
      constrained: false,
      constrainedX,
      escapedPane: upBottom - menuHeight < pane.top,
    };
  }

  if (menuHeight <= viewportDownSpace) {
    return {
      placement: "down",
      top: downTop,
      left,
      maxWidth,
      constrained: false,
      constrainedX,
      escapedPane: true,
    };
  }

  let useDown = viewportDownSpace >= viewportUpSpace;
  let maxHeight = useDown ? viewportDownSpace : viewportUpSpace;
  let constrainedTop = useDown ? downTop : safeMargin;
  // If the anchor itself consumes every directional candidate, overlap it as
  // the final fallback instead of returning an unusable zero-height scroller.
  if (maxHeight <= 0) {
    useDown = true;
    maxHeight = nonNegative(viewport.height - safeMargin * 2);
    constrainedTop = safeMargin;
  }
  return {
    placement: useDown ? "down" : "up",
    top: constrainedTop,
    left,
    maxWidth,
    maxHeight,
    constrained: true,
    constrainedX,
    escapedPane: true,
  };
}
