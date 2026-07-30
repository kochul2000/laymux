import { describe, expect, it, vi } from "vitest";
import { TerminalOutputControlOperationRegistry } from "./terminal-output-control-registry";

describe("TerminalOutputControlOperationRegistry", () => {
  for (const kind of ["attach", "ack"] as const) {
    it(`caps ${kind} operations across different terminal ids without retaining blocked entries`, () => {
      const registry = new TerminalOutputControlOperationRegistry(2, 2);
      const firstMount = registry.mount("terminal-1");
      const secondMount = registry.mount("terminal-2");
      const first = firstMount.tryStart(kind);
      const second = secondMount.tryStart(kind);
      expect(first).toBeDefined();
      expect(second).toBeDefined();
      firstMount.dispose();
      secondMount.dispose();

      const staleBlockedMount = registry.mount("terminal-3");
      expect(staleBlockedMount.tryStart(kind)).toBeUndefined();
      expect(registry.entryCount()).toBe(2);
      expect(registry.globalOutstanding(kind)).toBe(2);
      const staleRecovery = vi.fn();
      staleBlockedMount.waitForCapacity(kind, staleRecovery);
      staleBlockedMount.dispose();

      const currentMount = registry.mount("terminal-3");
      const currentRecovery = vi.fn();
      let recoveredOperation: ReturnType<typeof currentMount.tryStart>;
      currentMount.waitForCapacity(kind, () => {
        currentRecovery();
        recoveredOperation = currentMount.tryStart(kind);
      });

      first?.settle();
      first?.settle();
      expect(staleRecovery).not.toHaveBeenCalled();
      expect(currentRecovery).toHaveBeenCalledOnce();
      expect(recoveredOperation).toBeDefined();
      expect(registry.globalOutstanding(kind)).toBe(2);
      expect(registry.entryCount()).toBe(2);

      second?.settle();
      expect(currentRecovery).toHaveBeenCalledOnce();
    });
  }

  it("rolls back a terminal lease when the global cap rejects its matching lease", () => {
    const registry = new TerminalOutputControlOperationRegistry(2, 1);
    const firstMount = registry.mount("terminal-1");
    const first = firstMount.tryStart("attach");
    expect(first).toBeDefined();

    const blockedMount = registry.mount("terminal-2");
    expect(blockedMount.tryStart("attach")).toBeUndefined();
    expect(blockedMount.outstanding("attach")).toBe(0);
    expect(blockedMount.localOutstanding("attach")).toBe(0);
    expect(blockedMount.globalOutstanding("attach")).toBe(1);
    expect(registry.globalOutstanding("attach")).toBe(1);
    expect(registry.entryCount()).toBe(1);
  });

  it("wakes global capacity waiters in FIFO order, one per returned slot", () => {
    const registry = new TerminalOutputControlOperationRegistry(1, 1);
    const owner = registry.mount("owner");
    const occupied = owner.tryStart("attach");
    const order: string[] = [];
    const firstWaiter = registry.mount("waiter-1");
    const secondWaiter = registry.mount("waiter-2");
    let firstRecovered: ReturnType<typeof firstWaiter.tryStart>;
    firstWaiter.waitForCapacity("attach", () => {
      order.push("first");
      firstRecovered = firstWaiter.tryStart("attach");
    });
    secondWaiter.waitForCapacity("attach", () => order.push("second"));

    occupied?.settle();
    expect(order).toEqual(["first"]);
    firstRecovered?.settle();
    expect(order).toEqual(["first", "second"]);
  });

  it("reserves a returned global slot for the selected waiter until start or unmount", () => {
    const registry = new TerminalOutputControlOperationRegistry(1, 1);
    const owner = registry.mount("owner");
    const occupied = owner.tryStart("attach");
    const selected = registry.mount("selected");
    const selectedRecovery = vi.fn();
    selected.waitForCapacity("attach", selectedRecovery);

    occupied?.settle();
    expect(selectedRecovery).toHaveBeenCalledOnce();
    expect(registry.globalOutstanding("attach")).toBe(1);

    const barger = registry.mount("barger");
    expect(barger.tryStart("attach")).toBeUndefined();
    const selectedOperation = selected.tryStart("attach");
    expect(selectedOperation).toBeDefined();
    expect(registry.globalOutstanding("attach")).toBe(1);

    selectedOperation?.settle();
    expect(registry.globalOutstanding("attach")).toBe(0);
  });

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

  it("counts only marked timeouts as orphans and releases both counters on settlement", () => {
    const registry = new TerminalOutputControlOperationRegistry(2, 2);
    const firstMount = registry.mount("terminal-1");
    const secondMount = registry.mount("terminal-2");
    const healthy = firstMount.tryStart("receipt");
    const orphan = secondMount.tryStart("hold");

    expect(firstMount.globalOutstanding("close")).toBe(2);
    expect(firstMount.globalTimedOut("close")).toBe(0);
    expect(firstMount.localTimedOut("receipt")).toBe(0);
    expect(secondMount.localTimedOut("hold")).toBe(0);

    orphan?.markTimedOut();
    orphan?.markTimedOut();
    expect(firstMount.globalTimedOut("receipt")).toBe(1);
    expect(firstMount.localTimedOut("receipt")).toBe(0);
    expect(secondMount.localTimedOut("close")).toBe(1);

    healthy?.settle();
    expect(firstMount.globalOutstanding("receipt")).toBe(1);
    expect(firstMount.globalTimedOut("receipt")).toBe(1);
    orphan?.settle();
    orphan?.settle();
    expect(firstMount.globalOutstanding("receipt")).toBe(0);
    expect(firstMount.globalTimedOut("receipt")).toBe(0);
  });

  it("distinguishes normal ACK saturation from a timed-out orphan hard cap", () => {
    const registry = new TerminalOutputControlOperationRegistry(2, 2);
    const scope = registry.mount("terminal-1");
    const first = scope.tryStart("ack");
    const second = scope.tryStart("ack");

    expect(scope.canStart("ack")).toBe(false);
    expect(scope.orphanCapacityExhausted("ack")).toBe(false);
    first?.markTimedOut();
    expect(scope.orphanCapacityExhausted("ack")).toBe(false);
    second?.markTimedOut();
    expect(scope.orphanCapacityExhausted("ack")).toBe(true);

    first?.settle();
    expect(scope.orphanCapacityExhausted("ack")).toBe(false);
    second?.settle();
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

  it("shares one bounded delivery-control budget across receipt, hold, and close", () => {
    const registry = new TerminalOutputControlOperationRegistry(2, 2);
    const firstMount = registry.mount("terminal-1");
    const secondMount = registry.mount("terminal-2");

    const receipt = firstMount.tryStart("receipt");
    const hold = firstMount.tryStart("hold");
    expect(receipt).toBeDefined();
    expect(hold).toBeDefined();
    expect(firstMount.tryStart("close")).toBeUndefined();
    expect(secondMount.tryStart("close")).toBeUndefined();
    expect(registry.globalOutstanding("receipt")).toBe(2);
    expect(registry.globalOutstanding("hold")).toBe(2);
    expect(registry.globalOutstanding("close")).toBe(2);

    // Existing attach/ACK domains remain independently available. Phase B
    // must not silently change the Phase C admission policy.
    expect(secondMount.tryStart("attach")).toBeDefined();
    expect(secondMount.tryStart("ack")).toBeDefined();

    receipt?.settle();
    expect(secondMount.tryStart("close")).toBeDefined();
  });

  it("wakes mixed delivery-control waiters in one FIFO order", () => {
    const registry = new TerminalOutputControlOperationRegistry(1, 1);
    const owner = registry.mount("owner");
    const occupied = owner.tryStart("receipt");
    const order: string[] = [];
    const holdWaiter = registry.mount("hold-waiter");
    const closeWaiter = registry.mount("close-waiter");
    let held: ReturnType<typeof holdWaiter.tryStart>;

    holdWaiter.waitForCapacity("hold", () => {
      order.push("hold");
      held = holdWaiter.tryStart("hold");
    });
    closeWaiter.waitForCapacity("close", () => order.push("close"));

    occupied?.settle();
    expect(order).toEqual(["hold"]);
    held?.settle();
    expect(order).toEqual(["hold", "close"]);
  });
});
