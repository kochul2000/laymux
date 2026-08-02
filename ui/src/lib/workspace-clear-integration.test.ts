import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/tauri-api", () => ({
  writeTerminalInput: vi.fn().mockResolvedValue(undefined),
  writeToTerminal: vi.fn().mockResolvedValue(undefined),
}));

import { writeTerminalInput, writeToTerminal } from "@/lib/tauri-api";
import { clearWorkspace } from "./workspace-clear";
import { runWorkspaceClearFromUi } from "./workspace-clear-action";
import { useSettingsStore } from "@/stores/settings-store";
import { useTerminalRestartStore } from "@/stores/terminal-restart-store";
import { useTerminalStore } from "@/stores/terminal-store";
import { useWorkspaceStore } from "@/stores/workspace-store";

/**
 * `clearWorkspace` end to end against the real stores and the mocked Tauri
 * commands. The dependency-injected `runWorkspaceClear` tests cover the
 * planning and timing; what only this file can catch is the WIRING — swapping
 * the raw `write_to_terminal` Ctrl+C for the bracketed-paste-aware structured
 * path passes every injected-mock test while shipping `\x1b[200~\x03\x1b[201~`,
 * which is pasted text and not an interrupt at all (ADR-0113).
 */

const CTRL_C = "\x03";

function seedWorkspace() {
  useWorkspaceStore.setState({
    workspaces: [
      {
        id: "ws-clear",
        name: "Clear",
        panes: [
          { id: "pane-a", x: 0, y: 0, w: 0.5, h: 1, view: { type: "TerminalView" } },
          {
            id: "pane-b",
            x: 0.5,
            y: 0,
            w: 0.5,
            h: 1,
            view: { type: "TerminalView", lastCwd: "/saved/cwd" },
          },
          { id: "pane-m", x: 0, y: 1, w: 1, h: 0, view: { type: "MemoView" } },
        ],
      },
    ],
    activeWorkspaceId: "ws-clear",
    workspaceDisplayOrder: [],
  });
  for (const paneId of ["pane-a", "pane-b"]) {
    useTerminalStore.getState().registerInstance({
      id: `terminal-${paneId}`,
      profile: "PowerShell",
      syncGroup: "ws-clear",
      workspaceId: "ws-clear",
    });
    useTerminalStore.getState().updateInstanceInfo(`terminal-${paneId}`, { sessionReady: true });
  }
}

/** Mark a pane busy the way a running Claude task looks. */
function makeBusy(paneId: string) {
  useTerminalStore.getState().updateInstanceInfo(`terminal-${paneId}`, {
    activity: { type: "interactiveApp", name: "Claude" },
    title: "✻ Working on it",
  });
}

describe("clearWorkspace (real stores)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useTerminalRestartStore.setState({ requests: {} });
  });

  it("submits the shell command through the human-input path", async () => {
    seedWorkspace();

    const result = await clearWorkspace("ws-clear");

    expect(vi.mocked(writeTerminalInput).mock.calls).toEqual([
      ["terminal-pane-a", "clear", true],
      ["terminal-pane-b", "clear", true],
    ]);
    expect(vi.mocked(writeToTerminal)).not.toHaveBeenCalled();
    expect(result.cleared).toEqual(["terminal-pane-a", "terminal-pane-b"]);
  });

  it("sends /clear to an agent pane", async () => {
    seedWorkspace();
    useTerminalStore.getState().updateInstanceInfo("terminal-pane-a", {
      activity: { type: "interactiveApp", name: "Codex" },
    });

    await clearWorkspace("ws-clear");

    expect(vi.mocked(writeTerminalInput)).toHaveBeenCalledWith("terminal-pane-a", "/clear", true);
    expect(vi.mocked(writeTerminalInput)).toHaveBeenCalledWith("terminal-pane-b", "clear", true);
  });

  // The one line this whole file exists for.
  it("sends Ctrl+C as a raw byte, not through the structured input path", async () => {
    seedWorkspace();
    makeBusy("pane-a");

    await clearWorkspace("ws-clear", {
      busyPolicy: "interrupt",
      interruptRounds: 2,
      settleMs: 0,
    });

    expect(vi.mocked(writeToTerminal).mock.calls).toEqual([
      ["terminal-pane-a", CTRL_C],
      ["terminal-pane-a", CTRL_C],
    ]);
    // The ETX never goes through the bracketed-paste-aware command...
    expect(vi.mocked(writeTerminalInput)).not.toHaveBeenCalledWith(
      "terminal-pane-a",
      CTRL_C,
      expect.anything(),
    );
    // ...and the clear text still does, after the interrupt.
    expect(vi.mocked(writeTerminalInput)).toHaveBeenCalledWith("terminal-pane-a", "/clear", true);
  });

  it("requests a restart with the pane's cwd and types nothing", async () => {
    seedWorkspace();
    makeBusy("pane-b");
    useTerminalStore.getState().updateInstanceInfo("terminal-pane-b", { cwd: "/live/cwd" });

    const result = await clearWorkspace("ws-clear", { busyPolicy: "restart" });

    expect(useTerminalRestartStore.getState().requests["pane-b"]).toEqual({
      epoch: 1,
      cwd: "/live/cwd",
      fresh: true,
    });
    expect(result.restarted).toEqual(["terminal-pane-b"]);
    // Only the idle pane was written to.
    expect(vi.mocked(writeTerminalInput).mock.calls).toEqual([["terminal-pane-a", "clear", true]]);
  });

  it("falls back to the saved cwd when the session never reported one", async () => {
    seedWorkspace();
    makeBusy("pane-b");

    await clearWorkspace("ws-clear", { busyPolicy: "restart" });

    expect(useTerminalRestartStore.getState().requests["pane-b"].cwd).toBe("/saved/cwd");
  });

  it("reports an unknown workspace as an empty run rather than throwing", async () => {
    seedWorkspace();
    const result = await clearWorkspace("ws-missing");
    expect(result.cleared).toEqual([]);
    expect(vi.mocked(writeTerminalInput)).not.toHaveBeenCalled();
  });
});

describe("runWorkspaceClearFromUi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useTerminalRestartStore.setState({ requests: {} });
  });

  it("reads the busy policy from the settings store", async () => {
    seedWorkspace();
    makeBusy("pane-a");
    useSettingsStore.getState().setWorkspaceClear({ busyPolicy: "restart" });

    const result = await runWorkspaceClearFromUi("ws-clear");

    expect(result?.restarted).toEqual(["terminal-pane-a"]);
  });

  // A silent no-op is indistinguishable from a broken shortcut.
  it("warns when the run touched nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedWorkspace();
    makeBusy("pane-a");
    makeBusy("pane-b");

    const result = await runWorkspaceClearFromUi("ws-clear");

    expect(result?.skipped).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("nothing cleared"));
    warn.mockRestore();
  });

  it("stays quiet on a clean run", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedWorkspace();

    await runWorkspaceClearFromUi("ws-clear");

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("names each rejected terminal", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedWorkspace();
    vi.mocked(writeTerminalInput).mockRejectedValue(new Error("controlled by a remote client"));

    const result = await runWorkspaceClearFromUi("ws-clear");

    expect(result?.failed.map((entry) => entry.terminalId)).toEqual([
      "terminal-pane-a",
      "terminal-pane-b",
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("terminal-pane-a: controlled by a remote client"),
    );
    warn.mockRestore();
  });
});

describe("clearWorkspace deadline (ADR-0113)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // `clearAllMocks` keeps implementations, and an earlier suite leaves the
    // write rejecting — restore the happy path explicitly.
    vi.mocked(writeTerminalInput).mockResolvedValue(undefined);
    vi.mocked(writeToTerminal).mockResolvedValue(undefined);
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useTerminalStore.setState(useTerminalStore.getInitialState());
    useSettingsStore.setState(useSettingsStore.getInitialState());
    useTerminalRestartStore.setState({ requests: {} });
  });

  // A PTY write can sit in the control queue for 15s and JS cannot cancel it.
  // What must not happen is the chain typing MORE after the caller gave up —
  // the caller's retry would then double the input. `maxWaitMs` has to reach
  // the executor as a deadline, not only as a sleep trim.
  it("stops mid-chain once maxWaitMs has elapsed, and never submits the clear", async () => {
    seedWorkspace();
    makeBusy("pane-a");
    makeBusy("pane-b");
    // Every Ctrl+C is slower than the whole budget.
    vi.mocked(writeToTerminal).mockImplementation(
      () => new Promise<void>((resolve) => setTimeout(resolve, 40)),
    );

    const result = await clearWorkspace(
      "ws-clear",
      { busyPolicy: "interrupt", interruptRounds: 4, settleMs: 0 },
      { maxWaitMs: 20, hardDeadlineMs: 20 },
    );

    // One press per pane landed, then the budget stopped the chain.
    expect(vi.mocked(writeToTerminal)).toHaveBeenCalledTimes(2);
    expect(result.interrupted).toEqual(["terminal-pane-a", "terminal-pane-b"]);
    expect(result.cleared).toEqual([]);
    // The clear text is never typed after the caller has given up.
    expect(vi.mocked(writeTerminalInput)).not.toHaveBeenCalled();
    expect(result.failed.map((entry) => entry.terminalId)).toEqual([
      "terminal-pane-a",
      "terminal-pane-b",
    ]);
  });

  it("leaves every pane alone when nothing is over budget", async () => {
    seedWorkspace();

    const result = await clearWorkspace("ws-clear", undefined, {
      maxWaitMs: 5_000,
      hardDeadlineMs: 5_000,
    });

    expect(result.failed).toEqual([]);
    expect(result.cleared).toEqual(["terminal-pane-a", "terminal-pane-b"]);
  });
});
