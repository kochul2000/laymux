export type ViewType =
  | "WorkspaceSelectorView"
  | "SettingsView"
  | "TerminalView"
  | "BrowserPreviewView"
  | "IssueReporterView"
  | "EmptyView";

export type DockPosition = "top" | "bottom" | "left" | "right";

export interface LayoutPane {
  x: number;
  y: number;
  w: number;
  h: number;
  viewType: ViewType;
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

export interface WorkspacePane {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  view: ViewInstanceConfig;
}

export interface Workspace {
  id: string;
  name: string;
  layoutId: string;
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
