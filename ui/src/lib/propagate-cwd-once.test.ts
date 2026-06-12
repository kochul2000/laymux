import { describe, it, expect, vi, beforeEach } from "vitest";

const propagateCwdOnceMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/tauri-api", () => ({
  propagateCwdOnce: (terminalId: string) => propagateCwdOnceMock(terminalId),
}));

import { propagateCwdOnceForPane } from "./propagate-cwd-once";
import { useCwdPropagateStore } from "@/stores/cwd-propagate-store";

describe("propagateCwdOnceForPane (issue #293, #324)", () => {
  beforeEach(() => {
    propagateCwdOnceMock.mockClear();
    useCwdPropagateStore.setState({ requests: {} });
  });

  it("TerminalView: ViewRenderer 와 동일한 instanceId 규칙으로 백엔드 커맨드를 호출한다", () => {
    const handled = propagateCwdOnceForPane({
      id: "pane-x",
      view: { type: "TerminalView", profile: "PowerShell" },
    });
    expect(handled).toBe(true);
    expect(propagateCwdOnceMock).toHaveBeenCalledTimes(1);
    expect(propagateCwdOnceMock).toHaveBeenCalledWith("terminal-pane-x");
  });

  it("FileExplorerView: 백엔드 커맨드 대신 요청 버스 카운터를 올린다", () => {
    const handled = propagateCwdOnceForPane({
      id: "pane-fe",
      view: { type: "FileExplorerView" },
    });
    expect(handled).toBe(true);
    expect(propagateCwdOnceMock).not.toHaveBeenCalled();
    expect(useCwdPropagateStore.getState().requests["pane-fe"]).toBe(1);
  });

  it("CWD 를 갖지 않는 view 는 무시하고 false 를 반환한다", () => {
    const handled = propagateCwdOnceForPane({ id: "pane-m", view: { type: "MemoView" } });
    expect(handled).toBe(false);
    expect(propagateCwdOnceMock).not.toHaveBeenCalled();
    expect(useCwdPropagateStore.getState().requests).toEqual({});
  });
});
