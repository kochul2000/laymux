import { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import {
  isBootstrapPrimaryDeviceAttributesReply,
  routeXtermData,
  subscribeXtermUserInputOrigin,
} from "./terminal-data-route";

describe("routeXtermData", () => {
  it("routes live-parser replies through the protocol path", () => {
    expect(
      routeXtermData({
        writeSource: "live",
        humanEventActive: false,
        userInputOriginReliable: true,
      }),
    ).toBe("protocol");
  });

  it("suppresses replies generated while replaying cache or snapshots", () => {
    expect(
      routeXtermData({
        writeSource: "replay",
        humanEventActive: false,
        userInputOriginReliable: true,
      }),
    ).toBe("suppress");
  });

  it("recognizes only xterm's pinned primary device-attributes reply for bootstrap recovery", () => {
    expect(isBootstrapPrimaryDeviceAttributesReply("\x1b[?1;2c")).toBe(true);
    expect(isBootstrapPrimaryDeviceAttributesReply("\x1b[O")).toBe(false);
    expect(isBootstrapPrimaryDeviceAttributesReply("\x1b]10;rgb:ffff/ffff/ffff\x1b\\")).toBe(false);
  });

  it("keeps human events on the owner-gated path even while a write is being parsed", () => {
    expect(
      routeXtermData({
        writeSource: "live",
        humanEventActive: true,
        userInputOriginReliable: true,
      }),
    ).toBe("human");
  });

  it("treats data outside parser writes as human input", () => {
    expect(
      routeXtermData({
        writeSource: undefined,
        humanEventActive: false,
        userInputOriginReliable: true,
      }),
    ).toBe("human");
  });

  it("fails closed to the human route when the xterm user-origin signal is unavailable", () => {
    expect(
      routeXtermData({
        writeSource: "live",
        humanEventActive: false,
        userInputOriginReliable: false,
      }),
    ).toBe("human");
  });

  it("subscribes to xterm CoreService's synchronous user-input origin signal", () => {
    let listener: (() => void) | undefined;
    const dispose = vi.fn();
    const terminal = {
      _core: {
        coreService: {
          onUserInput(next: () => void) {
            listener = next;
            return { dispose };
          },
        },
      },
    };
    const onUserInput = vi.fn();

    const subscription = subscribeXtermUserInputOrigin(terminal, onUserInput);
    listener?.();
    subscription?.dispose();

    expect(onUserInput).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("returns undefined instead of trusting a missing private origin signal", () => {
    expect(subscribeXtermUserInputOrigin({}, vi.fn())).toBeUndefined();
  });

  it("observes the pinned xterm user-origin signal before public onData", () => {
    const terminal = new Terminal();
    const order: string[] = [];
    const originSubscription = subscribeXtermUserInputOrigin(terminal, () => {
      order.push("origin");
    });
    const dataSubscription = terminal.onData(() => {
      order.push("data");
    });

    terminal.input("human", true);

    expect(originSubscription).toBeDefined();
    expect(order).toEqual(["origin", "data"]);
    dataSubscription.dispose();
    originSubscription?.dispose();
    terminal.dispose();
  });

  it("keeps parser replies while disableStdin blocks actual user input", () => {
    const terminal = new Terminal({ disableStdin: true });
    const onData = vi.fn();
    const subscription = terminal.onData(onData);

    terminal.input("human", true);
    terminal.input("protocol", false);

    expect(onData).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith("protocol");
    subscription.dispose();
    terminal.dispose();
  });
});
