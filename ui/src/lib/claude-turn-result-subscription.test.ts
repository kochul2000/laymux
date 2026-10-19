import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginClaudeTurns,
  getClaudeTurnResults,
  type ClaudeTurnOutcome,
  type ClaudeTurnRequest,
} from "./tauri-api";
import { subscribeClaudeTurnResults } from "./claude-turn-result-subscription";
import { subscribeTerminalTasks } from "./terminal-task-subscription";
import { observeTaskTitle } from "./terminal-task-observers";
import { useTerminalStore } from "@/stores/terminal-store";
import { useNotificationStore } from "@/stores/notification-store";
import { useSettingsStore } from "@/stores/settings-store";
import type { HookStateSnapshot } from "./agent-hooks-api";

vi.mock("./tauri-api", () => ({ beginClaudeTurns: vi.fn(), getClaudeTurnResults: vi.fn() }));
vi.mock("./persist-session", () => ({ persistSession: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/hooks/useOsNotification", () => ({
  sendDesktopNotification: vi.fn().mockResolvedValue(undefined),
}));

let stop: (() => void) | undefined;
let stopTasks: () => void;
const instance = () => useTerminalStore.getState().instances[0];
const messages = () => useNotificationStore.getState().notifications.map((entry) => entry.message);
const begun = () => vi.mocked(beginClaudeTurns).mock.calls.flatMap(([requests]) => requests);
const reads = () => vi.mocked(getClaudeTurnResults).mock.calls.length;

function recordAll() {
  vi.mocked(beginClaudeTurns).mockImplementation(async (requests) => requests);
}
function outcome(value: ClaudeTurnOutcome) {
  vi.mocked(getClaudeTurnResults).mockImplementation(async (requests: ClaudeTurnRequest[]) =>
    requests.map((request) => ({ ...request, outcome: value })),
  );
}
async function tick(ms = 1000) {
  await vi.advanceTimersByTimeAsync(ms);
}
function hook(
  state: HookStateSnapshot["state"],
  sequence: number,
  taskId = "1",
): HookStateSnapshot {
  return {
    generation: 1,
    provider: "claude",
    sessionId: "session",
    state,
    result: null,
    taskId,
    sequence,
    observedAtMs: Date.now(),
    configDir: null,
    distro: null,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useSettingsStore.setState({
    claude: { ...useSettingsStore.getState().claude, stateDetection: "heuristic" },
  });
  useTerminalStore.setState(useTerminalStore.getInitialState());
  useNotificationStore.setState(useNotificationStore.getInitialState());
  stopTasks = subscribeTerminalTasks();
  const store = useTerminalStore.getState();
  store.registerInstance({ id: "pane", workspaceId: "ws", profile: "ps", syncGroup: "s" });
  store.updateInstanceInfo("pane", {
    sessionReady: true,
    generation: 1,
    activity: { type: "interactiveApp", name: "Claude" },
  });
  recordAll();
  outcome("pending");
});
afterEach(() => {
  stop?.();
  stopTasks();
  stop = undefined;
  vi.useRealTimers();
});

describe("Claude transcript turn results (ADR-0340)", () => {
  it("시작한 작업의 기준점을 잡고 종료 뒤 대화 기록의 성공을 채운다", async () => {
    stop = subscribeClaudeTurnResults();
    observeTaskTitle("pane", "✶ Working");
    await tick(0);
    expect(begun()).toHaveLength(1);
    observeTaskTitle("pane", "✳ Claude Code");
    expect(instance().task?.state).toBe("ended");
    // The result is still being read, so the notification names no result.
    expect(messages()).toEqual(["Claude: 종료"]);
    outcome("success");
    await tick();
    expect(instance().task?.result).toBe("success");
    // A late result updates the display only.
    expect(messages()).toEqual(["Claude: 종료"]);
    const calls = reads();
    await tick(3000);
    expect(reads()).toBe(calls);
  });

  it("기준점을 잡지 못한 작업은 결과 미관측으로 알리고 조회하지 않는다", async () => {
    vi.mocked(beginClaudeTurns).mockResolvedValue([]);
    stop = subscribeClaudeTurnResults();
    observeTaskTitle("pane", "✶ Working");
    await tick(0);
    observeTaskTitle("pane", "✳ Claude Code");
    await tick(2000);
    expect(messages()).toEqual(["Claude: 종료 (결과 미관측)"]);
    expect(reads()).toBe(0);
    expect(instance().task?.result).toBeUndefined();
  });

  it("중단과 실패도 같은 경로로 채운다", async () => {
    stop = subscribeClaudeTurnResults();
    outcome("interrupted");
    observeTaskTitle("pane", "✶ Working");
    await tick(0);
    observeTaskTitle("pane", "✳ Claude Code");
    await tick();
    expect(instance().task?.result).toBe("interrupted");

    outcome("failure");
    observeTaskTitle("pane", "✶ Again");
    await tick(0);
    expect(instance().task?.result).toBeUndefined();
    observeTaskTitle("pane", "✳ Claude Code");
    await tick();
    expect(instance().task?.result).toBe("failure");
    expect(begun()).toHaveLength(2);
  });

  it("unknown이면 결과 없이 조회를 멈춘다", async () => {
    stop = subscribeClaudeTurnResults();
    outcome("unknown");
    observeTaskTitle("pane", "✶ Working");
    await tick(0);
    observeTaskTitle("pane", "✳ Claude Code");
    await tick();
    const calls = reads();
    await tick(3000);
    expect(reads()).toBe(calls);
    expect(instance().task?.result).toBeUndefined();
  });

  it("종료 후 10초 안에 기록되지 않으면 포기한다", async () => {
    stop = subscribeClaudeTurnResults();
    observeTaskTitle("pane", "✶ Working");
    await tick(0);
    observeTaskTitle("pane", "✳ Claude Code");
    await tick(12_000);
    const calls = reads();
    expect(calls).toBeGreaterThan(5);
    await tick(5000);
    expect(reads()).toBe(calls);
    expect(instance().claudeTurns?.heuristic?.settled).toBe(true);
  });

  it("조회 중 새 입력이 오면 그 응답을 버린다", async () => {
    stop = subscribeClaudeTurnResults();
    observeTaskTitle("pane", "✶ Working");
    await tick(0);
    observeTaskTitle("pane", "✳ Claude Code");
    let resolve: (value: Awaited<ReturnType<typeof getClaudeTurnResults>>) => void = () => {};
    vi.mocked(getClaudeTurnResults).mockImplementationOnce(
      () => new Promise((next) => (resolve = next)),
    );
    await tick();
    useTerminalStore.getState().updateInstanceInfo("pane", { lastUserInputAt: Date.now() });
    const key = instance().claudeTurns?.heuristic?.key ?? "";
    resolve([{ terminalId: "pane", key, outcome: "success" }]);
    await tick(0);
    expect(instance().task?.result).toBeUndefined();
  });

  it("훅 모드에서는 표시 중인 훅 작업에 결과를 붙이고, 휴리스틱으로 넘어가도 유지한다", async () => {
    useSettingsStore.setState({
      claude: { ...useSettingsStore.getState().claude, stateDetection: "hooks" },
    });
    stop = subscribeClaudeTurnResults();
    const store = useTerminalStore.getState();
    observeTaskTitle("pane", "✶ Working");
    store.observeAgentHook("pane", hook("running", 1));
    await tick(0);
    expect(instance().taskDetectionSource).toBe("hooks");
    // Each source's task gets its own baseline.
    expect(begun().map(({ key }) => key.split("\u0000")[0])).toEqual(
      expect.arrayContaining(["hook:1:claude:session"]),
    );
    expect(begun()).toHaveLength(2);
    store.observeAgentHook("pane", hook("ended", 2));
    observeTaskTitle("pane", "✳ Claude Code");
    outcome("success");
    await tick();
    expect(instance().taskDetectionSource).toBe("hooks");
    expect(instance().task?.result).toBe("success");
    // The hook observation expires; the heuristic task carries its own result.
    store.observeAgentHook("pane", undefined);
    expect(instance().taskDetectionSource).toBe("heuristic");
    expect(instance().task?.result).toBe("success");
  });

  it("이미 결과가 있는 종료(StopFailure)는 덮지도 조회하지도 않는다", async () => {
    useSettingsStore.setState({
      claude: { ...useSettingsStore.getState().claude, stateDetection: "hooks" },
    });
    stop = subscribeClaudeTurnResults();
    const store = useTerminalStore.getState();
    store.observeAgentHook("pane", hook("running", 1));
    await tick(0);
    store.observeAgentHook("pane", { ...hook("ended", 2), result: "failure" });
    outcome("success");
    await tick(2000);
    expect(instance().task?.result).toBe("failure");
    expect(reads()).toBe(0);
  });

  it("기준점 응답 전에 구독이 다시 시작돼도 같은 키로 다시 물어 결과를 채운다", async () => {
    let answer: (value: ClaudeTurnRequest[]) => void = () => {};
    vi.mocked(beginClaudeTurns).mockImplementationOnce(
      () => new Promise((next) => (answer = next)),
    );
    stop = subscribeClaudeTurnResults();
    observeTaskTitle("pane", "✶ Working");
    await tick(0);
    const [first] = begun();
    stop();
    // The backend keeps the first baseline for a repeated key.
    stop = subscribeClaudeTurnResults();
    await tick(0);
    expect(begun()).toEqual([first, first]);
    answer([first]);
    observeTaskTitle("pane", "✳ Claude Code");
    outcome("success");
    await tick();
    expect(instance().task?.result).toBe("success");
  });

  it("반복 종료 관측으로 첫 응답을 버려도 다음 조회에서 결과를 채운다", async () => {
    stop = subscribeClaudeTurnResults();
    observeTaskTitle("pane", "✶ Working");
    await tick(0);
    observeTaskTitle("pane", "✳ Claude Code");
    let answer: (value: Awaited<ReturnType<typeof getClaudeTurnResults>>) => void = () => {};
    vi.mocked(getClaudeTurnResults).mockImplementationOnce(
      () => new Promise((next) => (answer = next)),
    );
    await tick();
    // The same task observed again: its sequence moves, so the read is stale.
    observeTaskTitle("pane", "✳ Claude Code");
    const key = instance().claudeTurns?.heuristic?.key ?? "";
    answer([{ terminalId: "pane", key, outcome: "success" }]);
    await tick(0);
    expect(instance().task?.result).toBeUndefined();
    outcome("success");
    await tick();
    expect(instance().task?.result).toBe("success");
  });

  it("기준점 응답이 끝내 없으면 종료 후 10초에 포기한다", async () => {
    vi.mocked(beginClaudeTurns).mockImplementation(() => new Promise(() => {}));
    stop = subscribeClaudeTurnResults();
    observeTaskTitle("pane", "✶ Working");
    await tick(0);
    observeTaskTitle("pane", "✳ Claude Code");
    await tick(12_000);
    expect(instance().claudeTurns?.heuristic?.settled).toBe(true);
    expect(reads()).toBe(0);
  });

  it("Claude가 아닌 pane은 대상이 아니다", async () => {
    useTerminalStore.getState().updateInstanceInfo("pane", {
      activity: { type: "interactiveApp", name: "Codex" },
    });
    stop = subscribeClaudeTurnResults();
    useTerminalStore
      .getState()
      .observeTask("pane", { source: "codex", taskId: "1", sequence: 1, state: "running" });
    await tick(2000);
    expect(begun()).toHaveLength(0);
  });
});
