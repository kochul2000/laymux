import { afterEach, expect, it, vi } from "vitest";
import { prepareAgentClear } from "./agent-clear-composer";
import {
  registerTerminalInspector,
  unregisterTerminalInspector,
  type TerminalBufferDump,
} from "./terminal-serialize-registry";

const screen = (text: string): TerminalBufferDump => ({
  cols: 96,
  rows: 6,
  length: 6,
  baseY: 0,
  lines: ["› " + text, "", "  GPT-6.1-Sol · Context 100% left"].map((text, index) => ({
    index,
    text,
    isWrapped: false,
  })),
});
afterEach(() => {
  unregisterTerminalInspector("t");
  vi.useRealTimers();
});
it("deletes from both sides, then waits for a stable empty composer", async () => {
  vi.useFakeTimers();
  let frame = screen("unsent draft");
  registerTerminalInspector("t", () => frame);
  const write = vi.fn(async (text) => {
    expect(text).toContain("\x7f\x1b[3~");
    frame = screen("");
  });
  const run = prepareAgentClear("t", "Codex", write, () => true, Date.now() + 3000);
  await vi.advanceTimersByTimeAsync(300);
  await run;
  expect(write).toHaveBeenCalledTimes(1);
});
it("rejects replacement PTYs without more writes", async () => {
  vi.useFakeTimers();
  registerTerminalInspector("t", () => screen("draft"));
  let current = true;
  const write = vi.fn(async () => {
    current = false;
  });
  const run = prepareAgentClear("t", "Codex", write, () => current, Date.now() + 3000);
  const failure = expect(run).rejects.toThrow("scope changed");
  await vi.advanceTimersByTimeAsync(60);
  await failure;
  expect(write).toHaveBeenCalledTimes(1);
});
it("does not write if the deadline has elapsed or no screen is available", async () => {
  const write = vi.fn();
  await expect(
    prepareAgentClear("t", "Codex", write, () => true, Date.now() - 1),
  ).rejects.toThrow();
  await expect(
    prepareAgentClear("t", "Codex", write, () => true, Date.now() + 1000),
  ).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
});
