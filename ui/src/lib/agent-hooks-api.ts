import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

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
  ownedCommands?: number;
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
/** A used environment's default folder without Laymux hooks or MCP (ADR-0330). */
export interface HookMissingTarget {
  provider: HookProvider;
  distro: string | null;
  hook: boolean;
  mcp: boolean;
}
export interface HookUpdates {
  targets: HookUpdateTarget[];
  errors: HookUpdateError[];
  missing?: HookMissingTarget[];
}
/** `missingNotice: false` skips the notice-only MCP checks of used environments. */
export const getAgentHookUpdates = (automatic = false, missingNotice = true) =>
  invoke<HookUpdates>("get_agent_hook_updates", { automatic, missingNotice });
export const onAgentHookInspectionNeeded = (handler: () => void) =>
  listen("agent-hook-inspection-needed", handler);

export type McpProvider = "claude" | "codex" | "grok";
export interface McpStatus {
  provider: McpProvider;
  configPath: string;
  name: string;
  /** Address reachable from the environment; null when Laymux is unreachable (WSL). */
  url: string | null;
  currentUrl: string | null;
  /** `unverified`: registered, but Laymux is unreachable so the address cannot be judged. */
  state: "missing" | "installed" | "different" | "unverified";
  installed: boolean;
  disabled: boolean;
  reachable: boolean;
}
/** A `cached` status answers from this app run's check (ADR-0325); refresh and
 *  management always read the CLI configuration again. */
export const manageAgentMcp = (
  provider: McpProvider,
  operation: "status" | "install" | "remove",
  distro: string | null,
  configDir: string | null = null,
  cached = false,
) =>
  invoke<McpStatus>("manage_agent_mcp", {
    request: { provider, operation, distro, configDir, cached },
  });
