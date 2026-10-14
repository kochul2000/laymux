import { create } from "zustand";
import {
  getAgentHookUpdates,
  manageAgentHooks,
  onAgentHookInspectionNeeded,
  type HookUpdateTarget,
  type HookUpdateError,
  type HookProvider,
  type HookStatus,
} from "./agent-hooks-api";

interface UpdateState {
  targets: HookUpdateTarget[];
  errors: HookUpdateError[];
  dismissed: string[];
  busyKey: string | null;
}
export const useAgentHookUpdateStore = create<UpdateState>(() => ({
  targets: [],
  errors: [],
  dismissed: [],
  busyKey: null,
}));
export const hookUpdateKey = (target: HookUpdateTarget) =>
  JSON.stringify([target.provider, target.distro, target.status.configDir]);
// Errors identify the checked environment, not a timeout's changing wording.
export const hookUpdateErrorKey = (error: HookUpdateError) =>
  JSON.stringify(["error", error.provider, error.distro, error.configDir]);
let pending: Promise<void> | undefined;
let pendingAutomatic = false;

async function audit(automatic = false) {
  try {
    const result = await getAgentHookUpdates(automatic);
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

export function manageAgentHooksAndRefresh(
  provider: HookProvider,
  operation: "install" | "remove" | "update",
  distro: string | null,
  configDir: string | null,
): Promise<HookStatus> {
  if (pending)
    return pending.then(() => manageAgentHooksAndRefresh(provider, operation, distro, configDir));
  const key = JSON.stringify([provider, distro, configDir]);
  useAgentHookUpdateStore.setState({ busyKey: key });
  const task = (async () => {
    try {
      const status = await manageAgentHooks(provider, operation, distro, configDir);
      const resolvedKey = JSON.stringify([provider, distro, status.configDir]);
      useAgentHookUpdateStore.setState((state) => ({
        targets: state.targets.map((value) =>
          hookUpdateKey(value) === resolvedKey ? { ...value, status } : value,
        ),
      }));
      await audit(true);
      return status;
    } catch (error) {
      useAgentHookUpdateStore.setState((state) => ({
        errors: [
          ...state.errors.filter(
            (e) => !(e.provider === provider && e.distro === distro && e.configDir === configDir),
          ),
          {
            provider,
            distro,
            configDir,
            message: String(error),
          },
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

export function dismissHookUpdateNotice() {
  useAgentHookUpdateStore.setState((state) => ({
    dismissed: [
      ...state.dismissed,
      ...state.targets
        .filter((t) => t.status.updateRequired || t.status.updateWarning)
        .map(hookUpdateKey),
      ...state.errors.map(hookUpdateErrorKey),
    ],
  }));
}

/** Startup and target discovery own automatic checks; focus/time do not. */
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
