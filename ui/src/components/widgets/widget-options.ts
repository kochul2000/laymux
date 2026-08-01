/**
 * Option value domains and width estimates for the built-in widgets.
 *
 * Separate from the components so the values can be imported by the registry,
 * the settings editor and tests without dragging a React module along — and so
 * each component file stays a component file.
 */

export type UsageWidgetDisplay = "bar" | "number" | "both";

export const USAGE_WIDGET_DISPLAYS: readonly UsageWidgetDisplay[] = ["bar", "number", "both"];

export type TerminalActivityScope = "workspace" | "all";

export const TERMINAL_ACTIVITY_SCOPES: readonly TerminalActivityScope[] = ["workspace", "all"];

/** Width one row costs at each display mode; the label and gaps are added on top. */
const ROW_WIDTH: Record<UsageWidgetDisplay, number> = { bar: 34, number: 34, both: 62 };
const LABEL_WIDTH = 44;

/**
 * How much a usage widget asks the slot to budget.
 *
 * Row count comes from the global `usage.*.visibleRows`, so a wider selection
 * makes the widget collapse sooner rather than shrink (ADR-0105).
 */
export function estimateUsageWidgetWidth(display: UsageWidgetDisplay, rowCount: number): number {
  return LABEL_WIDTH + Math.max(1, rowCount) * ROW_WIDTH[display];
}

export function readDisplay(options: Record<string, unknown>): UsageWidgetDisplay {
  const value = options.display;
  return USAGE_WIDGET_DISPLAYS.includes(value as UsageWidgetDisplay)
    ? (value as UsageWidgetDisplay)
    : "both";
}

export function readTerminalActivityScope(options: Record<string, unknown>): TerminalActivityScope {
  return options.scope === "all" ? "all" : "workspace";
}

/**
 * Width the cwd widget may occupy.
 *
 * The estimate and the render cap must be the same number: a widget is an
 * atomic unit, so a cap wider than the estimate would let the slot admit a path
 * it then clips in half (ADR-0105).
 */
export const CWD_WIDGET_WIDTH = 200;
