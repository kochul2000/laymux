import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalStore } from "@/stores/terminal-store";
import type { HookStateSnapshot } from "./agent-hooks-api";
import { observeTaskTitle } from "./terminal-task-observers";

const snapshot = (provider: "claude" | "codex", sequence = 1): HookStateSnapshot => ({
  generation: 7,
  provider,
  sessionId: "same-conversation",
  state: "waiting",
  result: null,
  taskId: "1",
  sequence,
  observedAtMs: Date.now(),
  configDir: "/tmp/hooks",
  distro: null,
});
beforeEach(() => {
  vi.useFakeTimers();
  useSettingsStore.setState({
    claude: { ...useSettingsStore.getState().claude, stateDetection: "heuristic" },
    codex: { ...useSettingsStore.getState().codex, stateDetection: "heuristic" },
  });
  useTerminalStore.setState({ instances: [] });
  const store = useTerminalStore.getState();
  store.registerInstance({ id: "pane", profile: "test", workspaceId: "w", syncGroup: "w" });
  store.updateInstanceInfo("pane", {
    generation: 7,
    sessionReady: true,
    activity: { type: "interactiveApp", name: "Claude" },
  });
  store.observeTask("pane", { source: "heuristic", taskId: "1", sequence: 1, state: "running" });
});
afterEach(() => vi.useRealTimers());
describe.each(["claude", "codex"] as const)("%s hook selection", (provider) => {
  it("defaults to heuristics, selects hooks explicitly, and keeps the fallback current", () => {
    const store = useTerminalStore.getState();
    store.updateInstanceInfo("pane", {
      activity: { type: "interactiveApp", name: provider === "claude" ? "Claude" : "Codex" },
    });
    store.observeTask("pane", { source: "heuristic", taskId: "1", sequence: 1, state: "running" });
    store.observeAgentHook("pane", snapshot(provider));
    expect(useTerminalStore.getState().instances[0].task?.state).toBe("running");
    useSettingsStore.setState({
      [provider]: { ...useSettingsStore.getState()[provider], stateDetection: "hooks" },
    });
    store.refreshTaskDetection();
    expect(useTerminalStore.getState().instances[0].task?.state).toBe("waiting");
    store.observeTask("pane", {
      source: "heuristic",
      taskId: "1",
      sequence: 2,
      state: "ended",
      result: "success",
    });
    expect(useTerminalStore.getState().instances[0].task?.state).toBe("waiting");
    store.observeAgentHook("pane", undefined);
    expect(useTerminalStore.getState().instances[0].task?.state).toBe("ended");
    expect(useTerminalStore.getState().instances[0].taskDetectionSource).toBe("heuristic");
  });
});
it("drops replaced PTYs and expired verification without reviving a shell", () => {
  const store = useTerminalStore.getState();
  useSettingsStore.getState().setClaude({ stateDetection: "hooks" });
  store.observeAgentHook("pane", snapshot("claude"));
  expect(useTerminalStore.getState().instances[0].taskDetectionSource).toBe("hooks");
  vi.advanceTimersByTime(6001);
  store.refreshTaskDetection();
  expect(useTerminalStore.getState().instances[0].taskDetectionSource).toBe("heuristic");
  store.updateInstanceInfo("pane", { generation: 8, activity: { type: "shell", name: undefined } });
  store.observeAgentHook("pane", snapshot("claude", 2));
  expect(useTerminalStore.getState().instances[0].agentHook).toBeUndefined();
  expect(useTerminalStore.getState().instances[0].activity?.type).toBe("shell");
});

it("does not reapply the previous stop while the next user input awaits its hook", () => {
  const store = useTerminalStore.getState();
  useSettingsStore.getState().setClaude({ stateDetection: "hooks" });
  const previous = { ...snapshot("claude"), state: "ended" as const };
  store.observeAgentHook("pane", previous);
  vi.advanceTimersByTime(100);
  store.updateInstanceInfo("pane", { lastUserInputAt: Date.now() });
  store.observeAgentHook("pane", previous);
  expect(useTerminalStore.getState().instances[0].taskDetectionSource).toBe("heuristic");
  store.observeAgentHook("pane", { ...snapshot("claude", 2), taskId: "2", state: "running" });
  expect(useTerminalStore.getState().instances[0].taskDetectionSource).toBe("hooks");
  expect(useTerminalStore.getState().instances[0].task?.state).toBe("running");
});

it("keeps title detection independent when the first task came from a hook", () => {
  const store = useTerminalStore.getState();
  store.updateInstanceInfo("pane", { generation: 8 });
  useSettingsStore.getState().setClaude({ stateDetection: "hooks" });
  store.observeAgentHook("pane", { ...snapshot("claude"), generation: 8 });
  observeTaskTitle("pane", "✳ Claude Code");
  expect(useTerminalStore.getState().instances[0].task?.state).toBe("waiting");
  expect(useTerminalStore.getState().instances[0].heuristicTask?.state).toBe("idle");
  expect(useTerminalStore.getState().instances[0].heuristicTask?.source).not.toContain("hook:");
  store.observeAgentHook("pane", undefined);
  expect(useTerminalStore.getState().instances[0].task?.state).toBe("idle");
});
