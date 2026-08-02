import { useSettingsStore } from "@/stores/settings-store";
import {
  clearPane,
  clearWorkspace,
  isNoOpClearResult,
  summarizeClearResult,
  type WorkspaceClearResult,
} from "./workspace-clear";

/**
 * The desktop UI's entry into the clear (ADR-0113, ADR-0121).
 *
 * Lives outside `workspace-clear.ts` because it reads the settings store, and
 * that store imports the clear module's defaults — keeping the settings read
 * here is what stops the dependency from becoming a cycle.
 *
 * Every UI entry point (both clear keybindings and the WorkspaceSelectorView row
 * button) goes through here so the outcome is reported the same way. Unlike the
 * Automation path there is no response to inspect, and the default
 * `busyPolicy: "skip"` can legitimately do nothing at all — an unreported no-op
 * is indistinguishable from a broken shortcut.
 */
async function reportClear(
  scope: string,
  target: string,
  run: () => Promise<WorkspaceClearResult>,
): Promise<WorkspaceClearResult | null> {
  try {
    const result = await run();
    const summary = summarizeClearResult(result);
    if (isNoOpClearResult(result)) {
      // Nothing was touched. Either every pane was busy under the default
      // policy, or every write was refused (a remote client holding the
      // control lease does exactly that).
      console.warn(`[${scope}] ${target}: nothing cleared — ${summary}`);
    } else if (result.skipped.length > 0 || result.failed.length > 0) {
      console.warn(`[${scope}] ${target}: ${summary}`);
    }
    for (const failure of result.failed) {
      console.warn(`[${scope}] ${failure.terminalId}: ${failure.error}`);
    }
    return result;
  } catch (err) {
    console.warn(`[${scope}] ${target} failed:`, err);
    return null;
  }
}

export async function runWorkspaceClearFromUi(
  workspaceId: string,
): Promise<WorkspaceClearResult | null> {
  return reportClear("workspace clear", workspaceId, () =>
    clearWorkspace(workspaceId, useSettingsStore.getState().workspaceClear),
  );
}

/** Single-pane counterpart (`pane.clearTerminal`, default Alt+L). */
export async function runPaneClearFromUi(paneId: string): Promise<WorkspaceClearResult | null> {
  return reportClear("pane clear", paneId, () =>
    clearPane(paneId, useSettingsStore.getState().workspaceClear),
  );
}
