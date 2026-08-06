import {
  clearWorkspace,
  isNoOpClearResult,
  summarizeClearResult,
  type WorkspaceClearResult,
} from "./workspace-clear";

/**
 * The desktop UI's entry into the workspace clear (ADR-0137).
 *
 * Every UI entry point (both the Ctrl+Alt+L shortcut and the WorkspaceSelectorView
 * row button) goes through here so the outcome is reported the same way. Unlike
 * the Automation path there is no response to inspect, so a no-op run (nothing
 * to clear, or every write refused by a remote client holding the control lease)
 * is otherwise indistinguishable from a broken shortcut.
 */
export async function runWorkspaceClearFromUi(
  workspaceId: string,
): Promise<WorkspaceClearResult | null> {
  try {
    const result = await clearWorkspace(workspaceId);
    const summary = summarizeClearResult(result);
    if (isNoOpClearResult(result)) {
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
