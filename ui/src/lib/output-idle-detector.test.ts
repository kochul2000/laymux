import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OutputIdleDetector } from "./output-idle-detector";

describe("OutputIdleDetector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires onIdle after timeout with no output", () => {
    const onIdle = vi.fn();
    const detector = new OutputIdleDetector(3000, onIdle);

    detector.recordOutput();
    vi.advanceTimersByTime(3000);

    expect(onIdle).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it("does not fire before timeout", () => {
    const onIdle = vi.fn();
    const detector = new OutputIdleDetector(3000, onIdle);

    detector.recordOutput();
    vi.advanceTimersByTime(2999);

    expect(onIdle).not.toHaveBeenCalled();
    detector.dispose();
  });

  it("resets timer on each recordOutput call", () => {
    const onIdle = vi.fn();
    const detector = new OutputIdleDetector(3000, onIdle);

    detector.recordOutput();
    vi.advanceTimersByTime(2000);
    detector.recordOutput(); // reset timer
    vi.advanceTimersByTime(2000); // 2000ms since last output (not 4000ms total)

    expect(onIdle).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000); // now 3000ms since last output
    expect(onIdle).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it("does not fire after cancel()", () => {
    const onIdle = vi.fn();
    const detector = new OutputIdleDetector(3000, onIdle);

    detector.recordOutput();
    detector.cancel();
    vi.advanceTimersByTime(5000);

    expect(onIdle).not.toHaveBeenCalled();
    detector.dispose();
  });

  it("does not fire after dispose()", () => {
    const onIdle = vi.fn();
    const detector = new OutputIdleDetector(3000, onIdle);

    detector.recordOutput();
    detector.dispose();
    vi.advanceTimersByTime(5000);

    expect(onIdle).not.toHaveBeenCalled();
  });

  it("fires only once per idle period (not repeatedly)", () => {
    const onIdle = vi.fn();
    const detector = new OutputIdleDetector(3000, onIdle);

    detector.recordOutput();
    vi.advanceTimersByTime(3000);
    expect(onIdle).toHaveBeenCalledTimes(1);

    // No further calls without new output
    vi.advanceTimersByTime(10000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    detector.dispose();
  });

  it("fires again after new output following an idle", () => {
    const onIdle = vi.fn();
    const detector = new OutputIdleDetector(3000, onIdle);

    detector.recordOutput();
    vi.advanceTimersByTime(3000);
    expect(onIdle).toHaveBeenCalledTimes(1);

    // New output → should fire again after timeout
    detector.recordOutput();
    vi.advanceTimersByTime(3000);
    expect(onIdle).toHaveBeenCalledTimes(2);
    detector.dispose();
  });

  it("does not fire if no recordOutput was ever called", () => {
    const onIdle = vi.fn();
    const detector = new OutputIdleDetector(3000, onIdle);

    vi.advanceTimersByTime(10000);
    expect(onIdle).not.toHaveBeenCalled();
    detector.dispose();
  });
});
