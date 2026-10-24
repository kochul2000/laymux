import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerTerminalInspector,
  unregisterTerminalInspector,
} from "./terminal-serialize-registry";

vi.mock("./agent-clear-input-api", () => ({
  beginAgentClear: vi.fn(),
  agentClearInput: vi.fn(),
}));
import { agentClearInput, beginAgentClear } from "./agent-clear-input-api";

vi.mock("@/lib/tauri-api", () => ({
  getTerminalStates: vi
    .fn()
    .mockImplementation(async () =>
      Object.fromEntries(
        useTerminalStore
          .getState()
          .instances.map((entry) => [entry.id, { activity: entry.activity ?? { type: "shell" } }]),
      ),
    ),
  writeTerminalInput: vi.fn().mockResolvedValue(undefined),
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
  writeTerminalInputForRemote: vi.fn().mockResolvedValue(undefined),
  writeToTerminalForRemote: vi.fn().mockResolvedValue(undefined),
}));

import {
  getTerminalStates,
  writeTerminalInput,
  writeTerminalInputForRemote,
  writeToTerminal,
  writeToTerminalForRemote,
} from "@/lib/tauri-api";
import { observeTerminalTask } from "./terminal-task-observers";
import { clearPane } from "./pane-clear";
import { useDockStore } from "@/stores/dock-store";
import { useTerminalRestartStore } from "@/stores/terminal-restart-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

const CTRL_C = "\x03";

function resetStores() {
  useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
  useDockStore.setState(useDockStore.getInitialState());
  useTerminalStore.setState(useTerminalStore.getInitialState());
  useTerminalRestartStore.setState({ requests: {} });
}

function registerTerminal(paneId: string, workspaceId = "ws-clear") {
  useTerminalStore.getState().registerInstance({
    id: `terminal-${paneId}`,
    profile: "PowerShell",
    syncGroup: workspaceId,
    workspaceId,
  });
  useTerminalStore.getState().updateInstanceInfo(`terminal-${paneId}`, {
    generation: 1,
    sessionReady: true,
    activity: { type: "shell" },
  });
}

function seedWorkspace() {
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: "ws-clear",
        name: "Clear",
        panes: [
          {
            id: "pane-a",
            x: 0,
            y: 0,
            w: 0.5,
            h: 1,
            layers: [{ id: "pane-a", view: { type: "TerminalView" } }],
            activeLayerId: "pane-a",
          },
          {
            id: "pane-b",
            x: 0.5,
            y: 0,
            w: 0.5,
            h: 1,
            layers: [{ id: "pane-b", view: { type: "TerminalView", lastCwd: "/saved/cwd" } }],
            activeLayerId: "pane-b",
          },
          {
            id: "pane-m",
            x: 0,
            y: 1,
            w: 1,
            h: 0,
            layers: [{ id: "pane-m", view: { type: "MemoView" } }],
            activeLayerId: "pane-m",
          },
        ],
      },
    ],
    activeWorkspaceId: "ws-clear",
    workspaceDisplayOrder: [],
  });
  registerTerminal("pane-a");
  registerTerminal("pane-b");
}

function seedDockTerminal(paneId: string) {
  useDockStore.setState({
    docks: [
      {
        position: "left",
        activeView: "TerminalView",
        views: ["TerminalView"],
        visible: true,
        size: 300,
        panes: [{ id: paneId, x: 0, y: 0, w: 1, h: 1, view: { type: "TerminalView" } }],
      },
    ],
  });
  registerTerminal(paneId, "dock");
}

function makeBusy(paneId: string) {
  useTerminalStore.getState().updateInstanceInfo(`terminal-${paneId}`, {
    activity: { type: "interactiveApp", name: "Claude" },
    title: "✻ Working",
  });
}

describe("clearPane against live stores", () => {
  afterEach(() => {
    unregisterTerminalInspector("terminal-pane-a");
    vi.useRealTimers();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getTerminalStates)
      .mockReset()
      .mockImplementation(async () =>
        Object.fromEntries(
          useTerminalStore
            .getState()
            .instances.map((entry) => [
              entry.id,
              { activity: entry.activity ?? { type: "shell" } },
            ]),
        ),
      );
    vi.mocked(writeTerminalInput).mockResolvedValue(undefined);
    vi.mocked(writeToTerminal).mockResolvedValue(undefined);
    vi.mocked(beginAgentClear).mockReset().mockResolvedValue({ generation: 1, inputRevision: 0 });
    vi.mocked(agentClearInput)
      .mockReset()
      .mockImplementation(async (_id, stamp) => ({
        ...stamp,
        inputRevision: stamp.inputRevision + 1,
      }));
    resetStores();
  });

  it("clears only the named grid pane through structured human input", async () => {
    seedWorkspace();
    const result = await clearPane("pane-b");
    expect(vi.mocked(writeTerminalInput).mock.calls).toEqual([["terminal-pane-b", "clear", true]]);
    expect(result.cleared).toEqual(["terminal-pane-b"]);
  });

  it("protects an unknown shell when current liveness fails", async () => {
    seedWorkspace();
    vi.mocked(getTerminalStates).mockRejectedValueOnce(new Error("offline"));
    const result = await clearPane("pane-a");
    expect(result.skipped).toEqual([{ terminalId: "terminal-pane-a", reason: "busy" }]);
    expect(writeTerminalInput).not.toHaveBeenCalled();
  });

  it("does not invent a shell classification before an activity observation", async () => {
    seedWorkspace();
    useTerminalStore.getState().updateInstanceInfo("terminal-pane-a", { activity: undefined });
    const result = await clearPane("pane-a");
    expect(result.skipped).toEqual([{ terminalId: "terminal-pane-a", reason: "busy" }]);
    expect(getTerminalStates).not.toHaveBeenCalled();
    expect(writeTerminalInput).not.toHaveBeenCalled();
  });

  it.each(["before", "during"])(
    "preserves E-only running observed %s the liveness lookup",
    async (when) => {
      seedWorkspace();
      const start = () =>
        useTerminalStore.getState().updateInstanceInfo("terminal-pane-a", {
          activity: { type: "running" },
          lastCommand: "quiet-command",
        });
      if (when === "before") start();
      vi.mocked(getTerminalStates).mockImplementationOnce(async () => {
        if (when === "during") start();
        return { "terminal-pane-a": { activity: { type: "shell" } } };
      });
      const result = await clearPane("pane-a");
      expect(result.skipped).toEqual([{ terminalId: "terminal-pane-a", reason: "busy" }]);
      expect(
        useTerminalStore.getState().instances.find((i) => i.id === "terminal-pane-a")?.activity
          ?.type,
      ).toBe("running");
      expect(writeTerminalInput).not.toHaveBeenCalled();
      if (when === "before") expect(getTerminalStates).not.toHaveBeenCalled();
    },
  );

  it("does not clear a replacement PTY using an old liveness response", async () => {
    seedWorkspace();
    vi.mocked(getTerminalStates).mockImplementationOnce(async () => {
      useTerminalStore.getState().updateInstanceInfo("terminal-pane-a", { generation: 2 });
      return { "terminal-pane-a": { activity: { type: "shell" } } };
    });
    const result = await clearPane("pane-a");
    expect(result.cleared).toEqual([]);
    expect(writeTerminalInput).not.toHaveBeenCalled();
  });

  it.each(["Codex", "Grok"])("submits /clear to a %s pane", async (name) => {
    seedWorkspace();
    useTerminalStore.getState().updateInstanceInfo("terminal-pane-a", {
      activity: { type: "interactiveApp", name },
    });
    observeTerminalTask("terminal-pane-a", { state: "idle" });
    registerTerminalInspector("terminal-pane-a", () => ({
      cols: 96,
      rows: 6,
      length: 6,
      baseY: 0,
      lines: (name === "Grok"
        ? ["╭──────────╮", "│ ❯  │", "╰── Grok 4.7 ──╯"]
        : ["› ", "", "  GPT-6.1-Sol · Context 100% left"]
      ).map((text, index) => ({
        index,
        text,
        isWrapped: false,
      })),
    }));
    const result = await clearPane("pane-a");
    expect(result.cleared).toEqual(["terminal-pane-a"]);
    expect(beginAgentClear).toHaveBeenCalledWith("terminal-pane-a", 1, undefined);
    expect(agentClearInput).toHaveBeenLastCalledWith(
      "terminal-pane-a",
      { generation: 1, inputRevision: 1 },
      "submitClear",
      expect.any(Number),
      undefined,
    );
    expect(writeTerminalInput).not.toHaveBeenCalled();
  });

  it("clears a dock pane that workspace clear does not own", async () => {
    seedDockTerminal("dock-pane-1");
    const result = await clearPane("dock-pane-1");
    expect(vi.mocked(writeTerminalInput)).toHaveBeenCalledWith(
      "terminal-dock-pane-1",
      "clear",
      true,
    );
    expect(result.cleared).toEqual(["terminal-dock-pane-1"]);
  });

  it.each(["Claude", "Grok"])(
    "deletes the %s draft and submits as the Remote lease holder",
    async (provider) => {
      seedWorkspace();
      useTerminalStore.getState().updateInstanceInfo("terminal-pane-a", {
        activity: { type: "interactiveApp", name: provider },
      });
      observeTerminalTask("terminal-pane-a", { state: "idle" });
      let text = "unsent draft";
      registerTerminalInspector("terminal-pane-a", () => ({
        cols: 96,
        rows: 6,
        length: 6,
        baseY: 0,
        lines: (provider === "Grok"
          ? ["╭──────────╮", "│ ❯ " + text + " │", "╰── Grok 4.7 ──╯"]
          : ["──────────", "> " + text, "──────────", "  auto mode on"]
        ).map((text, index) => ({
          index,
          text,
          isWrapped: false,
        })),
      }));
      vi.mocked(agentClearInput).mockImplementationOnce(async (_id, stamp) => {
        text = "";
        return { ...stamp, inputRevision: stamp.inputRevision + 1 };
      });
      const result = await clearPane("pane-a", undefined, { remoteLeaseId: "lease-clear" });
      expect(result.cleared).toEqual(["terminal-pane-a"]);
      expect(beginAgentClear).toHaveBeenCalledWith("terminal-pane-a", 1, "lease-clear");
      expect(agentClearInput).toHaveBeenNthCalledWith(
        1,
        "terminal-pane-a",
        { generation: 1, inputRevision: 0 },
        "deleteDraft",
        expect.any(Number),
        "lease-clear",
      );
      expect(agentClearInput).toHaveBeenLastCalledWith(
        "terminal-pane-a",
        { generation: 1, inputRevision: 1 },
        "submitClear",
        expect.any(Number),
        "lease-clear",
      );
      expect(writeToTerminal).not.toHaveBeenCalled();
      expect(writeTerminalInput).not.toHaveBeenCalled();
    },
  );

  it("waits for a delayed idle observation after Ctrl+C, then submits /clear", async () => {
    vi.useFakeTimers();
    seedWorkspace();
    makeBusy("pane-a");
    registerTerminalInspector("terminal-pane-a", () => ({
      cols: 96,
      rows: 6,
      length: 6,
      baseY: 0,
      lines: ["──────────", "> ", "──────────", "  auto mode on"].map((text, index) => ({
        index,
        text,
        isWrapped: false,
      })),
    }));
    setTimeout(() => observeTerminalTask("terminal-pane-a", { state: "idle" }), 2000);
    const run = clearPane("pane-a", { busyPolicy: "interrupt", interruptRounds: 2, settleMs: 0 });
    await vi.advanceTimersByTimeAsync(1900);
    expect(beginAgentClear).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    const result = await run;
    expect(vi.mocked(writeToTerminal).mock.calls).toEqual([
      ["terminal-pane-a", CTRL_C],
      ["terminal-pane-a", CTRL_C],
    ]);
    expect(result.cleared).toEqual(["terminal-pane-a"]);
    expect(agentClearInput).toHaveBeenLastCalledWith(
      "terminal-pane-a",
      { generation: 1, inputRevision: 1 },
      "submitClear",
      expect.any(Number),
      undefined,
    );
  });

  it("reports intervening raw input as failed even when the screen still looks empty", async () => {
    vi.useFakeTimers();
    seedWorkspace();
    useTerminalStore.getState().updateInstanceInfo("terminal-pane-a", {
      activity: { type: "interactiveApp", name: "Codex" },
    });
    observeTerminalTask("terminal-pane-a", { state: "idle" });
    registerTerminalInspector("terminal-pane-a", () => ({
      cols: 96,
      rows: 6,
      length: 6,
      baseY: 0,
      lines: ["› ", "", "  GPT-6.1-Sol · Context 100% left"].map((text, index) => ({
        index,
        text,
        isWrapped: false,
      })),
    }));
    vi.mocked(agentClearInput).mockImplementation(async (_id, stamp, step) => {
      if (step === "submitClear")
        throw new Error("Agent clear input changed during draft preparation");
      return { ...stamp, inputRevision: stamp.inputRevision + 1 };
    });
    const run = clearPane("pane-a");
    await vi.advanceTimersByTimeAsync(400);
    const result = await run;
    expect(result.cleared).toEqual([]);
    expect(result.failed[0]?.error).toContain("input changed");
    expect(writeTerminalInput).not.toHaveBeenCalled();
  });

  // ADR-0271: a clear the Remote lease holder asked for writes as that holder,
  // so the lease that locks out Local input does not reject it.
  it("writes as the Remote lease holder when one requested the clear", async () => {
    vi.useFakeTimers();
    seedWorkspace();
    makeBusy("pane-a");
    const run = clearPane(
      "pane-a",
      { busyPolicy: "interrupt", interruptRounds: 1, settleMs: 0 },
      { remoteLeaseId: "lease-1" },
    );
    await vi.advanceTimersByTimeAsync(3100);
    const result = await run;
    expect(result.failed[0]?.error).toContain("idle task");
    expect(vi.mocked(writeToTerminalForRemote).mock.calls).toEqual([
      ["terminal-pane-a", CTRL_C, "lease-1"],
    ]);
    expect(vi.mocked(writeTerminalInputForRemote)).not.toHaveBeenCalled();
    expect(vi.mocked(writeToTerminal)).not.toHaveBeenCalled();
    expect(vi.mocked(writeTerminalInput)).not.toHaveBeenCalled();
    expect(beginAgentClear).not.toHaveBeenCalled();
    expect(agentClearInput).not.toHaveBeenCalled();
  });

  it("restarts a busy dock pane with its live cwd", async () => {
    seedDockTerminal("dock-pane-1");
    makeBusy("dock-pane-1");
    useTerminalStore
      .getState()
      .updateInstanceInfo("terminal-dock-pane-1", { cwd: "/dock/live/cwd" });
    const result = await clearPane("dock-pane-1", { busyPolicy: "restart" });
    expect(useTerminalRestartStore.getState().requests["dock-pane-1"]).toEqual({
      epoch: 1,
      cwd: "/dock/live/cwd",
      fresh: true,
    });
    expect(result.restarted).toEqual(["terminal-dock-pane-1"]);
    expect(vi.mocked(writeTerminalInput)).not.toHaveBeenCalled();
  });

  it("uses the saved cwd when a busy grid pane has no live cwd", async () => {
    seedWorkspace();
    makeBusy("pane-b");
    await clearPane("pane-b", { busyPolicy: "restart" });
    expect(useTerminalRestartStore.getState().requests["pane-b"].cwd).toBe("/saved/cwd");
  });

  it("rejects non-terminal and unknown panes", async () => {
    seedWorkspace();
    await expect(clearPane("pane-m")).rejects.toThrow("not a terminal pane");
    await expect(clearPane("pane-nope")).rejects.toThrow("not a terminal pane");
    expect(vi.mocked(writeTerminalInput)).not.toHaveBeenCalled();
  });
});
