import { describe, it, expect, vi, beforeEach } from "vitest";
import { createCloseHandler } from "./window-close-handler";

describe("createCloseHandler", () => {
  const mockDestroy = vi.fn<() => Promise<void>>();
  const mockClose = vi.fn<() => Promise<void>>();
  const mockSaveBeforeClose = vi.fn<() => Promise<void>>();
  function makeEvent() {
    return { preventDefault: vi.fn() };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockDestroy.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockSaveBeforeClose.mockResolvedValue(undefined);
  });

  function createHandler(timeoutMs = 5000) {
    return createCloseHandler({
      destroy: mockDestroy,
      close: mockClose,
      saveBeforeClose: mockSaveBeforeClose,
      timeoutMs,
    });
  }

  it("calls preventDefault, saveBeforeClose, then destroy", async () => {
    const handler = createHandler();
    const event = makeEvent();

    await handler(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(mockSaveBeforeClose).toHaveBeenCalledTimes(1);
    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it("calls destroy even when saveBeforeClose rejects", async () => {
    mockSaveBeforeClose.mockRejectedValueOnce(new Error("save failed"));
    const handler = createHandler();

    await handler(makeEvent());

    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it("calls destroy even when saveBeforeClose times out", async () => {
    mockSaveBeforeClose.mockImplementation(
      () => new Promise(() => {}), // never resolves
    );
    const handler = createHandler(50); // short timeout

    await handler(makeEvent());

    expect(mockDestroy).toHaveBeenCalledTimes(1);
  });

  it("falls back to close() when destroy() rejects", async () => {
    mockDestroy.mockRejectedValueOnce(new Error("permission denied"));
    const handler = createHandler();

    await handler(makeEvent());

    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledTimes(1);
  });

  it("second invocation skips preventDefault (forceClose path)", async () => {
    mockDestroy.mockRejectedValueOnce(new Error("permission denied"));
    const handler = createHandler();

    // First call: destroy fails -> close() triggers handler again
    const event1 = makeEvent();
    await handler(event1);
    expect(event1.preventDefault).toHaveBeenCalledTimes(1);
    expect(mockClose).toHaveBeenCalledTimes(1);

    // Simulate the re-entrant close-requested event
    const event2 = makeEvent();
    await handler(event2);

    // Second call: forceClose=true, preventDefault NOT called, returns immediately
    expect(event2.preventDefault).not.toHaveBeenCalled();
    expect(mockSaveBeforeClose).toHaveBeenCalledTimes(1); // still only once from first call
  });

  it("does not call close() when destroy() succeeds", async () => {
    const handler = createHandler();

    await handler(makeEvent());

    expect(mockDestroy).toHaveBeenCalledTimes(1);
    expect(mockClose).not.toHaveBeenCalled();
  });
});
