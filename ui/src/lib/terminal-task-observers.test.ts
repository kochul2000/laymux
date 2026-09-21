import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTerminalStore } from "@/stores/terminal-store";
import { useNotificationStore } from "@/stores/notification-store";
import { observeTaskInput, observeTaskTitle, observeTerminalTask } from "./terminal-task-observers";
import { subscribeTerminalTasks } from "./terminal-task-subscription";
import { terminalTaskPolicy, taskPresentation } from "./terminal-task";
import { computeCommandStatus } from "./workspace-summary";
import { commandStatusIconName } from "@/remote/remote-icons.js";
import { planTerminalClear, resolvePaneClear } from "./pane-clear";

vi.mock("./persist-session", () => ({ persistSession: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/hooks/useOsNotification", () => ({ sendDesktopNotification: vi.fn() }));
let stop: () => void;
const current = () => useTerminalStore.getState().instances[0];
const notices = () => useNotificationStore.getState().notifications;
function register(name?: string, id = "pane") {
  const store = useTerminalStore.getState();
  store.registerInstance({ id, workspaceId: "ws", syncGroup: "ws", profile: "ps" });
  store.updateInstanceInfo(id, {
    sessionReady: true,
    generation: 1,
    activity: name ? { type: "interactiveApp", name } : { type: "shell" },
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  useTerminalStore.setState(useTerminalStore.getInitialState());
  useNotificationStore.setState(useNotificationStore.getInitialState());
  stop = subscribeTerminalTasks();
});
afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe("작업 관측의 공통 소비 경로", () => {
  it("Claude 최초 ✳는 작업 없음이며 작업 이후 ✳만 결과 없는 종료를 알린다", () => {
    register("Claude");
    observeTaskTitle("pane", "✳ Claude Code");
    expect(current().task?.state).toBe("idle");
    expect(notices()).toHaveLength(0);
    observeTaskTitle("pane", "◐ 작업");
    observeTaskTitle("pane", "◑ 작업");
    const taskId = current().task?.taskId;
    observeTaskTitle("pane", "✳ Claude Code");
    observeTaskTitle("pane", "✳ Claude Code");
    expect(current().task).toMatchObject({ state: "ended", taskId });
    expect(current().task?.result).toBeUndefined();
    expect(notices()).toHaveLength(1);
    expect(notices()[0].level).toBe("info");
  });

  it("Claude 모달은 타이틀보다 우선하고 해소 후 새 ✳만 종료한다", () => {
    register("Claude");
    observeTaskTitle("pane", "◐ 작업");
    observeTaskInput("pane", true);
    observeTaskTitle("pane", "✳ Claude Code");
    expect(current().task?.state).toBe("waiting");
    expect(notices()).toHaveLength(1);
    expect(notices()[0].requiresAction).toBe(true);
    observeTaskInput("pane", false);
    expect(current().task?.state).toBe("running");
    expect(notices()[0].readAt).not.toBeNull();
    observeTaskTitle("pane", "✳ Claude Code");
    expect(notices()).toHaveLength(2);
    observeTaskInput("pane", true);
    expect(current().task?.state).toBe("ended");
  });

  it.each(["Claude", "Codex", "Grok"])(
    "%s의 장식 출력과 메시지는 작업 상태·알림 근거가 아니다",
    (name) => {
      register(name);
      useTerminalStore.getState().updateInstanceInfo("pane", {
        outputActive: true,
        activityMessage: "__codex_input_pending__",
        lastExitCode: 0,
      });
      expect(terminalTaskPolicy(current())).toMatchObject({
        observation: "unknown",
        inhibitSleep: false,
        clearAllowed: false,
      });
      expect(taskPresentation(current().task).icon).toBe("—");
      expect(notices()).toHaveLength(0);
    },
  );

  it.each(["Claude", "Grok"])(
    "%s 타이틀은 새 수신만 기한을 갱신하며 출력은 60초 상한을 늘리지 않는다",
    (name) => {
      register(name);
      observeTaskTitle("pane", "⠋ 작업");
      vi.advanceTimersByTime(5999);
      expect(terminalTaskPolicy(current()).observation).toBe("confirmed");
      vi.advanceTimersByTime(1);
      expect(current().task?.observation).toBe("stale");
      useTerminalStore.getState().updateInstanceInfo("pane", { outputActive: true });
      vi.advanceTimersByTime(54_000);
      expect(terminalTaskPolicy(current())).toMatchObject({
        sleepExpired: true,
        inhibitSleep: false,
        clearAllowed: false,
      });
      expect(planTerminalClear(current(), resolvePaneClear()).kind).toBe("skip");
      observeTaskTitle("pane", "⠋ 작업");
      expect(terminalTaskPolicy(current()).inhibitSleep).toBe(true);
      expect(notices()).toHaveLength(0);
    },
  );

  it("Grok 접두사 소멸은 종료가 아니며 새 이름은 관측 지연이다", () => {
    register("Grok");
    observeTaskTitle("pane", "- Running: tests - grok");
    observeTaskTitle("pane", "grok");
    expect(current().task).toMatchObject({ state: "running", observation: "stale" });
    expect(notices()).toHaveLength(0);
  });

  it("N개 최초 입력 대기는 표시만 복원한다", () => {
    for (let i = 0; i < 5; i++) {
      register("Claude", String(i));
      observeTaskInput(String(i), true);
    }
    expect(
      useTerminalStore.getState().instances.every((entry) => entry.task?.state === "waiting"),
    ).toBe(true);
    expect(notices()).toHaveLength(0);
  });

  it("통합 셸의 조용한 실행은 만료되지 않고 최초 종료 이후 새 명령만 알린다", () => {
    register();
    observeTerminalTask("pane", { state: "ended", result: "success" });
    expect(notices()).toHaveLength(0);
    observeTerminalTask("pane", { state: "running", taskId: "command-2" });
    vi.advanceTimersByTime(120_000);
    expect(terminalTaskPolicy(current()).inhibitSleep).toBe(true);
    observeTerminalTask("pane", { state: "ended", result: "failure" });
    expect(notices()).toHaveLength(1);
    expect(notices()[0].level).toBe("error");
  });

  it.each([
    ["idle", undefined, "Minus"],
    ["running", undefined, "Hourglass"],
    ["waiting", undefined, "CircleAlert"],
    ["ended", "success", "Check"],
    ["ended", "failure", "X"],
    ["ended", "interrupted", "Minus"],
    ["ended", undefined, "Minus"],
  ] as const)("Desktop/Automation/Remote가 %s/%s를 같은 뜻으로 투영한다", (state, result, icon) => {
    register("Codex");
    observeTerminalTask("pane", { state, result });
    const status = computeCommandStatus(
      0,
      true,
      "설명",
      current().activity,
      "⠋ 장식",
      undefined,
      undefined,
      undefined,
      current().task,
    );
    expect(status).toMatchObject({
      taskState: state,
      taskResult: result,
      outputActive: true,
      observation: "confirmed",
    });
    expect(commandStatusIconName({ ...status, icon: "wrong" })).toBe(icon);
  });

  it("PTY 교체는 작업·알림 이력을 버린다", () => {
    register("Claude");
    observeTaskTitle("pane", "◐ 작업");
    useTerminalStore.getState().updateInstanceInfo("pane", { generation: 2 });
    observeTaskTitle("pane", "✳ Claude Code");
    expect(current().task?.state).toBe("idle");
    expect(notices()).toHaveLength(0);
  });
});
