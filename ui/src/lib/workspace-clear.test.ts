import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_WORKSPACE_CLEAR,
  planTerminalClear,
  planWorkspaceClear,
  resolveWorkspaceClear,
  runWorkspaceClear,
  type ClearAction,
  type ResolvedWorkspaceClear,
} from "./workspace-clear";
import { CLAUDE_INPUT_PENDING_MARKER, CODEX_INPUT_PENDING_MARKER } from "./activity-markers";
import type { TerminalInstance } from "@/stores/terminal-store";

function instance(partial: Partial<TerminalInstance> & { id: string }): TerminalInstance {
  return {
    profile: "PowerShell",
    syncGroup: "ws-1",
    workspaceId: "ws-1",
    label: "PS",
    lastActivityAt: 0,
    isFocused: false,
    ...partial,
  };
}

const config = resolveWorkspaceClear();

describe("resolveWorkspaceClear", () => {
  it("defaults to leaving busy panes alone", () => {
    expect(config).toEqual({
      shellCommand: "clear",
      busyPolicy: "skip",
      interruptRounds: 2,
      settleMs: 400,
    });
  });

  it("mirrors the store defaults", () => {
    expect(resolveWorkspaceClear(DEFAULT_WORKSPACE_CLEAR)).toEqual(config);
  });

  it("clamps hand-edited rounds and settle values", () => {
    const resolved = resolveWorkspaceClear({ interruptRounds: 99, settleMs: -5 });
    expect(resolved.interruptRounds).toBe(10);
    expect(resolved.settleMs).toBe(0);
  });

  it("falls back to the default command for a blank shellCommand", () => {
    expect(resolveWorkspaceClear({ shellCommand: "   " }).shellCommand).toBe("clear");
  });

  it("falls back to skip for an unknown busyPolicy", () => {
    expect(resolveWorkspaceClear({ busyPolicy: "nuke" as unknown as "skip" }).busyPolicy).toBe(
      "skip",
    );
  });

  it("keeps a custom shell command", () => {
    expect(resolveWorkspaceClear({ shellCommand: "cls" }).shellCommand).toBe("cls");
  });
});

describe("planTerminalClear", () => {
  it("submits the configured shell command to an idle shell", () => {
    const action = planTerminalClear(instance({ id: "terminal-pane-a" }), config);
    expect(action).toEqual({
      paneId: "pane-a",
      terminalId: "terminal-pane-a",
      kind: "submit",
      input: "clear",
    });
  });

  it("submits /clear to an idle Claude pane", () => {
    const action = planTerminalClear(
      instance({
        id: "terminal-pane-a",
        activity: { type: "interactiveApp", name: "Claude" },
        title: "✳ Claude Code",
      }),
      config,
    );
    expect(action.kind).toBe("submit");
    expect(action.input).toBe("/clear");
  });

  it("submits /clear to an idle Codex pane", () => {
    const action = planTerminalClear(
      instance({
        id: "terminal-pane-a",
        activity: { type: "interactiveApp", name: "Codex" },
      }),
      config,
    );
    expect(action.input).toBe("/clear");
  });

  // The shell handler is `getHandler`'s fallback for unregistered apps, so
  // without an explicit gate `clear` would be typed into the vim buffer.
  it("never writes into an interactive app without a registered handler", () => {
    const action = planTerminalClear(
      instance({
        id: "terminal-pane-a",
        activity: { type: "interactiveApp", name: "neovim" },
      }),
      config,
    );
    expect(action).toMatchObject({ kind: "skip", reason: "unsupportedApp" });
  });

  it("skips a terminal whose session has not been created", () => {
    const action = planTerminalClear(
      instance({ id: "terminal-pane-a", sessionReady: false }),
      config,
    );
    expect(action).toMatchObject({ kind: "skip", reason: "notReady" });
  });

  describe("busy panes", () => {
    const busyShell = instance({ id: "terminal-pane-a", activity: { type: "running" } });
    const workingClaude = instance({
      id: "terminal-pane-b",
      activity: { type: "interactiveApp", name: "Claude" },
      title: "✻ Reticulating splines",
    });
    const claudeModal = instance({
      id: "terminal-pane-c",
      activity: { type: "interactiveApp", name: "Claude" },
      activityMessage: CLAUDE_INPUT_PENDING_MARKER,
    });
    const codexModal = instance({
      id: "terminal-pane-d",
      activity: { type: "interactiveApp", name: "Codex" },
      activityMessage: CODEX_INPUT_PENDING_MARKER,
    });

    it("leaves them alone under the default policy", () => {
      for (const busy of [busyShell, workingClaude, claudeModal, codexModal]) {
        expect(planTerminalClear(busy, config)).toMatchObject({ kind: "skip", reason: "busy" });
      }
    });

    it("interrupts first under the interrupt policy", () => {
      const interrupting: ResolvedWorkspaceClear = { ...config, busyPolicy: "interrupt" };
      expect(planTerminalClear(workingClaude, interrupting)).toMatchObject({
        kind: "interruptThenSubmit",
        input: "/clear",
      });
      expect(planTerminalClear(busyShell, interrupting)).toMatchObject({
        kind: "interruptThenSubmit",
        input: "clear",
      });
    });

    it("restarts without typing anything under the restart policy", () => {
      const action = planTerminalClear(workingClaude, { ...config, busyPolicy: "restart" });
      expect(action.kind).toBe("restart");
      expect(action.input).toBeUndefined();
    });

    it("treats outputActive as busy even without an activity", () => {
      expect(
        planTerminalClear(instance({ id: "terminal-pane-a", outputActive: true }), config),
      ).toMatchObject({ kind: "skip", reason: "busy" });
    });

    // exitCode describes the PREVIOUS command; a shell sitting at its prompt
    // after a failure is idle.
    it("does not treat a stale non-zero exit code as busy", () => {
      expect(
        planTerminalClear(instance({ id: "terminal-pane-a", lastExitCode: 1 }), config).kind,
      ).toBe("submit");
    });
  });
});

describe("planWorkspaceClear", () => {
  it("reports a pane with no registered terminal as not ready", () => {
    const actions = planWorkspaceClear(
      ["pane-a", "pane-b"],
      [instance({ id: "terminal-pane-a" })],
      config,
    );
    expect(actions).toHaveLength(2);
    expect(actions[0].kind).toBe("submit");
    expect(actions[1]).toEqual({
      paneId: "pane-b",
      terminalId: "terminal-pane-b",
      kind: "skip",
      reason: "notReady",
    });
  });

  it("keeps the workspace's pane order", () => {
    const actions = planWorkspaceClear(
      ["pane-b", "pane-a"],
      [instance({ id: "terminal-pane-a" }), instance({ id: "terminal-pane-b" })],
      config,
    );
    expect(actions.map((a) => a.paneId)).toEqual(["pane-b", "pane-a"]);
  });
});

function deps(actions: ClearAction[], overrides: Partial<ResolvedWorkspaceClear> = {}) {
  const submit = vi.fn().mockResolvedValue(undefined);
  const interrupt = vi.fn().mockResolvedValue(undefined);
  const restart = vi.fn();
  const sleep = vi.fn().mockResolvedValue(undefined);
  return {
    submit,
    interrupt,
    restart,
    sleep,
    run: () =>
      runWorkspaceClear({
        actions,
        config: { ...config, ...overrides },
        submit,
        interrupt,
        restart,
        sleep,
      }),
  };
}

describe("runWorkspaceClear", () => {
  it("submits the planned input per terminal", async () => {
    const d = deps([
      { paneId: "pane-a", terminalId: "terminal-pane-a", kind: "submit", input: "clear" },
      { paneId: "pane-b", terminalId: "terminal-pane-b", kind: "submit", input: "/clear" },
    ]);
    const result = await d.run();

    expect(d.submit).toHaveBeenCalledWith("terminal-pane-a", "clear");
    expect(d.submit).toHaveBeenCalledWith("terminal-pane-b", "/clear");
    expect(result.cleared).toEqual(["terminal-pane-a", "terminal-pane-b"]);
  });

  it("sends every Ctrl+C round and settles before typing", async () => {
    const order: string[] = [];
    const d = deps(
      [
        {
          paneId: "pane-a",
          terminalId: "terminal-pane-a",
          kind: "interruptThenSubmit",
          input: "/clear",
        },
      ],
      { interruptRounds: 3, settleMs: 250 },
    );
    d.interrupt.mockImplementation(async () => void order.push("interrupt"));
    d.sleep.mockImplementation(async (ms: number) => void order.push(`sleep:${ms}`));
    d.submit.mockImplementation(async () => void order.push("submit"));

    const result = await d.run();

    // Two inter-round gaps for three presses, then the settle delay.
    expect(order).toEqual([
      "interrupt",
      "sleep:120",
      "interrupt",
      "sleep:120",
      "interrupt",
      "sleep:250",
      "submit",
    ]);
    expect(result).toMatchObject({
      cleared: ["terminal-pane-a"],
      interrupted: ["terminal-pane-a"],
    });
  });

  it("skips the settle delay when it is zero", async () => {
    const d = deps(
      [
        {
          paneId: "pane-a",
          terminalId: "terminal-pane-a",
          kind: "interruptThenSubmit",
          input: "clear",
        },
      ],
      { interruptRounds: 1, settleMs: 0 },
    );
    await d.run();
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it("requests a restart instead of writing", async () => {
    const d = deps([{ paneId: "pane-a", terminalId: "terminal-pane-a", kind: "restart" }]);
    const result = await d.run();

    expect(d.restart).toHaveBeenCalledWith("pane-a");
    expect(d.submit).not.toHaveBeenCalled();
    expect(result.restarted).toEqual(["terminal-pane-a"]);
  });

  it("reports why each pane was skipped", async () => {
    const d = deps([
      { paneId: "pane-a", terminalId: "terminal-pane-a", kind: "skip", reason: "busy" },
      {
        paneId: "pane-b",
        terminalId: "terminal-pane-b",
        kind: "skip",
        reason: "unsupportedApp",
      },
    ]);
    const result = await d.run();

    expect(result.skipped).toEqual([
      { terminalId: "terminal-pane-a", reason: "busy" },
      { terminalId: "terminal-pane-b", reason: "unsupportedApp" },
    ]);
    expect(d.submit).not.toHaveBeenCalled();
  });

  // A terminal that exited between planning and writing must not take the
  // other panes down with it.
  it("keeps clearing the other terminals when one write fails", async () => {
    const d = deps([
      { paneId: "pane-a", terminalId: "terminal-pane-a", kind: "submit", input: "clear" },
      { paneId: "pane-b", terminalId: "terminal-pane-b", kind: "submit", input: "clear" },
    ]);
    d.submit.mockImplementation(async (id: string) => {
      if (id === "terminal-pane-a") throw new Error("terminal is gone");
    });

    const result = await d.run();

    expect(d.submit).toHaveBeenCalledTimes(2);
    expect(result.cleared).toEqual(["terminal-pane-b"]);
  });
});
