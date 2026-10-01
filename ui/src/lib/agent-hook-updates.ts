import { create } from "zustand";
import {
  getAgentHookUpdates,
  manageAgentHooks,
  type HookUpdateTarget,
  type HookUpdateError,
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

export function updateAgentHooks(target: HookUpdateTarget): Promise<void> {
  if (pending) return pending.then(() => updateAgentHooks(target));
  const key = hookUpdateKey(target);
  useAgentHookUpdateStore.setState({ busyKey: key });
  pending = (async () => {
    try {
      const status = await manageAgentHooks(
        target.provider,
        "update",
        target.distro,
        target.status.configDir,
      );
      useAgentHookUpdateStore.setState((state) => ({
        targets: state.targets.map((value) =>
          hookUpdateKey(value) === key ? { ...value, status } : value,
        ),
      }));
      await audit();
    } catch (error) {
      useAgentHookUpdateStore.setState((state) => ({
        errors: [
          ...state.errors.filter(
            (e) =>
              !(
                e.provider === target.provider &&
                e.distro === target.distro &&
                e.configDir === target.status.configDir
              ),
          ),
          {
            provider: target.provider,
            distro: target.distro,
            configDir: target.status.configDir,
            message: String(error),
          },
        ],
      }));
    } finally {
      useAgentHookUpdateStore.setState({ busyKey: null });
    }
  })().finally(() => {
    pending = undefined;
  });
  return pending;
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
