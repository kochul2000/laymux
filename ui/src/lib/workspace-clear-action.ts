import {
  clearWorkspace,
  isNoOpClearResult,
  summarizeClearResult,
  type WorkspaceClearResult,
} from "./workspace-clear";

/**
 * The desktop UI's entry into the workspace clear (ADR-0113).
 *
 * Every UI entry point (both the Ctrl+Alt+L shortcut and the WorkspaceSelectorView
 * row button) goes through here so the outcome is reported the same way. Unlike
 * the Automation path there is no response to inspect, so a no-op run (nothing
 * to clear, or every write refused by a remote client holding the control lease)
 * is otherwise indistinguishable from a broken shortcut.
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
  return reportClear("workspace clear", workspaceId, () => clearWorkspace(workspaceId));
}
