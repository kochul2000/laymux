import { invoke } from "@tauri-apps/api/core";

export type HookProvider = "claude" | "codex";
export interface HookStateSnapshot {
  generation: number;
  provider: HookProvider;
  sessionId: string;
  state: "idle" | "running" | "waiting" | "ended";
  result: "failure" | "interrupted" | null;
  taskId: string;
  sequence: number;
  observedAtMs: number;
  configDir: string | null;
  distro: string | null;
  bindingSource?: "process" | "title";
}
export const getAgentHookStates = (providers: HookProvider[]) =>
  invoke<Record<string, HookStateSnapshot>>("get_agent_hook_states", { providers });
export interface HookEnvironment {
  id: string;
  label: string;
  distro: string | null;
}
export interface HookStatus {
  configDir: string;
  configPath: string;
  installed: boolean;
  registered: number;
  expected: number;
  helperPresent: boolean;
  disabled: boolean;
  warning?: string | null;
  titleBinding?: { configured: boolean; managed: boolean; warning?: string | null } | null;
}
export interface HookConnection {
  terminalId: string;
  provider: HookProvider;
  sessionId: string;
  event: string;
  receivedAtMs: number;
  distro: string | null;
  configDir?: string | null;
}
export const listAgentHookEnvironments = () =>
  invoke<HookEnvironment[]>("list_agent_hook_environments");
export const getAgentHookConnections = () => invoke<HookConnection[]>("get_agent_hook_connections");
export function manageAgentHooks(
  provider: HookProvider,
  operation: "status" | "install" | "remove",
  distro: string | null,
  configDir: string | null,
) {
  return invoke<HookStatus>("manage_agent_hooks", {
    request: { provider, operation, distro, configDir },
  });
}
