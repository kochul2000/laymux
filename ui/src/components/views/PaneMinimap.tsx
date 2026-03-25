interface PaneRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PaneMinimapProps {
  panes: PaneRect[];
  highlightIndex: number;
  width?: number;
  height?: number;
}

export function PaneMinimap({
  panes,
  highlightIndex,
  width = 18,
  height = 12,
}: PaneMinimapProps) {
  return (
    <svg
      data-testid="pane-minimap"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Pane rects */}
      {panes.map((pane, i) => {
        const isHighlighted = i === highlightIndex;
        return (
          <rect
            key={i}
            data-pane-index={i}
            data-highlighted={isHighlighted ? "true" : "false"}
            x={pane.x * width}
            y={pane.y * height}
            width={pane.w * width}
            height={pane.h * height}
            fill={isHighlighted ? "var(--accent, #89b4fa)" : "var(--bg-surface, #313244)"}
            fillOpacity={isHighlighted ? 0.6 : 0.3}
            stroke="var(--border, #45475a)"
            strokeWidth={0.5}
          />
        );
      })}
      {/* Outer border */}
      <rect
        data-testid="minimap-border"
        x={0}
        y={0}
        width={width}
        height={height}
        fill="none"
        stroke="var(--text-secondary, #a6adc8)"
        strokeWidth={1}
        rx={1}
      />
    </svg>
  );
}
