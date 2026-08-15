import { describe, expect, it, vi } from "vitest";
import { CLAUDE_INPUT_PENDING_MARKER, CODEX_INPUT_PENDING_MARKER } from "./activity-markers";
import {
  DEFAULT_PANE_CLEAR,
  isNoOpPaneClearResult,
  paneClearWaitBudgetMs,
  planTerminalClear,
  resolvePaneClear,
  runPaneClearAction,
  summarizePaneClearResult,
  type PaneClearAction,
  type ResolvedPaneClear,
} from "./pane-clear";
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

const config = resolvePaneClear();

describe("resolvePaneClear", () => {
  it("defaults to leaving a busy pane alone", () => {
    expect(config).toEqual({
      shellCommand: "clear",
      busyPolicy: "skip",
      interruptRounds: 2,
      settleMs: 400,
    });
  });

  it("mirrors the settings-store defaults", () => {
    expect(resolvePaneClear(DEFAULT_PANE_CLEAR)).toEqual(config);
  });

  it("clamps hand-edited numeric values", () => {
    expect(resolvePaneClear({ interruptRounds: 99, settleMs: -5 })).toMatchObject({
      interruptRounds: 10,
      settleMs: 0,
    });
  });

  it("falls back from blank and invalid values", () => {
    expect(
      resolvePaneClear({ shellCommand: "   ", busyPolicy: "nuke" as unknown as "skip" }),
    ).toMatchObject({ shellCommand: "clear", busyPolicy: "skip" });
  });

  it("keeps a custom shell clear command", () => {
    expect(resolvePaneClear({ shellCommand: "cls" }).shellCommand).toBe("cls");
  });
});

describe("planTerminalClear", () => {
  it("submits the configured command to an idle shell", () => {
    expect(planTerminalClear(instance({ id: "terminal-pane-a" }), config)).toEqual({
      paneId: "pane-a",
      terminalId: "terminal-pane-a",
      kind: "submit",
      input: "clear",
    });
  });

  it.each(["Claude", "Codex", "Grok"])("submits /clear to an idle %s pane", (name) => {
    expect(
      planTerminalClear(
        instance({
          id: "terminal-pane-a",
          activity: { type: "interactiveApp", name },
        }),
        config,
      ),
    ).toMatchObject({ kind: "submit", input: "/clear" });
  });

  it("never writes into an unregistered interactive app", () => {
    expect(
      planTerminalClear(
        instance({
          id: "terminal-pane-a",
          activity: { type: "interactiveApp", name: "neovim" },
        }),
        config,
      ),
    ).toMatchObject({ kind: "skip", reason: "unsupportedApp" });
  });

  it("skips a terminal whose PTY session is not ready", () => {
    expect(
      planTerminalClear(instance({ id: "terminal-pane-a", sessionReady: false }), config),
    ).toMatchObject({ kind: "skip", reason: "notReady" });
  });

  describe("busy pane", () => {
    const busyShell = instance({ id: "terminal-pane-a", activity: { type: "running" } });
    const workingClaude = instance({
      id: "terminal-pane-b",
      activity: { type: "interactiveApp", name: "Claude" },
      title: "✻ Working",
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
    const workingGrok = instance({
      id: "terminal-pane-e",
      activity: { type: "interactiveApp", name: "Grok" },
      title: "- Running: tests - grok",
    });

    it("skips every known busy shape under the default policy", () => {
      for (const busy of [busyShell, workingClaude, claudeModal, codexModal, workingGrok]) {
        expect(planTerminalClear(busy, config)).toMatchObject({ kind: "skip", reason: "busy" });
      }
    });

    it("interrupts before the activity-specific input when configured", () => {
      const interrupting: ResolvedPaneClear = { ...config, busyPolicy: "interrupt" };
      expect(planTerminalClear(workingClaude, interrupting)).toMatchObject({
        kind: "interruptThenSubmit",
        input: "/clear",
      });
      expect(planTerminalClear(busyShell, interrupting)).toMatchObject({
        kind: "interruptThenSubmit",
        input: "clear",
      });
    });

    it("restarts without producing clear text when configured", () => {
      const action = planTerminalClear(workingClaude, { ...config, busyPolicy: "restart" });
      expect(action).toMatchObject({ kind: "restart" });
      expect(action.input).toBeUndefined();
    });

    it("treats output activity as busy but ignores a stale exit code", () => {
      expect(
        planTerminalClear(instance({ id: "terminal-pane-a", outputActive: true }), config),
      ).toMatchObject({ kind: "skip", reason: "busy" });
      expect(
        planTerminalClear(instance({ id: "terminal-pane-a", lastExitCode: 1 }), config).kind,
      ).toBe("submit");
    });
  });
});

function deps(
  action: PaneClearAction,
  overrides: Partial<ResolvedPaneClear> = {},
  clock: { now?: () => number; deadlineAt?: number } = {},
) {
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
      runPaneClearAction({
        action,
        config: { ...config, ...overrides },
        submit,
        interrupt,
        restart,
        sleep,
        ...clock,
      }),
  };
}

describe("runPaneClearAction", () => {
  it("submits the planned input", async () => {
    const d = deps({
      paneId: "pane-a",
      terminalId: "terminal-pane-a",
      kind: "submit",
      input: "/clear",
    });
    const result = await d.run();
    expect(d.submit).toHaveBeenCalledWith("terminal-pane-a", "/clear");
    expect(result.cleared).toEqual(["terminal-pane-a"]);
  });

  it("sends every Ctrl+C round, settles, then submits", async () => {
    const order: string[] = [];
    const d = deps(
      {
        paneId: "pane-a",
        terminalId: "terminal-pane-a",
        kind: "interruptThenSubmit",
        input: "/clear",
      },
      { interruptRounds: 3, settleMs: 250 },
    );
    d.interrupt.mockImplementation(async () => void order.push("interrupt"));
    d.sleep.mockImplementation(async (ms: number) => void order.push(`sleep:${ms}`));
    d.submit.mockImplementation(async () => void order.push("submit"));

    const result = await d.run();

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

  it("requests restart instead of writing", async () => {
    const d = deps({ paneId: "pane-a", terminalId: "terminal-pane-a", kind: "restart" });
    const result = await d.run();
    expect(d.restart).toHaveBeenCalledWith("pane-a");
    expect(d.submit).not.toHaveBeenCalled();
    expect(result.restarted).toEqual(["terminal-pane-a"]);
  });

  it("reports skip and rejected-write outcomes", async () => {
    const skipped = await deps({
      paneId: "pane-a",
      terminalId: "terminal-pane-a",
      kind: "skip",
      reason: "busy",
    }).run();
    expect(skipped.skipped).toEqual([{ terminalId: "terminal-pane-a", reason: "busy" }]);

    const rejected = deps({
      paneId: "pane-a",
      terminalId: "terminal-pane-a",
      kind: "submit",
      input: "/clear",
    });
    rejected.submit.mockRejectedValue(new Error("controlled by remote"));
    const failed = await rejected.run();
    expect(failed.failed).toEqual([
      { terminalId: "terminal-pane-a", error: "controlled by remote" },
    ]);
    expect(isNoOpPaneClearResult(failed)).toBe(true);
  });

  it("keeps an interrupt that landed when a later operation fails", async () => {
    const d = deps({
      paneId: "pane-a",
      terminalId: "terminal-pane-a",
      kind: "interruptThenSubmit",
      input: "/clear",
    });
    d.submit.mockRejectedValue(new Error("terminal gone"));
    const result = await d.run();
    expect(result.interrupted).toEqual(["terminal-pane-a"]);
    expect(result.cleared).toEqual([]);
    expect(result.failed).toHaveLength(1);
  });

  it("stops issuing writes after the hard deadline", async () => {
    const d = deps(
      {
        paneId: "pane-a",
        terminalId: "terminal-pane-a",
        kind: "submit",
        input: "/clear",
      },
      {},
      { now: () => 1_000, deadlineAt: 1_000 },
    );
    const result = await d.run();
    expect(d.submit).not.toHaveBeenCalled();
    expect(result.failed[0]?.error).toContain("before the clear input");
  });
});

describe("pane clear reporting and Automation wait cap", () => {
  it("summarizes distinct outcomes", () => {
    expect(
      summarizePaneClearResult({
        cleared: [],
        interrupted: ["a"],
        restarted: [],
        skipped: [],
        failed: [{ terminalId: "a", error: "boom" }],
      }),
    ).toBe("cleared 0, interrupted 1, failed 1");
  });

  it("counts inter-round gaps plus settle only for interrupt", () => {
    expect(paneClearWaitBudgetMs(config)).toBe(0);
    expect(
      paneClearWaitBudgetMs({
        ...config,
        busyPolicy: "interrupt",
        interruptRounds: 3,
        settleMs: 400,
      }),
    ).toBe(2 * 120 + 400);
  });

  it("caps settle first and rounds only when necessary", () => {
    const roomy = resolvePaneClear(
      { busyPolicy: "interrupt", interruptRounds: 5, settleMs: 10_000 },
      { maxWaitMs: 1_000 },
    );
    expect(roomy).toMatchObject({ interruptRounds: 5, settleMs: 1_000 - 4 * 120 });
    expect(paneClearWaitBudgetMs(roomy)).toBe(1_000);

    const tight = resolvePaneClear(
      { busyPolicy: "interrupt", interruptRounds: 10, settleMs: 5_000 },
      { maxWaitMs: 100 },
    );
    expect(tight).toMatchObject({ interruptRounds: 1, settleMs: 100 });
    expect(paneClearWaitBudgetMs(tight)).toBe(100);
  });
});
