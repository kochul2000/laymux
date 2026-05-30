/**
 * Small badge showing a pane's spatial reading-order number (issue #256).
 *
 * Rendered as the leading element of a control bar's left section so humans can
 * glance at a pane and tell an AI "send to pane N". The number is the spatial
 * `paneNumber` (see `lib/pane-numbers.ts`), NOT the array `paneIndex`.
 *
 * Renders nothing when `number` is undefined (e.g. dock panes, previews).
 */
export function PaneNumberBadge({ number }: { number?: number }) {
  if (number == null) return null;
  return (
    <span
      data-testid="pane-number-badge"
      className="mr-1.5 flex shrink-0 items-center justify-center font-medium tabular-nums"
      style={{
        minWidth: "16px",
        height: "16px",
        padding: "0 4px",
        fontSize: "var(--fs-xs)",
        lineHeight: 1,
        color: "var(--accent)",
        background: "var(--accent-20)",
        borderRadius: "var(--radius-sm)",
      }}
      title={`Pane ${number}`}
    >
      {number}
    </span>
  );
}
