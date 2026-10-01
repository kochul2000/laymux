import { create } from "zustand";
import {
  getAgentHookUpdates,
  manageAgentHooks,
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
let pending: Promise<void> | undefined;

async function audit() {
  try {
    const result = await getAgentHookUpdates();
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

export function refreshAgentHookUpdates(): Promise<void> {
  if (pending) return pending;
  pending = audit().finally(() => {
    pending = undefined;
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
      await audit();
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
      ...state.errors.map((e) => JSON.stringify(e)),
    ],
  }));
}

/** One mounted app owns the timer; concurrent checks share the same promise. */
export function subscribeAgentHookUpdates() {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function poll() {
    await refreshAgentHookUpdates();
    if (!disposed) timer = setTimeout(() => void poll(), 60_000);
  }
  const focus = () => {
    void refreshAgentHookUpdates();
  };
  window.addEventListener("focus", focus);
  void poll();
  return () => {
    disposed = true;
    clearTimeout(timer);
    window.removeEventListener("focus", focus);
  };
}
