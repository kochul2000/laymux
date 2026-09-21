import { describe, expect, it, vi } from "vitest";
import {
  installRemoteToolSwipes,
  nextRemoteTool,
  normalizeToolSwipeRightAction,
} from "./remote-tool-swipe.js";

describe("Remote 도구 순환", () => {
  const all = { github: true, files: true, memo: true };
  it("Issues → PRs → Files → Memo와 역순을 순환한다", () => {
    const order = ["issues", "pulls", "files", "memo"];
    order.forEach((tool, index) => {
      expect(nextRemoteTool(tool, 1, all)).toBe(order[(index + 1) % 4]);
      expect(nextRemoteTool(tool, -1, all)).toBe(order[(index + 3) % 4]);
    });
  });
  it("숨김·사용 불가 도구를 건너뛰되 숨겨진 현재 위치를 기준으로 순회한다", () => {
    const visible = { github: false, files: true, memo: true };
    expect(nextRemoteTool("issues", 1, visible)).toBe("files");
    expect(nextRemoteTool("pulls", -1, visible)).toBe("memo");
    expect(nextRemoteTool("memo", 1, visible)).toBe("files");
    expect(nextRemoteTool("files", -1, visible)).toBe("memo");
  });
  it("대상이 없거나 현재 도구만 남으면 전환하지 않는다", () => {
    expect(nextRemoteTool("memo", 1, { memo: true })).toBeNull();
    expect(nextRemoteTool("memo", -1, {})).toBeNull();
    expect(nextRemoteTool(null, 1, all)).toBeNull();
    expect(nextRemoteTool("issues", 1, { github: true })).toBe("pulls");
  });
  it("오른쪽 동작은 명시한 previous 이외에 항상 기존 닫기로 복구한다", () => {
    expect(normalizeToolSwipeRightAction("previous")).toBe("previous");
    for (const value of [null, undefined, "close", "bad", true]) {
      expect(normalizeToolSwipeRightAction(value)).toBe("close");
    }
  });
  it("릴리스에서 한 단계만 이동하고 돌아온 drag·취소·본문 선택·후속 클릭을 구분한다", () => {
    document.body.innerHTML =
      '<header data-remote-tool-swipe="github"><button>Button</button><input></header>';
    const button = document.querySelector("button")!;
    const perform = vi.fn();
    let hasTarget = true;
    const event = (type: string, x: number, y = 0, target: Element = button, extra = {}) => {
      const value = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
        detail: 1,
      });
      Object.assign(value, { pointerId: 1, pointerType: "touch", isPrimary: true, ...extra });
      target.dispatchEvent(value);
      return value;
    };
    installRemoteToolSwipes({
      getCurrent: () => "issues",
      enabled: () => true,
      resolveAction: (direction: number) =>
        hasTarget ? (direction === 1 ? "pulls" : "close") : null,
      perform,
    });
    event("pointerdown", 200);
    event("pointermove", 100);
    event("pointermove", 70);
    expect(perform).not.toHaveBeenCalled();
    event("pointerup", 70);
    expect(perform).toHaveBeenCalledExactlyOnceWith("pulls");
    expect(event("click", 70).defaultPrevented).toBe(true);
    perform.mockClear();
    event("pointerdown", 200);
    event("pointermove", 100);
    event("pointermove", 198);
    event("pointerup", 198);
    expect(perform).not.toHaveBeenCalled();
    // Still a drag, not a button tap, even when it returned to the origin.
    expect(event("click", 198).defaultPrevented).toBe(true);
    hasTarget = false;
    event("pointerdown", 200);
    event("pointermove", 80);
    event("pointerup", 80);
    expect(perform).not.toHaveBeenCalled();
    expect(event("click", 80).defaultPrevented).toBe(true);
    hasTarget = true;
    for (const cancel of ["pointercancel", "pointerdown"]) {
      event("pointerdown", 200);
      event("pointermove", 100);
      event(cancel, 100, 0, button, { pointerId: 2, isPrimary: false });
      event("pointerup", 100);
      expect(perform).not.toHaveBeenCalled();
    }
    event("pointerdown", 200);
    event("pointermove", 195, 30);
    event("pointerup", 80, 30);
    expect(perform).not.toHaveBeenCalled();
    const input = document.querySelector("input")!;
    event("pointerdown", 200, 0, input);
    event("pointermove", 80, 0, input);
    event("pointerup", 80, 0, input);
    expect(perform).not.toHaveBeenCalled();
    const range = document.createRange();
    range.selectNodeContents(button);
    document.getSelection()?.addRange(range);
    event("pointerdown", 200);
    event("pointermove", 80);
    event("pointerup", 80);
    expect(perform).not.toHaveBeenCalled();
    document.getSelection()?.removeAllRanges();
    event("pointerdown", 200);
    event("pointerup", 200);
    expect(event("click", 200).defaultPrevented).toBe(false);
    document.body.replaceChildren();
  });
});
