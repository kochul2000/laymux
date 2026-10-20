import { expect, it, vi } from "vitest";
const { worker, inline } = vi.hoisted(() => ({ worker: vi.fn(), inline: vi.fn() }));
vi.mock("./terminal-render-checkpoint-worker", () => ({
  TerminalRenderCheckpointWorker: class {
    constructor(options: unknown) {
      worker(options);
    }
  },
}));
vi.mock("./terminal-render-checkpoint", () => ({
  TerminalRenderCheckpointModel: class {
    constructor(options: unknown) {
      inline(options);
    }
  },
}));
import { createTerminalRenderCheckpoint } from "./terminal-render-checkpoint-factory";
it("selects Worker unless explicitly false and forwards the same admission", () => {
  const admission = { request: vi.fn(), cancel: vi.fn() };
  createTerminalRenderCheckpoint(undefined, admission);
  createTerminalRenderCheckpoint(true, admission);
  createTerminalRenderCheckpoint(false, admission);
  expect(worker).toHaveBeenCalledTimes(2);
  expect(inline).toHaveBeenCalledTimes(1);
  expect(worker).toHaveBeenLastCalledWith({ admission });
  expect(inline).toHaveBeenLastCalledWith({ admission });
});
