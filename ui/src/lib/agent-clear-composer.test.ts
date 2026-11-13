import { afterEach, expect, it, vi } from "vitest";
import { prepareAgentClear } from "./agent-clear-composer";
import {
  registerTerminalInspector,
  unregisterTerminalInspector,
  registerTerminalPtyInspector,
  unregisterTerminalPtyInspector,
  type TerminalBufferDump,
} from "./terminal-serialize-registry";

const screen = (
  text: string,
  footer = "  GPT-6.1-Sol · Context 100% left",
): TerminalBufferDump => ({
  cols: 96,
  rows: 6,
  length: 6,
  baseY: 0,
  lines: ["› " + text, "", footer].map((text, index) => ({
    index,
    text,
    isWrapped: false,
  })),
});
afterEach(() => {
  unregisterTerminalInspector("t");
  unregisterTerminalPtyInspector("t");
  vi.useRealTimers();
});
it.each(["  GPT-6.1-Sol · Context 100% left", "  GPT-6.1-Sol high Fast · …"])(
  "초안을 지운 뒤 빈 입력창이 안정될 때만 제출한다: %s",
  async (footer) => {
    vi.useFakeTimers();
    let frame = screen("unsent draft", footer);
    registerTerminalPtyInspector("t", async () => ({ ...frame, generation: 1, seq: 10 }));
    const write = vi.fn(async () => {
      frame = screen("", footer);
    });
    const submit = vi.fn(async () => {});
    const run = prepareAgentClear("t", "Codex", 1, write, () => true, Date.now() + 3000, submit);
    await vi.advanceTimersByTimeAsync(180);
    expect(submit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120);
    await run;
    expect(write).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledTimes(1);
  },
);
it("rejects replacement PTYs without more writes", async () => {
  vi.useFakeTimers();
  registerTerminalPtyInspector("t", async () => ({ ...screen("draft"), generation: 1, seq: 10 }));
  let current = true;
  const write = vi.fn(async () => {
    current = false;
  });
  const run = prepareAgentClear("t", "Codex", 1, write, () => current, Date.now() + 3000);
  const failure = expect(run).rejects.toThrow("scope changed");
  await vi.advanceTimersByTimeAsync(60);
  await failure;
  expect(write).toHaveBeenCalledTimes(1);
});
it("does not write if the deadline has elapsed or no screen is available", async () => {
  const write = vi.fn();
  await expect(
    prepareAgentClear("t", "Codex", 1, write, () => true, Date.now() - 1),
  ).rejects.toThrow();
  await expect(
    prepareAgentClear("t", "Codex", 1, write, () => true, Date.now() + 1000),
  ).rejects.toThrow();
  expect(write).not.toHaveBeenCalled();
});

it("PC 격자가 좁아도 현재 PTY 격자를 검사한 뒤 지운다", async () => {
  vi.useFakeTimers();
  registerTerminalInspector("t", () => ({ ...screen(""), cols: 26 }));
  let draft = "draft";
  registerTerminalPtyInspector("t", async () => ({ ...screen(draft), generation: 7, seq: 10 }));
  const erase = vi.fn(async () => {
    draft = "";
  });
  const submit = vi.fn(async () => {});
  const run = prepareAgentClear("t", "Codex", 7, erase, () => true, Date.now() + 3000, submit);
  await vi.advanceTimersByTimeAsync(300);
  await run;
  expect(erase).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledTimes(1);
});

it("PTY 화면이 없거나 다른 세대이면 PC의 빈 입력창으로 대체하지 않는다", async () => {
  registerTerminalInspector("t", () => screen(""));
  const erase = vi.fn(async () => {});
  await expect(
    prepareAgentClear("t", "Codex", 7, erase, () => true, Date.now() + 3000),
  ).rejects.toThrow("unavailable");
  registerTerminalPtyInspector("t", async () => ({ ...screen(""), generation: 6, seq: 10 }));
  await expect(
    prepareAgentClear("t", "Codex", 7, erase, () => true, Date.now() + 3000),
  ).rejects.toThrow("generation changed");
  registerTerminalPtyInspector("t", async () => {
    throw new Error("worker failed");
  });
  await expect(
    prepareAgentClear("t", "Codex", 7, erase, () => true, Date.now() + 3000),
  ).rejects.toThrow("worker failed");
  expect(erase).not.toHaveBeenCalled();
});

it("비동기 화면 판독 중 대상 교체와 기한 초과 뒤에는 입력하지 않는다", async () => {
  vi.useFakeTimers();
  let current = true;
  const erase = vi.fn(async () => {});
  registerTerminalPtyInspector("t", async () => {
    current = false;
    return { ...screen(""), generation: 7, seq: 10 };
  });
  await expect(
    prepareAgentClear("t", "Codex", 7, erase, () => current, Date.now() + 3000),
  ).rejects.toThrow("scope changed");
  registerTerminalPtyInspector("t", () => new Promise(() => {}));
  const run = prepareAgentClear("t", "Codex", 7, erase, () => true, Date.now() + 3000);
  const failed = expect(run).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(3000);
  await failed;
  expect(erase).not.toHaveBeenCalled();
});
