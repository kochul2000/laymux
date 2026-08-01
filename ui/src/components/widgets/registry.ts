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
import { CwdWidget } from "./CwdWidget";
import { NotificationsWidget } from "./NotificationsWidget";
import { TerminalActivityWidget } from "./TerminalActivityWidget";
import {
  CWD_WIDGET_WIDTH,
  estimateUsageWidgetWidth,
  readDisplay,
  TERMINAL_ACTIVITY_SCOPES,
  USAGE_WIDGET_DISPLAYS,
} from "./widget-options";
import type { WidgetDefinition } from "./types";

export const WIDGET_DEFINITIONS: readonly WidgetDefinition[] = [
  {
    type: "claudeUsage",
    labelKey: "widgets.type.claudeUsage",
    interactive: false,
    defaultOptions: { configDir: "", display: "both" },
    optionSpecs: [
      { key: "configDir", kind: "claudeConfigDir", labelKey: "widgets.option.configDir" },
      {
        key: "display",
        kind: "select",
        labelKey: "widgets.option.display",
        choices: USAGE_WIDGET_DISPLAYS,
      },
    ],
    estimateWidth: (instance, env) =>
      estimateUsageWidgetWidth(readDisplay(instance.options), env.claudeVisibleRows),
    Component: ClaudeUsageWidget,
  },
  {
    type: "codexUsage",
    labelKey: "widgets.type.codexUsage",
    interactive: false,
    defaultOptions: { display: "both" },
    optionSpecs: [
      {
        key: "display",
        kind: "select",
        labelKey: "widgets.option.display",
        choices: USAGE_WIDGET_DISPLAYS,
      },
    ],
    estimateWidth: (instance, env) =>
      estimateUsageWidgetWidth(readDisplay(instance.options), env.codexVisibleRows),
    Component: CodexUsageWidget,
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
    estimateWidth: () => 58,
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
    estimateWidth: () => 46,
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
