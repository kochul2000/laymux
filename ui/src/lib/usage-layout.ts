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

/** Below this body height even labels no longer fit alongside the paired meters. */
export const COMPACT_MAX_HEIGHT = 48;
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

export interface UsageDensity {
  usedMeterHeight: string;
  labelFontSize: string;
  showFooter: boolean;
  showDetailText: boolean;
  /** Space between rendered rows; contracts before either outer padding or text. */
  rowGap: string;
  /** Space inside each row, between title and meters. */
  blockGap: string;
}

const USED_METER_MAX_HEIGHT = 16;
const USED_METER_MIN_HEIGHT = 3;
const LABEL_MAX_SIZE = 13;
const LABEL_MIN_SIZE = 10;
const DETAIL_TEXT_HEIGHT_PER_ROW = 44;
const FULL_PRESENTATION_HEIGHT_PER_ROW = 64;
const MIN_ROW_GAP = 2;
const MAX_ROW_GAP = 16;
// Even at the lowest readable density the two meters must not visually merge.
const MIN_BLOCK_GAP = 1;
const MAX_BLOCK_GAP = 4;

/**
 * Preserve all visual information while the pane can afford it, then shed
 * supporting text before the view falls back to bars only in compact mode.
 */
export function resolveUsageDensity(height: number, rowCount: number): UsageDensity {
  const count = Math.max(1, rowCount);
  // The content owns 8px at either edge. The spaces between rows collapse
  // first, then meters and labels shrink, then supporting text disappears.
  // This avoids changing to bars-only merely because a normal three-row view
  // is shorter than its comfortable presentation.
  const detailTextMinHeight = COMPACT_MAX_HEIGHT + count * DETAIL_TEXT_HEIGHT_PER_ROW;
  const fullHeight = COMPACT_MAX_HEIGHT + count * FULL_PRESENTATION_HEIGHT_PER_ROW;
  const progress = Math.max(
    0,
    Math.min(1, (height - COMPACT_MAX_HEIGHT) / (fullHeight - COMPACT_MAX_HEIGHT)),
  );
  const spacingProgress = Math.max(
    0,
    Math.min(1, (height - detailTextMinHeight) / (fullHeight - detailTextMinHeight)),
  );
  const usedMeterHeight =
    USED_METER_MIN_HEIGHT + (USED_METER_MAX_HEIGHT - USED_METER_MIN_HEIGHT) * progress;
  const labelFontSize = LABEL_MIN_SIZE + (LABEL_MAX_SIZE - LABEL_MIN_SIZE) * progress;

  return {
    usedMeterHeight: `${usedMeterHeight}px`,
    labelFontSize: `${labelFontSize}px`,
    showFooter: height >= fullHeight,
    showDetailText: height >= detailTextMinHeight,
    rowGap: `${MIN_ROW_GAP + (MAX_ROW_GAP - MIN_ROW_GAP) * spacingProgress}px`,
    blockGap: `${MIN_BLOCK_GAP + (MAX_BLOCK_GAP - MIN_BLOCK_GAP) * spacingProgress}px`,
  };
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
  rowCount: number = USAGE_ROW_COUNT,
): UsageLayout {
  if (preference !== "auto") return preference;

  const { width, height } = box;
  // A zero-sized box happens on the first frame, before measurement. Stacked is
  // the safe default: it degrades to a scrolling column rather than to clipped
  // side-by-side content.
  if (width <= 0 || height <= 0) return "stacked";

  if (height < COMPACT_MAX_HEIGHT) return "compact";

  const aspect = width / height;
  const fitsColumns = width >= COLUMN_MIN_WIDTH * Math.max(1, rowCount);
  if (aspect >= COLUMNS_MIN_ASPECT && fitsColumns) return "columns";

  return "stacked";
}

/** Whether a layout shows the reset text and pace labels in full. */
export function showsDetail(layout: UsageLayout): boolean {
  return layout !== "compact";
}
