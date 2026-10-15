import { create } from "zustand";
import {
  getAgentHookUpdates,
  manageAgentHooks,
  manageAgentMcp,
  onAgentHookInspectionNeeded,
  type HookMissingTarget,
  type HookUpdateTarget,
  type HookUpdateError,
  type HookProvider,
  type HookStatus,
  type McpProvider,
  type McpStatus,
} from "./agent-hooks-api";
import { useSettingsStore } from "@/stores/settings-store";

interface UpdateState {
  targets: HookUpdateTarget[];
  errors: HookUpdateError[];
  missing: HookMissingTarget[];
  dismissed: string[];
  busyKey: string | null;
}
export const useAgentHookUpdateStore = create<UpdateState>(() => ({
  targets: [],
  errors: [],
  missing: [],
  dismissed: [],
  busyKey: null,
}));
export const hookUpdateKey = (target: HookUpdateTarget) =>
  JSON.stringify([target.provider, target.distro, target.status.configDir]);
// Errors identify the checked environment, not a timeout's changing wording.
export const hookUpdateErrorKey = (error: HookUpdateError) =>
  JSON.stringify(["error", error.provider, error.distro, error.configDir]);
// A later-arriving MCP result for the same environment is a new notice.
export const hookMissingKey = (target: HookMissingTarget) =>
  JSON.stringify(["missing", target.provider, target.distro, target.hook, target.mcp]);
/** Display preference only; the backend reports the same judgment either way (ADR-0330). */
export const missingNoticeEnabled = () =>
  useSettingsStore.getState().notifications.agentIntegrationMissing !== false;
let pending: Promise<void> | undefined;
let pendingAutomatic = false;

async function audit(automatic = false) {
  try {
    const result = await getAgentHookUpdates(automatic, missingNoticeEnabled());
    const checked = new Set(result.targets.map(hookUpdateKey));
    useAgentHookUpdateStore.setState((state) => ({
      targets: [
        ...result.targets,
        ...state.targets.filter(
          (target) =>
            !checked.has(hookUpdateKey(target)) &&
            result.errors.some(
              (error) =>
                error.provider === null ||
                (error.provider === target.provider &&
                  error.distro === target.distro &&
                  (error.configDir === null || error.configDir === target.status.configDir)),
            ),
        ),
      ],
      errors: result.errors,
      missing: result.missing ?? [],
    }));
  } catch (error) {
    // Keep known updates while reporting that the latest check failed.
    useAgentHookUpdateStore.setState({
      errors: [{ provider: null, distro: null, configDir: null, message: String(error) }],
    });
  }
}

export function refreshAgentHookUpdates(automatic = false): Promise<void> {
  if (pending) {
    // Discovery can arrive after the in-flight task captured its target list.
    // Follow it with a cached check so that first notification is not lost.
    if (automatic) return pending.then(() => refreshAgentHookUpdates(true));
    if (!automatic && pendingAutomatic) return pending.then(() => refreshAgentHookUpdates());
    return pending;
  }
  pendingAutomatic = automatic;
  pending = audit(automatic).finally(() => {
    pending = undefined;
    pendingAutomatic = false;
  });
  return pending;
}

/**
 * One queue for every hook and MCP change from the notice and Settings, so two
 * Laymux writers never race for the same configuration folder lock (ADR-0325,
 * ADR-0330). A failure is reported against `target` unless the caller shows it.
 */
function manageAndRefresh<T>(
  key: string,
  target: Pick<HookUpdateError, "provider" | "distro" | "configDir"> | null,
  change: () => Promise<T>,
  applied: (value: T) => void = () => {},
): Promise<T> {
  if (pending) return pending.then(() => manageAndRefresh(key, target, change, applied));
  useAgentHookUpdateStore.setState({ busyKey: key });
  const task = (async () => {
    try {
      const value = await change();
      applied(value);
      await audit(true);
      return value;
    } catch (error) {
      if (!target) throw error;
      useAgentHookUpdateStore.setState((state) => ({
        errors: [
          ...state.errors.filter(
            (e) =>
              !(
                e.provider === target.provider &&
                e.distro === target.distro &&
                e.configDir === target.configDir
              ),
          ),
          { ...target, message: String(error) },
        ],
      }));
      throw error;
    } finally {
      useAgentHookUpdateStore.setState({ busyKey: null });
    }
  })();
  pending = task
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      pending = undefined;
    });
  return task;
}

export function manageAgentHooksAndRefresh(
  provider: HookProvider,
  operation: "install" | "remove" | "update",
  distro: string | null,
  configDir: string | null,
): Promise<HookStatus> {
  return manageAndRefresh(
    JSON.stringify([provider, distro, configDir]),
    { provider, distro, configDir },
    () => manageAgentHooks(provider, operation, distro, configDir),
    (status) => {
      const resolvedKey = JSON.stringify([provider, distro, status.configDir]);
      useAgentHookUpdateStore.setState((state) => ({
        targets: state.targets.map((value) =>
          hookUpdateKey(value) === resolvedKey ? { ...value, status } : value,
        ),
      }));
    },
  );
}

/** Settings shows its own MCP errors; the notice passes the target to report. */
export function manageAgentMcpAndRefresh(
  provider: McpProvider,
  operation: "install" | "remove",
  distro: string | null,
  configDir: string | null,
  report: HookProvider | null = null,
): Promise<McpStatus> {
  return manageAndRefresh(
    JSON.stringify(["mcp", provider, distro, configDir]),
    report && { provider: report, distro, configDir },
    () => manageAgentMcp(provider, operation, distro, configDir),
  );
}

export function updateAgentHooks(target: HookUpdateTarget): Promise<void> {
  return manageAgentHooksAndRefresh(
    target.provider,
    "update",
    target.distro,
    target.status.configDir,
  ).then(
    () => undefined,
    () => undefined,
  );
}

export const missingInstallKey = (target: HookMissingTarget, integration: "hook" | "mcp") =>
  integration === "hook"
    ? JSON.stringify([target.provider, target.distro, null])
    : JSON.stringify(["mcp", target.provider, target.distro, null]);

/** Install into the default folder of a used environment, only on user action. */
export function installMissingIntegration(
  target: HookMissingTarget,
  integration: "hook" | "mcp",
): Promise<void> {
  const change =
    integration === "hook"
      ? manageAgentHooksAndRefresh(target.provider, "install", target.distro, null)
      : manageAgentMcpAndRefresh(target.provider, "install", target.distro, null, target.provider);
  return change.then(
    () => undefined,
    () => undefined,
  );
}

export function dismissHookUpdateNotice() {
  useAgentHookUpdateStore.setState((state) => ({
    dismissed: [
      ...state.dismissed,
      ...state.targets
        .filter((t) => t.status.updateRequired || t.status.updateWarning)
        .map(hookUpdateKey),
      ...state.errors.map(hookUpdateErrorKey),
      ...state.missing.map(hookMissingKey),
    ],
  }));
}

/** Startup and backend hints (target discovery, first Claude/Codex sighting,
 *  management) own automatic checks; focus/time do not. */
export function subscribeAgentHookUpdates() {
  let disposed = false;
  let checking = false;
  let dirty = false;
  async function check() {
    if (disposed) return;
    dirty = true;
    if (checking) return;
    checking = true;
    try {
      do {
        dirty = false;
        await refreshAgentHookUpdates(true);
      } while (dirty && !disposed);
    } finally {
      checking = false;
    }
  }
  const subscription = onAgentHookInspectionNeeded(() => {
    void check();
  });
  void subscription.then(() => check()).catch(() => check());
  return () => {
    disposed = true;
    void subscription.then((stop) => stop()).catch(() => undefined);
  };
}
