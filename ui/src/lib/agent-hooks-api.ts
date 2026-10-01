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
  helperCurrent?: boolean | null;
  currentRegistered?: number;
  updateRequired?: boolean;
  updateReasons?: ("helper_missing" | "helper_outdated" | "registrations")[];
  updateWarning?: string | null;
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
  operation: "status" | "install" | "remove" | "update",
  distro: string | null,
  configDir: string | null,
) {
  return invoke<HookStatus>("manage_agent_hooks", {
    request: { provider, operation, distro, configDir },
  });
}

export interface HookUpdateTarget {
  provider: HookProvider;
  distro: string | null;
  status: HookStatus;
}
export interface HookUpdateError {
  provider: HookProvider | null;
  distro: string | null;
  configDir: string | null;
  message: string;
}
export const getAgentHookUpdates = () =>
  invoke<{ targets: HookUpdateTarget[]; errors: HookUpdateError[] }>("get_agent_hook_updates");
