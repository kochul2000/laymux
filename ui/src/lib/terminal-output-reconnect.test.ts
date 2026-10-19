import { describe, expect, it, vi } from "vitest";
import { TerminalOutputReconnect } from "./terminal-output-reconnect";

describe("TerminalOutputReconnect", () => {
  it("does not reconnect idle output and tries a failed pane only once per return", async () => {
    const reconnect = vi.fn().mockRejectedValue(new Error("offline"));
    const recovery = new TerminalOutputReconnect(reconnect, vi.fn());
    recovery.enter();
    await recovery.failed();
    await recovery.failed();
    expect(reconnect).toHaveBeenCalledTimes(1);
    recovery.leave();
    recovery.enter();
    await recovery.failed();
    expect(reconnect).toHaveBeenCalledTimes(2);
  });

  it("allows manual retries after failure and shares one in-flight attempt", async () => {
    let complete!: () => void;
    const reconnect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const states = vi.fn();
    const recovery = new TerminalOutputReconnect(reconnect, states);
    recovery.enter();
    const first = recovery.failed();
    const second = recovery.retry();
    await Promise.resolve();
    expect(reconnect).toHaveBeenCalledTimes(1);
    complete();
    await Promise.all([first, second]);
    expect(states).toHaveBeenLastCalledWith("idle");
    const third = recovery.retry();
    await Promise.resolve();
    complete();
    await third;
    expect(reconnect).toHaveBeenCalledTimes(2);
  });

  it("keeps hidden failures idle and ignores a completion after unmount", async () => {
    let complete!: () => void;
    const reconnect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const states = vi.fn();
    const recovery = new TerminalOutputReconnect(reconnect, states);
    await recovery.failed();
    expect(reconnect).not.toHaveBeenCalled();
    recovery.enter();
    const attempt = recovery.failed();
    await Promise.resolve();
    recovery.dispose();
    complete();
    await attempt;
    expect(states).toHaveBeenCalledTimes(1);
    expect(states).toHaveBeenCalledWith("reconnecting");
  });
});
