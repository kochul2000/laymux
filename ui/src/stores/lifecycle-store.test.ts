import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLifecycleStore, waitForCloseDecision } from "./lifecycle-store";

beforeEach(() => useLifecycleStore.setState(useLifecycleStore.getInitialState()));

describe("close cancellation", () => {
  it("waits for failed preparation to settle before offering cancellation", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_, fail) => {
      reject = fail;
    });
    const decision = waitForCloseDecision("timeout", pending);
    expect(useLifecycleStore.getState().cancelClose).toBeNull();
    reject(new Error("status could not be verified"));
    await vi.waitFor(() => expect(useLifecycleStore.getState().cancelClose).not.toBeNull());
    useLifecycleStore.getState().cancelClose?.();
    await expect(decision).resolves.toBe(false);
    expect(useLifecycleStore.getState().forceClose).toBeNull();
    expect(useLifecycleStore.getState().cancelClose).toBeNull();
  });

  it("allows a successful pending save to finish closing", async () => {
    await expect(waitForCloseDecision("timeout", Promise.resolve())).resolves.toBe(true);
    expect(useLifecycleStore.getState().cancelClose).toBeNull();
  });
});
