import { describe, it, expect, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { createPathLinkController } from "./path-link-provider";

/**
 * 데코레이션 기반 컨트롤러 테스트용 mock terminal.
 * registerMarker/registerDecoration 을 가짜로 제공하고, 렌더 element 에 대한
 * onRender 콜백을 즉시 호출해 스타일/클릭 바인딩을 검증할 수 있게 한다.
 */
function makeTerminal() {
  const markerDispose = vi.fn();
  const decorationDispose = vi.fn();
  const el = document.createElement("div");
  let renderCb: ((el: HTMLElement) => void) | undefined;

  const terminal = {
    buffer: { active: { baseY: 0, cursorY: 0 } },
    registerMarker: vi.fn(() => ({ dispose: markerDispose })),
    registerDecoration: vi.fn(() => ({
      element: el,
      dispose: decorationDispose,
      onRender: (cb: (el: HTMLElement) => void) => {
        renderCb = cb;
        return { dispose: vi.fn() };
      },
    })),
  } as unknown as Terminal;

  return {
    terminal,
    el,
    markerDispose,
    decorationDispose,
    fireRender: () => renderCb?.(el),
  };
}

describe("createPathLinkController (선택 기반·데코레이션)", () => {
  it("setVerifiedSelection 은 마커·데코레이션을 만들고 밑줄을 그린다", () => {
    const t = makeTerminal();
    const ctrl = createPathLinkController(t.terminal, {
      onOpenPath: vi.fn(),
      onChangeDir: vi.fn(),
    });
    ctrl.setVerifiedSelection({
      bufferLine: 3,
      startCol: 5,
      endCol: 20,
      absPath: "/proj/src/a.ts",
      isDirectory: false,
    });

    // bufferLine 3(0-based 2) - cursorAbsY 0 = offset 2
    expect(t.terminal.registerMarker).toHaveBeenCalledWith(2);
    // x 는 0-based(startCol-1=4), width 는 endCol-startCol+1=16
    expect(t.terminal.registerDecoration).toHaveBeenCalledWith(
      expect.objectContaining({ x: 4, width: 16 }),
    );
    expect(t.el.style.borderBottom).not.toBe("");
    expect(t.el.style.pointerEvents).toBe("none");
    expect(ctrl.getCurrent()?.absPath).toBe("/proj/src/a.ts");
  });

  it("activate 는 파일이면 onOpenPath, 디렉토리면 onChangeDir 로 라우팅한다", () => {
    const onOpenPath = vi.fn();
    const onChangeDir = vi.fn();
    const t = makeTerminal();
    const ctrl = createPathLinkController(t.terminal, { onOpenPath, onChangeDir });

    ctrl.activate({
      bufferLine: 1,
      startCol: 1,
      endCol: 10,
      absPath: "/proj/a.ts",
      isDirectory: false,
    });
    expect(onOpenPath).toHaveBeenCalledWith("/proj/a.ts");
    expect(onChangeDir).not.toHaveBeenCalled();

    ctrl.activate({
      bufferLine: 1,
      startCol: 1,
      endCol: 10,
      absPath: "/proj/src",
      isDirectory: true,
    });
    expect(onChangeDir).toHaveBeenCalledWith("/proj/src");
  });

  it("hitTest 는 검증이 없으면 false, 있으면 데코 사각형 안일 때만 true", () => {
    const t = makeTerminal();
    // jsdom 은 0 사각형을 주므로 명시적으로 mock.
    t.el.getBoundingClientRect = () => ({ left: 10, right: 50, top: 20, bottom: 36 }) as DOMRect;
    const ctrl = createPathLinkController(t.terminal, {
      onOpenPath: vi.fn(),
      onChangeDir: vi.fn(),
    });
    expect(ctrl.hitTest(20, 25)).toBe(false); // 검증 없음
    ctrl.setVerifiedSelection({
      bufferLine: 1,
      startCol: 1,
      endCol: 4,
      absPath: "/x",
      isDirectory: false,
    });
    expect(ctrl.hitTest(20, 25)).toBe(true); // 사각형 안
    expect(ctrl.hitTest(5, 25)).toBe(false); // 왼쪽 밖
    expect(ctrl.hitTest(20, 40)).toBe(false); // 아래 밖
    ctrl.clear();
    expect(ctrl.hitTest(20, 25)).toBe(false);
  });

  it("데코레이션 요소는 클릭을 가로채지 않는다(pointer-events:none)", () => {
    const t = makeTerminal();
    const ctrl = createPathLinkController(t.terminal, {
      onOpenPath: vi.fn(),
      onChangeDir: vi.fn(),
    });
    ctrl.setVerifiedSelection({
      bufferLine: 1,
      startCol: 1,
      endCol: 4,
      absPath: "/x",
      isDirectory: false,
    });
    expect(t.el.style.pointerEvents).toBe("none");
  });

  it("clear() 는 데코레이션·마커를 dispose 하고 상태를 비운다", () => {
    const t = makeTerminal();
    const ctrl = createPathLinkController(t.terminal, {
      onOpenPath: vi.fn(),
      onChangeDir: vi.fn(),
    });
    ctrl.setVerifiedSelection({
      bufferLine: 2,
      startCol: 1,
      endCol: 5,
      absPath: "/x",
      isDirectory: false,
    });
    ctrl.clear();
    expect(t.decorationDispose).toHaveBeenCalled();
    expect(t.markerDispose).toHaveBeenCalled();
    expect(ctrl.getCurrent()).toBeNull();
  });

  it("setVerifiedSelection 갱신 시 이전 데코레이션을 dispose 한다", () => {
    const t = makeTerminal();
    const ctrl = createPathLinkController(t.terminal, {
      onOpenPath: vi.fn(),
      onChangeDir: vi.fn(),
    });
    ctrl.setVerifiedSelection({
      bufferLine: 2,
      startCol: 1,
      endCol: 5,
      absPath: "/a",
      isDirectory: false,
    });
    ctrl.setVerifiedSelection({
      bufferLine: 7,
      startCol: 3,
      endCol: 9,
      absPath: "/b",
      isDirectory: false,
    });
    expect(t.decorationDispose).toHaveBeenCalled();
    expect(ctrl.getCurrent()?.absPath).toBe("/b");
  });
});
