import type { Settings } from "./tauri-api";

let committedKey: string | undefined;
/** Runtime structures belong to SQLite; compare only configuration here. */
export function configurationKey(settings: Settings): string {
  const {
    workspaces: _workspaces,
    docks: _docks,
    workspaceDisplayOrder: _order,
    localUiState: _uiState,
    ...configuration
  } = settings;
  return JSON.stringify(configuration);
}
export function seedSessionConfiguration(settings: Settings): void {
  committedKey = configurationKey(settings);
}
export function configurationNeedsSave(settings: Settings): boolean {
  return committedKey !== configurationKey(settings);
}
export function resetSessionConfiguration(): void {
  committedKey = undefined;
}
