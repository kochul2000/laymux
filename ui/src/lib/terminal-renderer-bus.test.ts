import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  publishRendererRefresh,
  subscribeRendererRefresh,
  _resetRendererBus,
  type RendererRefreshSignal,
} from "./terminal-renderer-bus";

describe("terminal-renderer-bus", () => {
  beforeEach(() => {
    _resetRendererBus();
  });

  it("delivers a published signal to subscribers", () => {
    const listener = vi.fn();
    subscribeRendererRefresh(listener);

    const signal: RendererRefreshSignal = { reason: "peer-tui-exit", sourceId: "term-A" };
    publishRendererRefresh(signal);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(signal);
  });

  it("delivers to all subscribers", () => {
    const a = vi.fn();
    const b = vi.fn();
    subscribeRendererRefresh(a);
    subscribeRendererRefresh(b);

    publishRendererRefresh({ reason: "peer-tui-exit", sourceId: "term-X" });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes via the returned dispose function", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeRendererRefresh(listener);
    unsubscribe();

    publishRendererRefresh({ reason: "peer-tui-exit", sourceId: "term-A" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("does not invoke a listener for its own published signal when the listener filters by sourceId", () => {
    // Consumers are responsible for self-skip; this test documents the contract.
    const selfId = "term-self";
    const handler = vi.fn((signal: RendererRefreshSignal) => {
      if (signal.sourceId === selfId) return;
      handler.handled = true;
    }) as unknown as ReturnType<typeof vi.fn> & { handled?: boolean };
    subscribeRendererRefresh(handler);

    publishRendererRefresh({ reason: "peer-tui-exit", sourceId: selfId });

    expect(handler).toHaveBeenCalledTimes(1);
    expect((handler as unknown as { handled?: boolean }).handled).toBeUndefined();
  });

  it("isolates listener errors so other subscribers still receive the signal", () => {
    const broken = vi.fn(() => {
      throw new Error("boom");
    });
    const ok = vi.fn();
    subscribeRendererRefresh(broken);
    subscribeRendererRefresh(ok);

    expect(() =>
      publishRendererRefresh({ reason: "peer-tui-exit", sourceId: "term-A" }),
    ).not.toThrow();
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it("supports the peer-context-loss reason", () => {
    const listener = vi.fn();
    subscribeRendererRefresh(listener);

    publishRendererRefresh({ reason: "peer-context-loss", sourceId: "term-Y" });

    expect(listener).toHaveBeenCalledWith({
      reason: "peer-context-loss",
      sourceId: "term-Y",
    });
  });
});
