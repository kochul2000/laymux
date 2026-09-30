import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { createRemoteAgentResumeLinkProvider } from "./remote-agent-resume";

const capture = vi.hoisted(() => ({
  activate: null as null | ((hint: unknown, current: () => boolean) => void),
}));
vi.mock("../lib/agent-resume-link", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createAgentResumeLinkProvider: (_terminal: unknown, activate: typeof capture.activate) => {
    capture.activate = activate;
    return {};
  },
}));
const hint = { provider: "codex", sessionId: "11111111-2222-4333-8444-555555555555" };
function setup() {
  let context = { terminalId: "t1", leaseId: "l1", outputEpoch: 1, ready: true, isShell: true };
  let current = true;
  const submit = vi.fn().mockResolvedValue(undefined);
  const onError = vi.fn();
  const loadCommands = vi.fn().mockResolvedValue({
    commands: { codex: { command: "codex --yolo --no-daemon" } },
    isShell: true,
  });
  createRemoteAgentResumeLinkProvider({} as Terminal, {
    getContext: () => context,
    loadCommands,
    submit,
    onError,
    run: (task) => Promise.resolve().then(task),
  });
  return {
    submit,
    onError,
    loadCommands,
    activate: () => capture.activate!(hint, () => current),
    update: (patch: Partial<typeof context>) => {
      context = { ...context, ...patch };
    },
    invalidate: () => {
      current = false;
    },
  };
}
describe("Remote 복원 링크 입력", () => {
  it("호스트의 최신 옵션으로 구조화 입력을 한 번 제출한다", async () => {
    const s = setup();
    s.activate();
    s.activate();
    await vi.waitFor(() => expect(s.submit).toHaveBeenCalledTimes(1));
    expect(s.submit).toHaveBeenCalledWith(
      expect.objectContaining({ terminalId: "t1", leaseId: "l1" }),
      `codex --yolo --no-daemon resume ${hint.sessionId}`,
    );
  });
  for (const patch of [{ ready: false }, { isShell: false }, { leaseId: "" }]) {
    it(`입력 gate를 지킨다: ${JSON.stringify(patch)}`, async () => {
      const s = setup();
      s.update(patch);
      s.activate();
      await Promise.resolve();
      expect(s.loadCommands).not.toHaveBeenCalled();
    });
  }
  for (const patch of [
    { terminalId: "t2" },
    { leaseId: "l2" },
    { outputEpoch: 2 },
    { ready: false },
    { isShell: false },
  ]) {
    it(`조회 중 문맥 변경을 폐기한다: ${JSON.stringify(patch)}`, async () => {
      const s = setup();
      s.loadCommands.mockImplementation(async () => {
        s.update(patch);
        return { commands: {}, isShell: true };
      });
      s.activate();
      await vi.waitFor(() => expect(s.loadCommands).toHaveBeenCalled());
      expect(s.submit).not.toHaveBeenCalled();
    });
  }
  it("조회 후 stale 셀은 제출하지 않는다", async () => {
    const s = setup();
    s.loadCommands.mockImplementation(async () => {
      s.invalidate();
      return { commands: {}, isShell: true };
    });
    s.activate();
    await vi.waitFor(() => expect(s.loadCommands).toHaveBeenCalled());
    expect(s.submit).not.toHaveBeenCalled();
  });
  it("호스트가 실행 중이면 제출하지 않는다", async () => {
    const s = setup();
    s.loadCommands.mockResolvedValue({ commands: {}, isShell: false });
    s.activate();
    await vi.waitFor(() => expect(s.loadCommands).toHaveBeenCalled());
    expect(s.submit).not.toHaveBeenCalled();
  });
  it("미지원 호스트의 설정 metadata 누락은 제출하지 않는다", async () => {
    const s = setup();
    s.loadCommands.mockResolvedValue({ isShell: true });
    s.activate();
    await vi.waitFor(() => expect(s.loadCommands).toHaveBeenCalled());
    expect(s.submit).not.toHaveBeenCalled();
  });
  it("실패를 알리고 자동 재전송하지 않는다", async () => {
    const s = setup();
    s.submit.mockRejectedValue(new Error("lease expired"));
    s.activate();
    await vi.waitFor(() => expect(s.onError).toHaveBeenCalledTimes(1));
    expect(s.submit).toHaveBeenCalledTimes(1);
  });
});
