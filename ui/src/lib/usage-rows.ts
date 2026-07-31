/**
 * Provider-neutral row shapes for the shared usage surface.
 *
 * Lives outside the view file so the presentation component stays the only
 * export there (react-refresh) and so row selection is unit-testable.
 */

/** One limit row, already resolved for display. */
export interface UsageDisplayRow {
  key: string;
  label: string;
  abbreviatedLabel?: string;
  percent: number | null;
  reset: string | null;
  elapsed: number | null;
}

/**
 * One row plus the settings key that decides whether it is shown. Keeping the
 * key on the row means `visibleRows` filtering never depends on row order.
 */
export interface KeyedUsageRow<VisibleKey extends string> {
  visibleKey: VisibleKey;
  row: UsageDisplayRow;
}

/** Filter provider rows by the user's visible-row selection, order-independently. */
export function selectVisibleRows<VisibleKey extends string>(
  rows: KeyedUsageRow<VisibleKey>[],
  visibleRows: readonly VisibleKey[],
): UsageDisplayRow[] {
  return rows.filter((entry) => visibleRows.includes(entry.visibleKey)).map((entry) => entry.row);
}
