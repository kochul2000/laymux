import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAgentSessionStates, type AgentSessionState } from "./tauri-api";
import { subscribeTerminalTasks } from "./terminal-task-subscription";
import { observeTaskInput, observeTaskTitle } from "./terminal-task-observers";
import { subscribeAgentSessionStates } from "./agent-session-subscription";
import { terminalTaskPolicy } from "./terminal-task";
import { useTerminalStore } from "@/stores/terminal-store";
import { useNotificationStore } from "@/stores/notification-store";
import { requestTaskStateRefresh } from "./task-state-refresh";

vi.mock("./tauri-api", () => ({ getAgentSessionStates: vi.fn() }));
vi.mock("./persist-session", () => ({ persistSession: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/hooks/useOsNotification", () => ({
  sendDesktopNotification: vi.fn().mockResolvedValue(undefined),
}));

const record = (
  status: AgentSessionState["status"],
  result?: AgentSessionState["result"],
): AgentSessionState => ({ generation: 1, sessionId: "session", status, result });
let stop: (() => void) | undefined;
let stopTasks: () => void;
const instance = () => useTerminalStore.getState().instances[0];
const notifications = () => useNotificationStore.getState().notifications;
const reads = () => vi.mocked(getAgentSessionStates).mock.calls.length;
const recorded = (state: AgentSessionState) =>
  vi.mocked(getAgentSessionStates).mockResolvedValue({ pane: state });
async function tick() {
  await vi.advanceTimersByTimeAsync(1000);
}

function agent(name: "Claude" | "Grok") {
  useTerminalStore.getState().updateInstanceInfo("pane", {
    sessionReady: true,
    generation: 1,
    activity: { type: "interactiveApp", name },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  stopTasks = subscribeTerminalTasks();
  vi.clearAllMocks();
  useTerminalStore.setState(useTerminalStore.getInitialState());
  useNotificationStore.setState(useNotificationStore.getInitialState());
  useTerminalStore
    .getState()
    .registerInstance({ id: "pane", workspaceId: "ws", profile: "ps", syncGroup: "s" });
});
afterEach(() => {
  stop?.();
  stopTasks();
  stop = undefined;
  vi.useRealTimers();
});

describe("agent session record observation", () => {
  it.each(["removed", "shell", "not-ready"])(
    "재확인 대상이 %s이면 다른 pane의 정상 1초 조회를 유지한다",
    async (mode) => {
      agent("Claude");
      useTerminalStore
        .getState()
        .registerInstance({ id: "other", workspaceId: "ws", profile: "ps", syncGroup: "s" });
      useTerminalStore.getState().updateInstanceInfo("other", {
        sessionReady: true,
        generation: 1,
        activity: { type: "interactiveApp", name: "Claude" },
      });
      let resolve!: (value: Record<string, AgentSessionState>) => void;
      vi.mocked(getAgentSessionStates).mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolve = r;
          }),
      );
      vi.mocked(getAgentSessionStates).mockResolvedValue({ other: record("idle") });
      stop = subscribeAgentSessionStates();
      await vi.advanceTimersByTimeAsync(0);
      requestTaskStateRefresh(["pane"]);
      if (mode === "removed") useTerminalStore.getState().unregisterInstance("pane");
      if (mode === "shell")
        useTerminalStore.getState().updateInstanceInfo("pane", { activity: { type: "shell" } });
      if (mode === "not-ready")
        useTerminalStore.getState().updateInstanceInfo("pane", { sessionReady: false });
      resolve({ other: record("idle") });
      await vi.advanceTimersByTimeAsync(10);
      expect(reads()).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(reads()).toBe(2);
    },
  );

  it("진입 폴백도 입력 대화상자의 대기를 해제하지 않는다", async () => {
    agent("Claude");
    observeTaskInput("pane", true);
    recorded(record("idle"));
    stop = subscribeAgentSessionStates();
    await tick();
    requestTaskStateRefresh(["pane"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(instance().task?.state).toBe("waiting");
    expect(terminalTaskPolicy(instance()).clearAllowed).toBe(false);
  });

  it("진입 폴백은 title 확정 뒤 멈췄던 조회를 즉시 깨워 기록으로 정상화한다", async () => {
    agent("Claude");
    observeTaskTitle("pane", "✳ Claude Code");
    recorded(record("running"));
    stop = subscribeAgentSessionStates();
    await tick();
    expect(reads()).toBe(0);
    requestTaskStateRefresh(["pane"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(1);
    expect(instance().task).toMatchObject({ state: "running", observation: "confirmed" });
  });

  it("조회 중 들어온 진입 폴백은 겹치지 않고 끝난 직후 다시 읽는다", async () => {
    agent("Claude");
    let resolve!: (value: Record<string, AgentSessionState>) => void;
    vi.mocked(getAgentSessionStates).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    recorded(record("idle"));
    stop = subscribeAgentSessionStates();
    await vi.advanceTimersByTimeAsync(0);
    requestTaskStateRefresh(["pane"]);
    expect(reads()).toBe(1);
    resolve({ pane: record("running") });
    await vi.advanceTimersByTimeAsync(1);
    expect(reads()).toBe(2);
    expect(instance().task?.state).toBe("ended");
  });

  it("상태를 모르는 Claude는 세션 기록의 대기로 확정해 clear를 허용한다", async () => {
    agent("Claude");
    recorded(record("idle"));
    stop = subscribeAgentSessionStates();
    await tick();
    expect(getAgentSessionStates).toHaveBeenCalledWith(["pane"], []);
    expect(instance().task).toMatchObject({ state: "idle", observation: "confirmed" });
    expect(terminalTaskPolicy(instance()).clearAllowed).toBe(true);
    expect(notifications()).toHaveLength(0);
  });

  it("title이 확정한 상태에는 세션 기록을 읽지 않는다", async () => {
    agent("Claude");
    observeTaskTitle("pane", "✳ Claude Code");
    recorded(record("running"));
    stop = subscribeAgentSessionStates();
    await tick();
    await tick();
    expect(reads()).toBe(0);
    expect(instance().task).toMatchObject({ state: "idle", observation: "confirmed" });
  });

  it("Grok 턴 끝은 title이 알리지 않으므로 기록의 완료로 끝내고 알린다", async () => {
    agent("Grok");
    observeTaskTitle("pane", "⠋ - Run tests - grok");
    recorded(record("running"));
    stop = subscribeAgentSessionStates();
    await tick();
    expect(reads()).toBe(0);
    observeTaskTitle("pane", "Run tests - grok");
    expect(instance().task).toMatchObject({ state: "running", observation: "stale" });
    recorded(record("ended", "success"));
    await tick();
    expect(instance().task).toMatchObject({
      state: "ended",
      result: "success",
      observation: "confirmed",
    });
    expect(notifications().map((entry) => entry.message)).toEqual(["Grok: 종료 (성공)"]);
  });

  it("기록이 맡은 상태는 다음 기록을 따르고, title이 오면 title에 넘긴다", async () => {
    agent("Grok");
    recorded(record("ended", "interrupted"));
    stop = subscribeAgentSessionStates();
    await tick();
    expect(instance().task).toMatchObject({ state: "ended", result: "interrupted" });
    expect(notifications()).toHaveLength(0);

    recorded(record("running"));
    await tick();
    const running = instance().task;
    expect(running).toMatchObject({ state: "running", observation: "confirmed" });

    recorded(record("running"));
    await tick();
    expect(instance().task?.sequence).toBe(running?.sequence);

    observeTaskTitle("pane", "⠋ - Run tests - grok");
    const calls = reads();
    await tick();
    expect(reads()).toBe(calls);
  });

  it("Claude 기록의 대기는 직전 작업을 끝낸다", async () => {
    agent("Claude");
    observeTaskTitle("pane", "◐ Claude Code");
    await vi.advanceTimersByTimeAsync(7000);
    expect(instance().task).toMatchObject({ state: "running", observation: "stale" });
    recorded(record("idle"));
    stop = subscribeAgentSessionStates();
    await tick();
    expect(instance().task).toMatchObject({ state: "ended", observation: "confirmed" });
  });

  it("기록의 입력 대기는 상태로 쓰지 않는다", async () => {
    agent("Claude");
    recorded(record("waiting"));
    stop = subscribeAgentSessionStates();
    await tick();
    expect(instance().task).toBeUndefined();
    expect(terminalTaskPolicy(instance()).clearAllowed).toBe(false);
  });

  it("읽는 동안 입력이 들어오면 그 읽기를 버린다", async () => {
    agent("Claude");
    let resolve!: (value: Record<string, AgentSessionState>) => void;
    vi.mocked(getAgentSessionStates).mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    stop = subscribeAgentSessionStates();
    await vi.advanceTimersByTimeAsync(0);
    expect(reads()).toBe(1);
    useTerminalStore.getState().updateInstanceInfo("pane", { lastUserInputAt: Date.now() });
    resolve({ pane: record("idle") });
    await vi.advanceTimersByTimeAsync(0);
    expect(instance().task).toBeUndefined();
  });

  it("다른 PTY 세대의 기록은 쓰지 않는다", async () => {
    agent("Claude");
    recorded({ ...record("idle"), generation: 2 });
    stop = subscribeAgentSessionStates();
    await tick();
    expect(instance().task).toBeUndefined();
  });

  it("Codex와 셸은 대상이 아니다", async () => {
    useTerminalStore.getState().updateInstanceInfo("pane", {
      sessionReady: true,
      activity: { type: "interactiveApp", name: "Codex" },
    });
    recorded(record("idle"));
    stop = subscribeAgentSessionStates();
    await tick();
    expect(reads()).toBe(0);
  });
});
