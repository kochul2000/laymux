import { describe, it, expect, beforeEach } from "vitest";
import { useTerminalRestartStore } from "./terminal-restart-store";

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
