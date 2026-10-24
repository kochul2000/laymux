import { invoke } from "@tauri-apps/api/core";

export interface AgentClearInputStamp {
  generation: number;
  inputRevision: number;
}

export const beginAgentClear = (id: string, generation: number, remoteLeaseId?: string) =>
  invoke<AgentClearInputStamp>("begin_agent_clear", { id, generation, remoteLeaseId });

export const agentClearInput = (
  id: string,
  expected: AgentClearInputStamp,
  step: "deleteDraft" | "submitClear",
  remainingMs: number,
  remoteLeaseId?: string,
) =>
  invoke<AgentClearInputStamp>("agent_clear_input", {
    id,
    expected,
    step,
    remainingMs,
    remoteLeaseId,
  });
