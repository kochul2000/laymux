import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCodexTurnStates, type CodexTurnSnapshot } from "./tauri-api";
import { subscribeTerminalTasks } from "./terminal-task-subscription";
import { observeTaskInput } from "./terminal-task-observers";
import { subscribeCodexTurnStates } from "./codex-turn-subscription";
import { useTerminalStore } from "@/stores/terminal-store";
import { useNotificationStore } from "@/stores/notification-store";
import { isTerminalWorking } from "./terminal-working";
import { computeCommandStatus } from "./workspace-summary";

vi.mock("./tauri-api", () => ({ getCodexTurnStates: vi.fn() }));
vi.mock("./persist-session", () => ({ persistSession: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/hooks/useOsNotification", () => ({
  sendDesktopNotification: vi.fn().mockResolvedValue(undefined),
}));

const snapshot = (
  state: CodexTurnSnapshot["state"],
  turnId = "a",
  selectionKey = "1",
): CodexTurnSnapshot => ({
  generation: 1,
  sessionId: "session",
  selectionKey,
  turnId,
  state,
});
let stop: (() => void) | undefined;
let stopTasks: () => void;
const instance = () => useTerminalStore.getState().instances[0];
const notifications = () => useNotificationStore.getState().notifications;
const result = (turn: CodexTurnSnapshot) =>
  vi.mocked(getCodexTurnStates).mockResolvedValue({ pane: turn });
async function tick() {
  await vi.advanceTimersByTimeAsync(1000);
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
  useTerminalStore.getState().updateInstanceInfo("pane", {
    sessionReady: true,
    activity: { type: "interactiveApp", name: "Codex" },
  });
});
afterEach(() => {
  stop?.();
  stopTasks();
  stop = undefined;
  vi.useRealTimers();
});

describe("Codex turn observation", () => {
  it("확인된 빈 Codex 세션은 Astra 입력창 출력 중에도 대기로 표시한다", async () => {
    result({ generation: 1, sessionId: "session", selectionKey: "1", state: "idle" });
    useTerminalStore.getState().updateInstanceInfo("pane", { outputActive: true });
    stop = subscribeCodexTurnStates();
    await tick();
    const current = instance();
    expect(current.task).toMatchObject({ state: "idle", observation: "confirmed" });
    expect(current.outputActive).toBe(true);
    expect(
      computeCommandStatus(
        undefined,
        current.outputActive,
        undefined,
        current.activity,
        undefined,
        undefined,
        undefined,
        current.codexTurn,
        current.task,
      ).icon,
    ).toBe("—");
    expect(isTerminalWorking(current)).toBe(false);
    expect(notifications()).toHaveLength(0);
  });

  it("restores a prompt seen before the first lifecycle poll without an alert", async () => {
    useTerminalStore.getState().updateInstanceInfo("pane", { generation: 1 });
    observeTaskInput("pane", true);
    result(snapshot("unknown"));
    stop = subscribeCodexTurnStates();
    await tick();
    result(snapshot("running"));
    await tick();
    expect(instance().task).toMatchObject({
      source: "1:1:session",
      taskId: "a",
      state: "waiting",
      observation: "confirmed",
    });
    expect(notifications()).toHaveLength(0);
    await tick();
    expect(instance().task?.state).toBe("waiting");
    expect(notifications()).toHaveLength(0);
    observeTaskInput("pane", false);
    await tick();
    expect(instance().task?.state).toBe("running");
  });

  it.each(["resolved", "generation", "session", "completed"])(
    "does not restore an invalid initial prompt (%s)",
    async (reason) => {
      useTerminalStore.getState().updateInstanceInfo("pane", { generation: 1 });
      if (reason === "session") {
        result(snapshot("running"));
        stop = subscribeCodexTurnStates();
        await tick();
      }
      observeTaskInput("pane", true);
      if (reason === "resolved") observeTaskInput("pane", false);
      if (reason === "generation")
        useTerminalStore.getState().updateInstanceInfo("pane", { generation: 2 });
      result({
        ...snapshot(reason === "completed" ? "completed" : "running", "b", "2"),
        generation: reason === "generation" ? 2 : 1,
      });
      stop ??= subscribeCodexTurnStates();
      await tick();
      expect(instance().task?.state).toBe(reason === "completed" ? "ended" : "running");
    },
  );

  it("rebinds a prompt received before the next turn poll without needing a redraw", async () => {
    result(snapshot("completed"));
    stop = subscribeCodexTurnStates();
    await tick();
    useTerminalStore
      .getState()
      .updateInstanceInfo("pane", { lastUserInputAt: Date.now(), lastUserInput: "next" });
    observeTaskInput("pane", true);
    expect(instance().task?.state).toBe("ended");
    expect(notifications()).toHaveLength(0);
    await tick(); // The previous completed turn may still be the latest record.
    expect(instance().task?.state).toBe("ended");
    result(snapshot("running", "b"));
    await tick();
    expect(instance().task).toMatchObject({ taskId: "b", state: "waiting" });
    expect(notifications()).toHaveLength(1);
    await tick();
    expect(instance().task?.state).toBe("waiting");
    expect(notifications()).toHaveLength(1);
  });

  it.each(["resolved", "new-input", "session", "completed", "no-submission"])(
    "does not rebind an invalid deferred prompt (%s)",
    async (reason) => {
      result(snapshot("completed"));
      stop = subscribeCodexTurnStates();
      await tick();
      if (reason !== "no-submission")
        useTerminalStore
          .getState()
          .updateInstanceInfo("pane", { lastUserInputAt: Date.now(), lastUserInput: "/status" });
      observeTaskInput("pane", true);
      if (reason === "resolved") observeTaskInput("pane", false);
      if (reason === "new-input")
        useTerminalStore
          .getState()
          .updateInstanceInfo("pane", { lastUserInputAt: Date.now() + 1, lastUserInput: "other" });
      result(
        snapshot(
          reason === "completed" ? "completed" : "running",
          "b",
          reason === "session" ? "2" : "1",
        ),
      );
      await tick();
      expect(instance().task?.state).toBe(reason === "completed" ? "ended" : "running");
      expect(notifications().filter((n) => n.requiresAction)).toHaveLength(0);
    },
  );

  it("notifies an input wait once as information, independently of redraws", async () => {
    result(snapshot("running"));
    stop = subscribeCodexTurnStates();
    await tick();
    observeTaskInput("pane", true);
    useTerminalStore.getState().updateInstanceInfo("pane", { outputActive: true });
    await tick();
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0].level).toBe("info");
  });
  it("seeds old completion silently and preserves decorative output independently", async () => {
    result(snapshot("completed"));
    stop = subscribeCodexTurnStates();
    await tick();
    const seeded = instance().codexTurn;
    await tick();
    expect(instance().codexTurn).toBe(seeded);
    useTerminalStore
      .getState()
      .updateInstanceInfo("pane", { outputActive: true, title: "⠋ stale" });
    await tick();
    expect(instance().outputActive).toBe(true);
    expect(isTerminalWorking(instance())).toBe(false);
    expect(notifications()).toHaveLength(0);
    result(snapshot("running", "b"));
    await tick();
    useTerminalStore
      .getState()
      .updateInstanceInfo("pane", { outputActive: false, title: "custom title" });
    expect(isTerminalWorking(instance())).toBe(true);
    result(snapshot("completed", "b"));
    await tick();
    await tick();
    expect(isTerminalWorking(instance())).toBe(false);
    expect(notifications()).toHaveLength(1);
  });

  it("accepts the last observed turn after a local command without replaying completion", async () => {
    result(snapshot("completed"));
    stop = subscribeCodexTurnStates();
    await tick();
    useTerminalStore.getState().updateInstanceInfo("pane", {
      lastUserInputAt: Date.now(),
      lastUserInput: "/status",
      outputActive: true,
    });
    await tick();
    expect(instance().codexTurn?.state).toBe("completed");
    expect(isTerminalWorking(instance())).toBe(false);
    expect(notifications()).toHaveLength(0);
  });

  it("preserves the last result on submission and catches a fast next turn", async () => {
    result(snapshot("completed"));
    stop = subscribeCodexTurnStates();
    await tick();
    useTerminalStore
      .getState()
      .updateInstanceInfo("pane", { lastUserInputAt: Date.now(), lastUserInput: "next" });
    expect(instance().task?.state).toBe("ended");
    result(snapshot("completed", "b"));
    await tick();
    expect(instance().codexTurn?.state).toBe("completed");
    expect(notifications()).toHaveLength(1);
  });

  it.each(["interrupted", "failed"] as const)("does not notify success on %s", async (state) => {
    result(snapshot("running"));
    stop = subscribeCodexTurnStates();
    await tick();
    result(snapshot(state));
    await tick();
    expect(instance().codexTurn?.state).toBe(state);
    expect(notifications()).toHaveLength(1);
    expect(notifications()[0].level).toBe(state === "failed" ? "error" : "warning");
  });

  it("retains failed observations and seeds session switches without alerts", async () => {
    result(snapshot("running"));
    stop = subscribeCodexTurnStates();
    await tick();
    vi.mocked(getCodexTurnStates).mockRejectedValue(new Error("unavailable"));
    await tick();
    expect(instance().task?.observation).toBe("stale");
    result(snapshot("completed", "b", "2"));
    await tick();
    expect(notifications()).toHaveLength(0);
  });

  it("느린 조회는 지연으로 표시하고 같은 실행 범위의 정상 응답으로 복구한다", async () => {
    result(snapshot("completed"));
    stop = subscribeCodexTurnStates();
    await tick();
    let finish!: (value: Record<string, CodexTurnSnapshot>) => void;
    vi.mocked(getCodexTurnStates).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await tick();
    const count = vi.mocked(getCodexTurnStates).mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(instance().task?.observation).toBe("stale");
    expect(getCodexTurnStates).toHaveBeenCalledTimes(count);
    finish({ pane: snapshot("running", "next") });
    await vi.advanceTimersByTimeAsync(0);
    expect(instance().task).toMatchObject({
      state: "running",
      taskId: "next",
      observation: "confirmed",
    });
    expect(notifications()).toHaveLength(0);
    result(snapshot("completed", "next"));
    await tick();
    expect(instance().task?.state).toBe("ended");
    expect(notifications()).toHaveLength(1);
    await tick();
    expect(notifications()).toHaveLength(1);
  });

  it("6초보다 느린 연속 조회도 이전 완료에 고정되지 않는다", async () => {
    result(snapshot("completed"));
    stop = subscribeCodexTurnStates();
    await tick();
    vi.mocked(getCodexTurnStates).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ pane: snapshot("running", "b") }), 7000),
        ),
    );
    await vi.advanceTimersByTimeAsync(8000);
    expect(instance().task).toMatchObject({
      state: "running",
      taskId: "b",
      observation: "confirmed",
    });
    await vi.advanceTimersByTimeAsync(8000);
    expect(instance().task).toMatchObject({
      state: "running",
      taskId: "b",
      observation: "confirmed",
    });
    expect(notifications()).toHaveLength(0);
  });

  it.each(["input", "generation", "app", "disposed"])(
    "지연 응답도 무효화된 실행 범위에는 적용하지 않는다 (%s)",
    async (reason) => {
      useTerminalStore.getState().updateInstanceInfo("pane", { generation: 1 });
      result(snapshot("completed"));
      stop = subscribeCodexTurnStates();
      await tick();
      let finish!: (value: Record<string, CodexTurnSnapshot>) => void;
      vi.mocked(getCodexTurnStates).mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await tick();
      await vi.advanceTimersByTimeAsync(6000);
      if (reason === "input")
        useTerminalStore.getState().updateInstanceInfo("pane", { lastUserInputAt: Date.now() });
      if (reason === "generation")
        useTerminalStore.getState().updateInstanceInfo("pane", { generation: 2 });
      if (reason === "app")
        useTerminalStore
          .getState()
          .updateInstanceInfo("pane", { activity: { type: "interactiveApp", name: "Claude" } });
      if (reason === "disposed") stop();
      finish({ pane: snapshot("running", "obsolete") });
      await vi.advanceTimersByTimeAsync(0);
      expect(instance().task?.taskId).not.toBe("obsolete");
      expect(instance().codexTurn?.turnId).not.toBe("obsolete");
      expect(notifications()).toHaveLength(0);
    },
  );

  it("rejects an in-flight result when the terminal is recreated under the same id", async () => {
    let finish!: (value: Record<string, CodexTurnSnapshot>) => void;
    vi.mocked(getCodexTurnStates).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    stop = subscribeCodexTurnStates();
    await tick();
    useTerminalStore.getState().unregisterInstance("pane");
    useTerminalStore
      .getState()
      .registerInstance({ id: "pane", workspaceId: "ws", profile: "ps", syncGroup: "s" });
    useTerminalStore.getState().updateInstanceInfo("pane", {
      sessionReady: true,
      activity: { type: "interactiveApp", name: "Codex" },
    });
    finish({ pane: snapshot("completed") });
    await vi.advanceTimersByTimeAsync(0);
    expect(instance().codexTurn).toBeUndefined();
    expect(notifications()).toHaveLength(0);
  });

  it("does not apply an expired request to a replacement pane", async () => {
    vi.mocked(getCodexTurnStates).mockImplementation(() => new Promise(() => {}));
    stop = subscribeCodexTurnStates();
    await tick();
    useTerminalStore.getState().unregisterInstance("pane");
    useTerminalStore
      .getState()
      .registerInstance({ id: "pane", workspaceId: "ws", profile: "ps", syncGroup: "s" });
    useTerminalStore.getState().updateInstanceInfo("pane", {
      sessionReady: true,
      activity: { type: "interactiveApp", name: "Codex" },
      codexTurn: snapshot("running", "new"),
    });
    // Registration invalidates inherited state; a later current observation is preserved.
    useTerminalStore
      .getState()
      .updateInstanceInfo("pane", { codexTurn: snapshot("running", "new") });
    await vi.advanceTimersByTimeAsync(6000);
    expect(instance().codexTurn?.turnId).toBe("new");
  });
});
