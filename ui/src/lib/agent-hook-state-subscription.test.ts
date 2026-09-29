import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { getAgentHookStates, type HookStateSnapshot } from "./agent-hooks-api";
import { subscribeAgentHookStates } from "./agent-hook-state-subscription";
vi.mock("./agent-hooks-api", () => ({ getAgentHookStates: vi.fn() }));
const event: HookStateSnapshot = {
  generation: 3,
  provider: "codex",
  sessionId: "resumed",
  state: "running",
  result: null,
  taskId: "2",
  sequence: 1,
  observedAtMs: 0,
  configDir: "/tmp",
  distro: "Ubuntu",
};
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  vi.mocked(getAgentHookStates).mockReset();
  useSettingsStore.setState({
    codex: { ...useSettingsStore.getState().codex, stateDetection: "heuristic" },
    claude: { ...useSettingsStore.getState().claude, stateDetection: "heuristic" },
  });
  useTerminalStore.setState({ instances: [] });
  const store = useTerminalStore.getState();
  store.registerInstance({ id: "pane", profile: "WSL", workspaceId: "w", syncGroup: "w" });
  store.updateInstanceInfo("pane", {
    sessionReady: true,
    generation: 3,
    activity: { type: "interactiveApp", name: "Codex" },
  });
  store.observeTask("pane", { source: "heuristic", taskId: "0", sequence: 1, state: "idle" });
});
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
});
it("polls only opted-in providers and falls back on missing hooks or errors", async () => {
  vi.mocked(getAgentHookStates).mockResolvedValue({ pane: { ...event, observedAtMs: Date.now() } });
  stop = subscribeAgentHookStates();
  await vi.advanceTimersByTimeAsync(3000);
  expect(getAgentHookStates).not.toHaveBeenCalled();
  useSettingsStore.getState().setCodex({ stateDetection: "hooks" });
  await vi.advanceTimersByTimeAsync(0);
  expect(getAgentHookStates).toHaveBeenCalledWith(["codex"]);
  expect(useTerminalStore.getState().instances[0].taskDetectionSource).toBe("hooks");
  vi.mocked(getAgentHookStates).mockResolvedValue({});
  await vi.advanceTimersByTimeAsync(2000);
  expect(useTerminalStore.getState().instances[0].task?.state).toBe("idle");
  vi.mocked(getAgentHookStates).mockRejectedValue(Error("unavailable"));
  await vi.advanceTimersByTimeAsync(2000);
  expect(useTerminalStore.getState().instances[0].taskDetectionSource).toBe("heuristic");
});
it("rejects an in-flight result across a replaced PTY or a new input", async () => {
  let resolve!: (value: Record<string, HookStateSnapshot>) => void;
  vi.mocked(getAgentHookStates).mockImplementation(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  useSettingsStore.getState().setCodex({ stateDetection: "hooks" });
  stop = subscribeAgentHookStates();
  await vi.advanceTimersByTimeAsync(0);
  useTerminalStore.getState().updateInstanceInfo("pane", { generation: 4 });
  resolve({ pane: { ...event, observedAtMs: Date.now() } });
  await vi.advanceTimersByTimeAsync(0);
  expect(useTerminalStore.getState().instances[0].agentHook).toBeUndefined();
  await vi.advanceTimersByTimeAsync(2000);
  useTerminalStore.getState().updateInstanceInfo("pane", { lastUserInputAt: Date.now() });
  resolve({ pane: { ...event, generation: 4, observedAtMs: Date.now() } });
  await vi.advanceTimersByTimeAsync(0);
  expect(useTerminalStore.getState().instances[0].agentHook).toBeUndefined();
});
