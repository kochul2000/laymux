import { useSettingsStore } from "@/stores/settings-store";
import {
  clearPane,
  isNoOpPaneClearResult,
  summarizePaneClearResult,
  type PaneClearResult,
} from "./pane-clear";

/** Desktop UI entry point for the focused-pane actual clear (ADR-0158). */
export async function runPaneClearFromUi(paneId: string): Promise<PaneClearResult | null> {
  try {
    const result = await clearPane(paneId, useSettingsStore.getState().paneClear);
    const summary = summarizePaneClearResult(result);
    if (isNoOpPaneClearResult(result)) {
      console.warn(`[pane clear] ${paneId}: nothing cleared — ${summary}`);
    } else if (result.skipped.length > 0 || result.failed.length > 0) {
      console.warn(`[pane clear] ${paneId}: ${summary}`);
    }
    for (const failure of result.failed) {
      console.warn(`[pane clear] ${failure.terminalId}: ${failure.error}`);
    }
    return result;
  } catch (error) {
    console.warn(`[pane clear] ${paneId} failed:`, error);
    return null;
  }
}
