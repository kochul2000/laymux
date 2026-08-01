/**
 * The contract a status widget implements (ADR-0105).
 *
 * A widget declares how wide it wants to be and whether it is interactive; the
 * slot decides everything else. Adding a widget is one file plus one registry
 * entry, and no placement, overflow or settings code changes.
 */

import type { ComponentType } from "react";
import type { WidgetInstance } from "@/lib/widget-placement";

/**
 * Settings a width estimate may depend on.
 *
 * Usage widgets are as wide as the number of rows the user selected globally,
 * so the slot has to hand that in rather than let a widget measure itself
 * mid-layout.
 */
export interface WidgetEnv {
  claudeVisibleRows: number;
  codexVisibleRows: number;
}

/** One editable option, rendered by the Settings widget section. */
export type WidgetOptionSpec =
  | {
      key: string;
      kind: "select";
      labelKey: string;
      /** Raw option values; labels come from `optionLabelKey(key, value)`. */
      choices: readonly string[];
    }
  | {
      key: string;
      kind: "claudeConfigDir";
      labelKey: string;
    }
  | {
      key: string;
      kind: "number";
      labelKey: string;
      min: number;
      max: number;
    };

export interface WidgetDefinition {
  type: string;
  /** i18n key for the name shown in Settings. */
  labelKey: string;
  /**
   * Interactive widgets must not carry `data-tauri-drag-region`, or a click
   * would start a window drag instead of reaching the widget.
   */
  interactive: boolean;
  defaultOptions: Record<string, unknown>;
  optionSpecs: readonly WidgetOptionSpec[];
  /** Width the slot should budget, in px. Used only for overflow decisions. */
  estimateWidth: (instance: WidgetInstance, env: WidgetEnv) => number;
  Component: ComponentType<WidgetComponentProps>;
}

export interface WidgetComponentProps {
  instance: WidgetInstance;
  /**
   * True when this placement may drag the window. Only ever true for a
   * non-interactive widget on the top bar; the component forwards it to
   * `WidgetChrome`, which is the element the pointer actually hits.
   */
  dragRegion?: boolean;
}
