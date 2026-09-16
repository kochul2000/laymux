import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getCodexTurnStates, type CodexTurnSnapshot } from "./tauri-api";
import { subscribeTerminalTasks } from "./terminal-task-subscription";
import { observeTaskInput } from "./terminal-task-observers";
import { subscribeCodexTurnStates } from "./codex-turn-subscription";
import { useTerminalStore } from "@/stores/terminal-store";
import { useNotificationStore } from "@/stores/notification-store";
import { isTerminalWorking } from "./terminal-working";

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

  it("expires a hung lookup without overlap and discards the late response", async () => {
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
    finish({ pane: snapshot("completed", "late") });
    await vi.advanceTimersByTimeAsync(0);
    expect(instance().task?.observation).toBe("stale");
    expect(notifications()).toHaveLength(0);
  });

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
