import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  getTerminalInspector,
  getTerminalRenderCheckpointProvider,
  type TerminalBufferDump,
} from "./terminal-serialize-registry";
import { withCodexStatusCheckpoint } from "./codex-status-probe";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./terminal-serialize-registry", () => ({
  getTerminalInspector: vi.fn(),
  getTerminalRenderCheckpointProvider: vi.fn(),
}));
vi.mock("./terminal-checkpoint-geometry", () => ({
  acquireCheckpointGeometry: () => () => {},
}));

const BUSY = "• Working (12h 49m 28s • esc to interrupt)\n\n› Ask Codex to do anything\n\n  GPT-6";
const IDLE = "■ Conversation interrupted\n\n› Ask Codex to do anything\n\n  GPT-6";
const EMPTY = "› Ask Codex to do anything\n\n  GPT-6";
const SELECTED = "› /status     show current session configuration\n\n› /statu\n\n  GPT-6";
const geometry = { rows: 40, cols: 96, revision: 1 };

function frame(text: string): TerminalBufferDump {
  const lines = text.split("\n").map((text, index) => ({ index, text, isWrapped: false }));
  return { rows: 40, cols: 96, length: lines.length, baseY: 0, lines };
}

function simulate(initial: string, allowTaskInterrupt: boolean, settles = true) {
  let visible = initial;
  const steps: string[] = [];
  vi.mocked(getTerminalInspector).mockReturnValue(() => frame(visible));
  vi.mocked(getTerminalRenderCheckpointProvider).mockReturnValue(async () => ({
    generation: 1,
    seq: 21,
    geometry,
    data: "status",
  }));
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    switch (command) {
      case "begin_codex_status_checkpoint":
        return {
          token: "close",
          targets: [{ ...geometry, terminalId: "terminal-review" }],
          allowTaskInterrupt,
        };
      case "codex_status_checkpoint_input": {
        const step = String(args?.step);
        steps.push(step);
        if (step === "interrupt" && settles) visible = IDLE;
        if (step === "clear") visible = EMPTY;
        if (step === "typeStatus") visible = SELECTED;
        if (step === "submit") return { generation: 1, seq: 20, geometry };
        return null;
      }
      case "read_codex_status_checkpoint":
        steps.push("verified");
        return "one-conversation";
      default:
        return undefined;
    }
  });
  const save = vi.fn(async () => steps.push("save"));
  return { save, steps };
}

describe("종료 중인 Codex 작업의 취소", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it.each([BUSY, BUSY.slice(2)])("작업을 취소한 뒤 같은 대화를 확인하고 저장한다", async (busy) => {
    vi.useFakeTimers();
    const { save, steps } = simulate(busy, true);
    const close = withCodexStatusCheckpoint(true, undefined, save);
    await vi.runAllTimersAsync();
    await close;
    expect(steps).toEqual(["interrupt", "clear", "typeStatus", "submit", "verified", "save"]);
  });

  it.each([
    ["취소 설정을 끈 종료", BUSY, false],
    ["출력 상단의 과거 안내", BUSY + "\n후속 출력\n› /other", true],
    ["승인 모달", BUSY + "\n  enter confirm · esc back", true],
  ])("%s에서는 작업 입력을 보내지 않는다", async (_name, initial, allowed) => {
    const { save, steps } = simulate(initial, allowed);
    await expect(withCodexStatusCheckpoint(true, undefined, save)).rejects.toThrow();
    expect(steps).toEqual([]);
    expect(save).not.toHaveBeenCalled();
  });

  it("중단 후 유휴 화면이 오지 않으면 한 번만 보내고 저장은 중단한다", async () => {
    vi.useFakeTimers();
    const { save, steps } = simulate(BUSY, true, false);
    const close = withCodexStatusCheckpoint(true, undefined, save);
    const failed = expect(close).rejects.toThrow("task interrupt");
    await vi.runAllTimersAsync();
    await failed;
    expect(steps).toEqual(["interrupt"]);
  });
});
