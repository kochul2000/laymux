import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useTerminalStore } from "@/stores/terminal-store";
import { useSettingsStore } from "@/stores/settings-store";
import { useNotificationStore } from "@/stores/notification-store";
import { getAgentSessionStates } from "./tauri-api";
import { subscribeAgentSessionStates } from "./agent-session-subscription";
import { subscribeTerminalTasks } from "./terminal-task-subscription";
import { terminalTaskPolicy } from "./terminal-task";
vi.mock("./tauri-api", () => ({ getAgentSessionStates: vi.fn() }));
vi.mock("./persist-session", () => ({ persistSession: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/hooks/useOsNotification", () => ({
  sendDesktopNotification: vi.fn().mockResolvedValue(undefined),
}));
let stop: () => void;
const instance = () => useTerminalStore.getState().instances[0];
const hook = (turnId = "turn-1", sequence = 1) => ({
  generation: 7,
  provider: "grok" as const,
  sessionId: "grok-session",
  state: "running" as const,
  result: null,
  taskId: String(sequence),
  turnId,
  sequence,
  observedAtMs: Date.now(),
  configDir: "/home/u/.grok",
  distro: null,
});
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useTerminalStore.setState({ instances: [] });
  useNotificationStore.setState(useNotificationStore.getInitialState());
  useSettingsStore.setState({
    grok: { ...useSettingsStore.getState().grok, stateDetection: "hooks" },
  });
  const store = useTerminalStore.getState();
  store.registerInstance({ id: "g", profile: "ps", workspaceId: "ws", syncGroup: "ws" });
  store.updateInstanceInfo("g", {
    generation: 7,
    sessionReady: true,
    activity: { type: "interactiveApp", name: "Grok" },
  });
  store.observeAgentHook("g", hook());
  const stopTasks = subscribeTerminalTasks();
  const stopRecords = subscribeAgentSessionStates();
  stop = () => {
    stopTasks();
    stopRecords();
  };
});
afterEach(() => {
  stop();
  vi.useRealTimers();
});
it("Grok Stop 대기 중에는 현재 턴의 실제 완료 기록이 있어야 종료·성공을 표시한다", async () => {
  vi.mocked(getAgentSessionStates).mockResolvedValue({
    g: {
      generation: 7,
      sessionId: "grok-session",
      turnId: "turn-1",
      status: "ended",
      result: "success",
    },
  });
  expect(terminalTaskPolicy(instance()).clearAllowed).toBe(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(instance().taskDetectionSource).toBe("hooks");
  expect(instance().task).toMatchObject({ state: "ended", result: "success" });
  expect(terminalTaskPolicy(instance()).clearAllowed).toBe(true);
  await vi.advanceTimersByTimeAsync(2000);
  expect(useNotificationStore.getState().notifications.map((n) => n.message)).toEqual([
    "Grok: 종료 (성공)",
  ]);
});
it.each(["old-turn", undefined])(
  "다른 턴·턴 식별자 없음(%s)은 현재 작업을 완료시키지 않는다",
  async (turnId) => {
    vi.mocked(getAgentSessionStates).mockResolvedValue({
      g: { generation: 7, sessionId: "grok-session", turnId, status: "ended", result: "success" },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(instance().taskDetectionSource).toBe("hooks");
    expect(instance().task?.state).toBe("running");
    expect(terminalTaskPolicy(instance()).clearAllowed).toBe(false);
  },
);
it("같은 턴 기록이어도 다른 대화의 성공과 명시적 중단은 합치지 않는다", async () => {
  vi.mocked(getAgentSessionStates).mockResolvedValue({
    g: {
      generation: 7,
      sessionId: "other-session",
      turnId: "turn-1",
      status: "ended",
      result: "success",
    },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(instance().task?.state).toBe("running");
  useTerminalStore
    .getState()
    .observeAgentHook("g", { ...hook("turn-1", 2), state: "ended", result: "interrupted" });
  expect(instance().task?.result).toBe("interrupted");
});
it("완료 후 다음 턴의 시작은 지난 완료 알림을 다시 발행하지 않는다", async () => {
  vi.mocked(getAgentSessionStates).mockResolvedValue({
    g: {
      generation: 7,
      sessionId: "grok-session",
      turnId: "turn-1",
      status: "ended",
      result: "success",
    },
  });
  await vi.advanceTimersByTimeAsync(1000);
  useTerminalStore.getState().observeAgentHook("g", hook("turn-2", 2));
  expect(instance().task?.state).toBe("running");
  expect(useNotificationStore.getState().notifications).toHaveLength(1);
  vi.mocked(getAgentSessionStates).mockResolvedValue({
    g: {
      generation: 7,
      sessionId: "grok-session",
      turnId: "turn-2",
      status: "ended",
      result: "success",
    },
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(useNotificationStore.getState().notifications).toHaveLength(2);
});
