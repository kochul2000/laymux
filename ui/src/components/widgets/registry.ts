/**
 * The widget catalogue (ADR-0105).
 *
 * `type` values here are an external contract: they appear verbatim in
 * `settings.json` and the Rust write path validates against the same list
 * (`constants.rs::WIDGET_TYPES`). Renaming one orphans placements users already
 * saved, so treat a rename as a new decision.
 */

import { ClaudeUsageWidget } from "./ClaudeUsageWidget";
import { CodexUsageWidget } from "./CodexUsageWidget";
import { GrokUsageWidget } from "./GrokUsageWidget";
import { CwdWidget } from "./CwdWidget";
import { NotificationsWidget } from "./NotificationsWidget";
import { TerminalActivityWidget } from "./TerminalActivityWidget";
import {
  CWD_WIDGET_WIDTH,
  DEFAULT_USAGE_BAR_WIDTH,
  DEFAULT_ELAPSED_BAR_HEIGHT,
  DEFAULT_USED_BAR_HEIGHT,
  estimateUsageWidgetWidth,
  readBarWidth,
  readDisplay,
  TERMINAL_ACTIVITY_SCOPES,
  USAGE_BAR_WIDTH_MAX,
  USAGE_BAR_WIDTH_MIN,
  USAGE_BAR_HEIGHT_MAX,
  USAGE_BAR_HEIGHT_MIN,
  USAGE_WIDGET_DISPLAYS,
  scaleWidgetWidth,
} from "./widget-options";
import type { WidgetDefinition } from "./types";

/** Thickness is per placement: a status line glance and a top bar glance are read at different distances. */
const BAR_HEIGHT_SPECS = [
  {
    key: "barHeight",
    kind: "number" as const,
    labelKey: "widgets.option.barHeight",
    min: USAGE_BAR_HEIGHT_MIN,
    max: USAGE_BAR_HEIGHT_MAX,
  },
  {
    key: "elapsedHeight",
    kind: "number" as const,
    labelKey: "widgets.option.elapsedHeight",
    min: USAGE_BAR_HEIGHT_MIN,
    max: USAGE_BAR_HEIGHT_MAX,
  },
];
const BAR_HEIGHT_DEFAULTS = {
  barHeight: DEFAULT_USED_BAR_HEIGHT,
  elapsedHeight: DEFAULT_ELAPSED_BAR_HEIGHT,
  barWidth: DEFAULT_USAGE_BAR_WIDTH,
};

const BAR_WIDTH_SPEC = {
  key: "barWidth",
  kind: "number" as const,
  labelKey: "widgets.option.barWidth",
  min: USAGE_BAR_WIDTH_MIN,
  max: USAGE_BAR_WIDTH_MAX,
};

export const WIDGET_DEFINITIONS: readonly WidgetDefinition[] = [
  {
    type: "claudeUsage",
    labelKey: "widgets.type.claudeUsage",
    interactive: false,
    defaultOptions: { configDir: "", display: "both", ...BAR_HEIGHT_DEFAULTS },
    optionSpecs: [
      { key: "configDir", kind: "claudeConfigDir", labelKey: "widgets.option.configDir" },
      {
        key: "display",
        kind: "select",
        labelKey: "widgets.option.display",
        choices: USAGE_WIDGET_DISPLAYS,
      },
      BAR_WIDTH_SPEC,
      ...BAR_HEIGHT_SPECS,
    ],
    estimateWidth: (instance, env) =>
      estimateUsageWidgetWidth(
        readDisplay(instance.options),
        env.claudeVisibleRows,
        readBarWidth(instance.options),
        env.fontSize,
      ),
    Component: ClaudeUsageWidget,
  },
  {
    type: "codexUsage",
    labelKey: "widgets.type.codexUsage",
    interactive: false,
    defaultOptions: { display: "both", ...BAR_HEIGHT_DEFAULTS },
    optionSpecs: [
      {
        key: "display",
        kind: "select",
        labelKey: "widgets.option.display",
        choices: USAGE_WIDGET_DISPLAYS,
      },
      BAR_WIDTH_SPEC,
      ...BAR_HEIGHT_SPECS,
    ],
    estimateWidth: (instance, env) =>
      estimateUsageWidgetWidth(
        readDisplay(instance.options),
        env.codexVisibleRows,
        readBarWidth(instance.options),
        env.fontSize,
      ),
    Component: CodexUsageWidget,
  },
  {
    type: "grokUsage",
    labelKey: "widgets.type.grokUsage",
    interactive: false,
    defaultOptions: { configDir: "", display: "both", ...BAR_HEIGHT_DEFAULTS },
    optionSpecs: [
      { key: "configDir", kind: "grokConfigDir", labelKey: "widgets.option.configDir" },
      {
        key: "display",
        kind: "select",
        labelKey: "widgets.option.display",
        choices: USAGE_WIDGET_DISPLAYS,
      },
      BAR_WIDTH_SPEC,
      ...BAR_HEIGHT_SPECS,
    ],
    estimateWidth: (instance, env) =>
      estimateUsageWidgetWidth(
        readDisplay(instance.options),
        env.grokVisibleRows,
        readBarWidth(instance.options),
        env.fontSize,
      ),
    Component: GrokUsageWidget,
  },
  {
    type: "terminalActivity",
    labelKey: "widgets.type.terminalActivity",
    interactive: false,
    defaultOptions: { scope: "workspace" },
    optionSpecs: [
      {
        key: "scope",
        kind: "select",
        labelKey: "widgets.option.scope",
        choices: TERMINAL_ACTIVITY_SCOPES,
      },
    ],
    estimateWidth: (_instance, env) => scaleWidgetWidth(58, env.fontSize),
    Component: TerminalActivityWidget,
  },
  {
    type: "notifications",
    labelKey: "widgets.type.notifications",
    // Clicking opens the notification panel, so this one must not double as a
    // window drag handle.
    interactive: true,
    defaultOptions: {},
    optionSpecs: [],
    estimateWidth: (_instance, env) => scaleWidgetWidth(46, env.fontSize),
    Component: NotificationsWidget,
  },
  {
    type: "cwd",
    labelKey: "widgets.type.cwd",
    interactive: true,
    defaultOptions: {},
    optionSpecs: [],
    // Chrome padding on top of the text cap, so the slot never admits a path
    // it would then clip.
    estimateWidth: () => CWD_WIDGET_WIDTH + 12,
    Component: CwdWidget,
  },
];

const BY_TYPE = new Map(WIDGET_DEFINITIONS.map((definition) => [definition.type, definition]));

/** `undefined` for a type this build does not know — render skips it (ADR-0105). */
export function findWidgetDefinition(type: string): WidgetDefinition | undefined {
  return BY_TYPE.get(type);
}
