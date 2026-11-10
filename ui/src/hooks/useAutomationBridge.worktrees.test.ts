import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAutomationRequest } from "./useAutomationBridge";
import { WORKTREE_ACTION_EVENT } from "@/lib/worktree-view-control";

vi.mock("html2canvas", () => ({ default: vi.fn() }));

function request(params: Record<string, unknown>) {
  return handleAutomationRequest({
    id: "worktree-ui",
    target: "worktrees",
    method: "control",
    params,
  });
}
afterEach(() => {
  document.body.replaceChildren();
});
describe("worktree automation bridge", () => {
  it("현재 렌더된 pane과 목록 경로를 검증하고 선택 이벤트를 보낸다", () => {
    const root = document.createElement("div");
    root.dataset.testid = "view-worktree";
    root.dataset.paneId = "pane";
    const row = document.createElement("button");
    row.dataset.worktreePath = "D:/repo";
    root.append(row);
    document.body.append(root);
    const listener = vi.fn();
    window.addEventListener(WORKTREE_ACTION_EVENT, listener);
    expect(request({ paneId: "pane", action: "select", path: "D:/repo" }).success).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(request({ paneId: "pane", action: "select", path: "D:/other" }).success).toBe(false);
    expect(request({ paneId: "pane", action: "remove", path: "D:/repo" }).success).toBe(false);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(WORKTREE_ACTION_EVENT, listener);
  });
  it("마운트되지 않은 뷰에 성공을 반환하지 않는다", () => {
    expect(request({ paneId: "missing", action: "refresh" }).success).toBe(false);
  });
  it("접힘 영역을 결정적으로 열고 닫으며 표시 상태를 읽는다", () => {
    document.body.innerHTML =
      '<div data-testid="view-worktree" data-pane-id="pane" aria-busy="true"><p role="alert">Git 검사 오류</p><details class="worktree-warnings"><summary>사용 확인 필요 12건</summary></details></div>';
    expect(
      request({ paneId: "pane", action: "disclosure", section: "warnings", open: true }).success,
    ).toBe(true);
    expect(document.querySelector("details")).toHaveAttribute("open");
    expect(
      request({ paneId: "pane", action: "disclosure", section: "warnings", open: false }).success,
    ).toBe(true);
    expect(document.querySelector("details")).not.toHaveAttribute("open");
    expect(
      request({ paneId: "pane", action: "disclosure", section: "bad", open: true }).success,
    ).toBe(false);
    expect(request({ paneId: "pane", action: "status" })).toMatchObject({
      success: true,
      data: { busy: true, warnings: "사용 확인 필요 12건", error: "Git 검사 오류" },
    });
  });
});
