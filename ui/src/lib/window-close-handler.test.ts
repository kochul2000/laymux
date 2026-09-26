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

  it("coalesces repeated close requests while saving", async () => {
    let finish!: () => void;
    mockSaveBeforeClose.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const handler = createHandler();
    const first = handler(makeEvent());
    const secondEvent = makeEvent();
    const second = handler(secondEvent);
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
    expect(mockSaveBeforeClose).toHaveBeenCalledOnce();
    finish();
    await Promise.all([first, second]);
    expect(mockDestroy).toHaveBeenCalledOnce();
  });

  it("does not close while an accepted update owns finalization", async () => {
    const handler = createCloseHandler({
      destroy: mockDestroy,
      close: mockClose,
      saveBeforeClose: mockSaveBeforeClose,
      timeoutMs: 50,
      beforeClose: async () => false,
    });
    await handler(makeEvent());
    expect(mockSaveBeforeClose).not.toHaveBeenCalled();
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it("waits for an explicit choice after a save failure", async () => {
    let choose!: () => void;
    mockSaveBeforeClose.mockRejectedValueOnce(new Error("disk full"));
    const handler = createCloseHandler({
      destroy: mockDestroy,
      close: mockClose,
      saveBeforeClose: mockSaveBeforeClose,
      timeoutMs: 50,
      onSaveProblem: () =>
        new Promise<void>((resolve) => {
          choose = resolve;
        }),
    });
    const pending = handler(makeEvent());
    await vi.waitFor(() => expect(choose).toBeDefined());
    expect(mockDestroy).not.toHaveBeenCalled();
    choose();
    await pending;
    expect(mockDestroy).toHaveBeenCalledOnce();
  });
});
