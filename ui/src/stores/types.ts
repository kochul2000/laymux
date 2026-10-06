export type ViewType =
  | "WorkspaceSelectorView"
  | "SettingsView"
  | "TerminalView"
  | "IssueReporterView"
  | "MemoView"
  | "UsageView"
  | "CodexUsageView"
  | "GrokUsageView"
  | "FileExplorerView"
  | "GitHubView"
  | "EmptyView";

export type DockPosition = "top" | "bottom" | "left" | "right";

/** One stacked layer of a layout template slot (ADR-0295). */
export interface LayoutLayer {
  viewType: ViewType;
  /** View configuration (profile, CWD, etc.), excluding pane-owned agent restore state. */
  viewConfig?: ViewInstanceConfig;
}

export interface LayoutPane {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Single-layer form. Ignored when `layers` is non-empty. */
  viewType: ViewType;
  /** View configuration (profile, CWD, etc.), excluding pane-owned agent restore state. */
  viewConfig?: ViewInstanceConfig;
  /** Stacked form (ADR-0295). Written only when the template slot holds 2+ layers. */
  layers?: LayoutLayer[];
  /** Index into `layers` of the layer shown when a workspace is created from this template. */
  activeLayerIndex?: number;
}

export interface Layout {
  id: string;
  name: string;
  panes: LayoutPane[];
}

export interface ViewInstanceConfig {
  type: ViewType;
  [key: string]: unknown;
}

/**
 * One piece of content stacked in a workspace slot (ADR-0295).
 *
 * The layer id plays every content role a "pane id" played before stacking:
 * `terminal-<layerId>`, view overrides, memo key, restart/CWD seed bus,
 * notifications, hidden flag and startup reveal.
 */
export interface PaneLayer {
  id: string;
  view: ViewInstanceConfig;
}

/**
 * A workspace grid slot (ADR-0295). The slot owns the geometry; its content is
 * the ordered `layers` list, of which exactly one (`activeLayerId`) is shown.
 * Invariants: `layers.length >= 1` and `activeLayerId` names one of them.
 * Mutate only through `lib/pane-layers.ts` and workspace-store actions.
 */
export interface WorkspacePane {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  layers: PaneLayer[];
  activeLayerId: string;
}

export interface Workspace {
  id: string;
  name: string;
  panes: WorkspacePane[];
}

export interface DockPane {
  id: string;
  view: ViewInstanceConfig;
  x: number; // 0.0-1.0
  y: number; // 0.0-1.0
  w: number; // 0.0-1.0
  h: number; // 0.0-1.0
}

export interface DockConfig {
  position: DockPosition;
  activeView: ViewType | null;
  views: ViewType[];
}
