/**
 * Layout choice for `UsageView`.
 *
 * The pane can be any rectangle the grid allows, so the view picks its
 * arrangement from the box it was given rather than from a fixed setting
 * (ADR-0102). Users can still pin a choice; `auto` is only the default.
 */

/** Arrangements the view can render. */
export type UsageLayout = "stacked" | "columns" | "compact";

/** What a pane may be pinned to. `auto` re-derives from the box. */
export type UsageLayoutPreference = UsageLayout | "auto";

/** Below this height only a single inline row fits. */
export const COMPACT_MAX_HEIGHT = 120;
/** Side-by-side needs at least this much width per column to stay readable. */
export const COLUMN_MIN_WIDTH = 180;
/** Number of limit rows the view shows. */
export const USAGE_ROW_COUNT = 3;
/** Width/height ratio at which side-by-side starts to beat stacking. */
export const COLUMNS_MIN_ASPECT = 1.8;

export interface Box {
  width: number;
  height: number;
}

/**
 * Resolve the arrangement for a box.
 *
 * A pinned preference is honored as-is — including a choice that fits poorly,
 * because second-guessing an explicit setting is worse than a cramped frame.
 * `auto` prefers `compact` for short boxes, then `columns` for wide ones that
 * can actually afford the columns, else `stacked`.
 */
export function resolveUsageLayout(
  box: Box,
  preference: UsageLayoutPreference = "auto",
): UsageLayout {
  if (preference !== "auto") return preference;

  const { width, height } = box;
  // A zero-sized box happens on the first frame, before measurement. Stacked is
  // the safe default: it degrades to a scrolling column rather than to clipped
  // side-by-side content.
  if (width <= 0 || height <= 0) return "stacked";

  if (height < COMPACT_MAX_HEIGHT) return "compact";

  const aspect = width / height;
  const fitsColumns = width >= COLUMN_MIN_WIDTH * USAGE_ROW_COUNT;
  if (aspect >= COLUMNS_MIN_ASPECT && fitsColumns) return "columns";

  return "stacked";
}

/** Whether a layout shows the reset text and pace labels in full. */
export function showsDetail(layout: UsageLayout): boolean {
  return layout !== "compact";
}
