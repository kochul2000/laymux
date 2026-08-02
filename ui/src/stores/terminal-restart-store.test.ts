import { describe, it, expect, beforeEach } from "vitest";
import { useTerminalRestartStore } from "./terminal-restart-store";
import { useWorkspaceStore } from "./workspace-store";
import { useDockStore } from "./dock-store";

describe("terminal-restart-store", () => {
  beforeEach(() => {
    useTerminalRestartStore.setState({ requests: {} });
  });

  it("starts a pane at epoch 1 and marks it fresh", () => {
    useTerminalRestartStore.getState().requestRestart("pane-a", "/home/user");
    expect(useTerminalRestartStore.getState().requests["pane-a"]).toEqual({
      epoch: 1,
      cwd: "/home/user",
      fresh: true,
    });
  });

  it("bumps the epoch on every request so the view remounts again", () => {
    const { requestRestart } = useTerminalRestartStore.getState();
    requestRestart("pane-a");
    requestRestart("pane-a");
    expect(useTerminalRestartStore.getState().requests["pane-a"].epoch).toBe(2);
  });

  it("keeps panes independent", () => {
    const { requestRestart } = useTerminalRestartStore.getState();
    requestRestart("pane-a");
    requestRestart("pane-b");
    requestRestart("pane-b");
    const { requests } = useTerminalRestartStore.getState();
    expect(requests["pane-a"].epoch).toBe(1);
    expect(requests["pane-b"].epoch).toBe(2);
  });

  // A consumed request must stay consumed: a later remount for an unrelated
  // reason would otherwise skip session restore and drop the scrollback.
  it("clears fresh once and is idempotent afterwards", () => {
    const store = useTerminalRestartStore.getState();
    store.requestRestart("pane-a");
    store.consumeRestart("pane-a");
    const consumed = useTerminalRestartStore.getState().requests;
    store.consumeRestart("pane-a");
    expect(useTerminalRestartStore.getState().requests).toBe(consumed);
    expect(consumed["pane-a"]).toEqual({ epoch: 1, cwd: undefined, fresh: false });
  });

  it("re-arms fresh when the same pane is restarted again", () => {
    const store = useTerminalRestartStore.getState();
    store.requestRestart("pane-a");
    store.consumeRestart("pane-a");
    store.requestRestart("pane-a", "/tmp");
    expect(useTerminalRestartStore.getState().requests["pane-a"]).toEqual({
      epoch: 2,
      cwd: "/tmp",
      fresh: true,
    });
  });

  it("ignores consume and forget for an unknown pane", () => {
    const before = useTerminalRestartStore.getState().requests;
    useTerminalRestartStore.getState().consumeRestart("pane-missing");
    useTerminalRestartStore.getState().forgetRestart("pane-missing");
    expect(useTerminalRestartStore.getState().requests).toBe(before);
  });

  it("drops a pane's request on forget", () => {
    const store = useTerminalRestartStore.getState();
    store.requestRestart("pane-a");
    store.forgetRestart("pane-a");
    expect(useTerminalRestartStore.getState().requests).toEqual({});
  });
});

// The restart request is pane-scoped state, so it follows the same lifecycle
// contract as the override and cwd-propagate stores (ADR-0113).
describe("terminal-restart-store pane lifecycle", () => {
  beforeEach(() => {
    useTerminalRestartStore.setState({ requests: {} });
    useWorkspaceStore.setState(useWorkspaceStore.getInitialState());
    useDockStore.setState(useDockStore.getInitialState());
  });

  it("drops the request when its workspace pane is removed", () => {
    const ws = useWorkspaceStore.getState().getActiveWorkspace()!;
    const victim = ws.panes[1].id;
    useTerminalRestartStore.getState().requestRestart(victim);

    useWorkspaceStore.getState().removePane(1);

    expect(useTerminalRestartStore.getState().requests[victim]).toBeUndefined();
  });

  it("drops requests for every pane of a removed workspace", () => {
    useWorkspaceStore.getState().addWorkspace("Second", "default-layout");
    const victim = useWorkspaceStore.getState().workspaces[1];
    for (const pane of victim.panes) {
      useTerminalRestartStore.getState().requestRestart(pane.id);
    }

    useWorkspaceStore.getState().removeWorkspace(victim.id);

    expect(useTerminalRestartStore.getState().requests).toEqual({});
  });

  it("drops the request when a dock pane is removed", () => {
    const right = useDockStore.getState().getDock("right")!;
    const victim = right.panes[1].id;
    useTerminalRestartStore.getState().requestRestart(victim);

    useDockStore.getState().removeDockPane("right", victim);

    expect(useTerminalRestartStore.getState().requests[victim]).toBeUndefined();
  });

  // A restored session swaps the whole workspace array without going through
  // removePane, so the startup sweep is the only thing that catches those.
  it("gcStale keeps live panes and drops the rest", () => {
    const store = useTerminalRestartStore.getState();
    store.requestRestart("alive");
    store.requestRestart("gone");

    store.gcStale(new Set(["alive"]));

    expect(Object.keys(useTerminalRestartStore.getState().requests)).toEqual(["alive"]);
  });

  it("gcStale keeps the same object when nothing is stale", () => {
    useTerminalRestartStore.getState().requestRestart("alive");
    const before = useTerminalRestartStore.getState().requests;

    useTerminalRestartStore.getState().gcStale(new Set(["alive", "other"]));

    expect(useTerminalRestartStore.getState().requests).toBe(before);
  });
});
