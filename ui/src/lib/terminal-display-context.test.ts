import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useTerminalStore } from "@/stores/terminal-store";
import { useTerminalDisplayStore } from "@/stores/terminal-display-store";
import {
  projectTerminalDisplay,
  startTerminalDisplayContextSync,
  flushTerminalDisplayContexts,
} from "./terminal-display-context";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(true) }));
const history = {
  version: 1 as const,
  profile: "PowerShell",
  lastUserInput: "private question",
  lastUserInputAt: 100,
  lastExitCode: 0,
  activityMessage: "finished",
  activity: { type: "shell" as const },
  task: {
    source: "old",
    taskId: "1",
    sequence: 2,
    state: "ended" as const,
    result: "success" as const,
    observation: "confirmed" as const,
    observedAt: 100,
    notificationId: 3,
  },
};
function register() {
  const store = useTerminalStore.getState();
  store.registerInstance({ id: "t", profile: "PowerShell", workspaceId: "ws", syncGroup: "ws" });
  store.updateInstanceInfo("t", { generation: 7, sessionReady: true });
  return store;
}
describe("daemon display context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useTerminalDisplayStore.setState({ contexts: {} });
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "get_terminal_display_context" ? history : true,
    );
  });
  it("keeps historical status in the display model without changing live task authority", () => {
    register();
    const instance = useTerminalStore.getState().instances[0];
    const projected = projectTerminalDisplay(instance, history);
    expect(projected.lastUserInput).toBe("private question");
    expect(projected.activityMessage).toBe("finished");
    expect(projected.task).toMatchObject({ state: "ended", observation: "stale" });
    expect(useTerminalStore.getState().instances[0].task).toBeUndefined();
  });
  it("does not overwrite newer input or use another profile's history", () => {
    register();
    const instance = {
      ...useTerminalStore.getState().instances[0],
      lastUserInput: "new question",
      lastUserInputAt: 200,
    };
    expect(projectTerminalDisplay(instance, history).lastUserInput).toBe("new question");
    expect(
      projectTerminalDisplay({ ...instance, profile: "WSL" }, history).activityMessage,
    ).toBeUndefined();
  });

  it("does not resurrect messages or results explicitly cleared by a live event", () => {
    register();
    const instance = {
      ...useTerminalStore.getState().instances[0],
      activityMessage: undefined,
      lastExitCode: undefined,
    };
    const projected = projectTerminalDisplay(instance, history);
    expect(projected.activityMessage).toBeUndefined();
    expect(projected.lastExitCode).toBeUndefined();
  });

  it("coalesces title bursts and flushes only the most recent context", async () => {
    const store = register();
    const stop = startTerminalDisplayContextSync();
    try {
      await flushTerminalDisplayContexts();
      const before = vi
        .mocked(invoke)
        .mock.calls.filter((c) => c[0] === "save_terminal_display_context").length;
      store.updateInstanceInfo("t", { title: "Working A" });
      store.updateInstanceInfo("t", { title: "Working B" });
      store.updateInstanceInfo("t", { title: "Working C" });
      expect(
        vi.mocked(invoke).mock.calls.filter((c) => c[0] === "save_terminal_display_context"),
      ).toHaveLength(before);
      await flushTerminalDisplayContexts();
      const saves = vi
        .mocked(invoke)
        .mock.calls.filter((c) => c[0] === "save_terminal_display_context");
      expect(saves).toHaveLength(before + 1);
      expect(saves.at(-1)?.[1]).toMatchObject({ context: { title: "Working C" } });
    } finally {
      stop();
    }
  });

  it("bounds retained input without truncating the live input", async () => {
    const store = register();
    const stop = startTerminalDisplayContextSync();
    try {
      await flushTerminalDisplayContexts();
      const input = "🔐".repeat(8192);
      store.updateInstanceInfo("t", { lastUserInput: input, lastUserInputAt: 500 });
      await flushTerminalDisplayContexts();
      const saved = vi
        .mocked(invoke)
        .mock.calls.filter((c) => c[0] === "save_terminal_display_context")
        .at(-1)?.[1] as { context: { lastUserInput: string } };
      expect(Array.from(saved.context.lastUserInput)).toHaveLength(2048);
      expect(new TextEncoder().encode(JSON.stringify(saved.context)).length).toBeLessThan(
        64 * 1024,
      );
      expect(useTerminalStore.getState().instances[0].lastUserInput).toBe(input);
    } finally {
      stop();
    }
  });

  it("does not let a delayed restore overwrite a newly submitted question", async () => {
    const store = register();
    let finish!: () => void;
    vi.mocked(invoke).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve(history);
        }),
    );
    const stop = startTerminalDisplayContextSync();
    try {
      store.updateInstanceInfo("t", { lastUserInput: "new question", lastUserInputAt: 900 });
      finish();
      await flushTerminalDisplayContexts();
      expect(useTerminalStore.getState().instances[0].lastUserInput).toBe("new question");
      expect(useTerminalDisplayStore.getState().contexts.t.lastUserInput).toBe("new question");
    } finally {
      stop();
    }
  });
  it("hydrates the adopted input, mirrors only display changes, and flushes pending transfers", async () => {
    const store = register();
    const stop = startTerminalDisplayContextSync();
    try {
      await flushTerminalDisplayContexts();
      expect(useTerminalStore.getState().instances[0].lastUserInput).toBe("private question");
      const calls = vi
        .mocked(invoke)
        .mock.calls.filter((c) => c[0] === "save_terminal_display_context").length;
      store.updateInstanceInfo("t", { outputActive: true });
      await flushTerminalDisplayContexts();
      expect(
        vi.mocked(invoke).mock.calls.filter((c) => c[0] === "save_terminal_display_context"),
      ).toHaveLength(calls);
      let finish!: () => void;
      vi.mocked(invoke).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve(true);
          }),
      );
      store.updateInstanceInfo("t", { lastUserInput: "next question", lastUserInputAt: 300 });
      let flushed = false;
      const pending = flushTerminalDisplayContexts().then(() => {
        flushed = true;
      });
      await vi.waitFor(() => expect(finish).toBeDefined());
      expect(flushed).toBe(false);
      finish();
      await pending;
      expect(invoke).toHaveBeenLastCalledWith(
        "save_terminal_display_context",
        expect.objectContaining({
          id: "t",
          generation: 7,
          context: expect.objectContaining({ lastUserInput: "next question" }),
        }),
      );
    } finally {
      stop();
    }
  });
});
