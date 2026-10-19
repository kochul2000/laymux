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
});
