import { invoke } from "@tauri-apps/api/core";
import type { TerminalAttributionCoverage } from "./settings-snapshot";

// A failed optimization must leave the normal checkpoint path available.
export async function captureSessionReceipt(): Promise<string | undefined> {
  return (
    (await invoke<string | null>("capture_session_checkpoint_receipt").catch(() => null)) ??
    undefined
  );
}
export async function commitSessionReceipt(
  token: string,
  coverage: readonly TerminalAttributionCoverage[],
): Promise<string | undefined> {
  return (
    (await invoke<string | null>("commit_session_checkpoint_receipt", { token, coverage }).catch(
      () => null,
    )) ?? undefined
  );
}
