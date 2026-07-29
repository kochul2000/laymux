import { describe, expect, it, vi } from "vitest";
import { TerminalOutputControlOperationRegistry } from "./terminal-output-control-registry";

describe("TerminalOutputControlOperationRegistry", () => {
  it("keeps pre-unmount operations charged across remounts of one terminal", () => {
    const registry = new TerminalOutputControlOperationRegistry(2);
    const firstMount = registry.mount("terminal-1");
    const first = firstMount.tryStart("attach");
    const second = firstMount.tryStart("attach");
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    firstMount.dispose();

    const secondMount = registry.mount("terminal-1");
    expect(secondMount.outstanding("attach")).toBe(2);
    expect(secondMount.tryStart("attach")).toBeUndefined();
  });

  it("removes stale UI waiters but wakes the current mount exactly once on late settle", () => {
    const registry = new TerminalOutputControlOperationRegistry(1);
    const staleMount = registry.mount("terminal-1");
    const operation = staleMount.tryStart("ack");
    expect(operation).toBeDefined();
    const staleRecovery = vi.fn();
    staleMount.waitForCapacity("ack", staleRecovery);
    staleMount.dispose();

    const currentMount = registry.mount("terminal-1");
    const currentRecovery = vi.fn();
    currentMount.waitForCapacity("ack", currentRecovery);
    operation?.settle();
    operation?.settle();

    expect(staleRecovery).not.toHaveBeenCalled();
    expect(currentRecovery).toHaveBeenCalledOnce();
    expect(currentMount.outstanding("ack")).toBe(0);
  });

  it("keeps attach and ACK accounting separate and prunes only settled inactive entries", () => {
    const registry = new TerminalOutputControlOperationRegistry(1);
    const mount = registry.mount("terminal-1");
    const attach = mount.tryStart("attach");
    const ack = mount.tryStart("ack");

    expect(mount.tryStart("attach")).toBeUndefined();
    expect(mount.tryStart("ack")).toBeUndefined();
    mount.dispose();
    expect(registry.entryCount()).toBe(1);

    attach?.settle();
    expect(registry.entryCount()).toBe(1);
    ack?.settle();
    expect(registry.entryCount()).toBe(0);
  });
});
