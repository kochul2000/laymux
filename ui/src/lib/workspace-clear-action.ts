import { useSettingsStore } from "@/stores/settings-store";
import {
  clearWorkspace,
  isNoOpClearResult,
  summarizeClearResult,
  type WorkspaceClearResult,
} from "./workspace-clear";

/**
 * The desktop UI's entry into the workspace clear (ADR-0113).
 *
 * Lives outside `workspace-clear.ts` because it reads the settings store, and
 * that store imports the clear module's defaults — keeping the settings read
 * here is what stops the dependency from becoming a cycle.
 *
 * Both UI entry points (the `workspace.clearTerminals` keybinding and the
 * WorkspaceSelectorView row button) go through here so the outcome is reported
 * the same way. Unlike the Automation path there is no response to inspect, and
 * the default `busyPolicy: "skip"` can legitimately do nothing at all — an
 * unreported no-op is indistinguishable from a broken shortcut.
 */
export async function runWorkspaceClearFromUi(
  workspaceId: string,
): Promise<WorkspaceClearResult | null> {
  try {
    const result = await clearWorkspace(workspaceId, useSettingsStore.getState().workspaceClear);
    const summary = summarizeClearResult(result);
    if (isNoOpClearResult(result)) {
      // Nothing was touched. Either every pane was busy under the default
      // policy, or every write was refused (a remote client holding the
      // control lease does exactly that).
      console.warn(`[workspace clear] ${workspaceId}: nothing cleared — ${summary}`);
    } else if (result.skipped.length > 0 || result.failed.length > 0) {
      console.warn(`[workspace clear] ${workspaceId}: ${summary}`);
    }
    for (const failure of result.failed) {
      console.warn(`[workspace clear] ${failure.terminalId}: ${failure.error}`);
    }
    return result;
  } catch (err) {
    console.warn(`[workspace clear] ${workspaceId} failed:`, err);
    return null;
  }
}
