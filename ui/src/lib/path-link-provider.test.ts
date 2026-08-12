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
  const elements: HTMLElement[] = [];
  const renderCallbacks: Array<(el: HTMLElement) => void> = [];

  const terminal = {
    buffer: { active: { baseY: 0, cursorY: 0 } },
    registerMarker: vi.fn(() => ({ dispose: markerDispose })),
    registerDecoration: vi.fn(() => {
      const element = document.createElement("div");
      document.body.appendChild(element);
      elements.push(element);
      return {
        element,
        dispose: decorationDispose,
        onRender: (cb: (el: HTMLElement) => void) => {
          renderCallbacks.push(cb);
          return { dispose: vi.fn() };
        },
      };
    }),
  } as unknown as Terminal;

  return {
    terminal,
    get el() {
      return elements[0];
    },
    elements,
    markerDispose,
    decorationDispose,
    fireRender: () => renderCallbacks.forEach((callback, index) => callback(elements[index])),
  };
}

describe("createPathLinkController (선택 기반·데코레이션)", () => {
  it("setVerifiedSelection 은 마커·데코레이션을 만들고 밑줄을 그린다", () => {
    const t = makeTerminal();
    const ctrl = createPathLinkController(t.terminal, {
      onOpenPath: vi.fn(),
      onChangeDir: vi.fn(),
      onOsAction: vi.fn(),
    });
    ctrl.setVerifiedSelections([
      {
        bufferLine: 3,
        startCol: 5,
        endCol: 20,
        absPath: "/proj/src/a.ts",
        isDirectory: false,
      },
    ]);

    // bufferLine 3(0-based 2) - cursorAbsY 0 = offset 2
    expect(t.terminal.registerMarker).toHaveBeenCalledWith(2);
    // x 는 0-based(startCol-1=4), width 는 endCol-startCol+1=16
    expect(t.terminal.registerDecoration).toHaveBeenCalledWith(
      expect.objectContaining({ x: 4, width: 16 }),
    );
    expect(t.el.style.borderBottom).not.toBe("");
    expect(t.el.style.pointerEvents).toBe("none");
    expect(ctrl.getCurrent()[0]?.absPath).toBe("/proj/src/a.ts");
  });

  it("activate 는 파일이면 onOpenPath, 디렉토리면 onChangeDir 로 라우팅한다", () => {
    const onOpenPath = vi.fn();
    const onChangeDir = vi.fn();
    const onOsAction = vi.fn();
    const t = makeTerminal();
    const ctrl = createPathLinkController(t.terminal, { onOpenPath, onChangeDir, onOsAction });

    ctrl.activate(
      {
        bufferLine: 1,
        startCol: 1,
        endCol: 10,
        absPath: "/proj/a.ts",
        isDirectory: false,
      },
      "viewer",
    );
    expect(onOpenPath).toHaveBeenCalledWith("/proj/a.ts");
    expect(onChangeDir).not.toHaveBeenCalled();

    ctrl.activate(
      {
        bufferLine: 1,
        startCol: 1,
        endCol: 10,
        absPath: "/proj/src",
        isDirectory: true,
      },
      "changeDir",
    );
    expect(onChangeDir).toHaveBeenCalledWith("/proj/src");
  });

  // ADR-0100: Ctrl / Ctrl+Shift 는 호스트 OS 로 위임한다. 라우팅만 여기서
  // 검증하고, 어떤 수정자가 어떤 액션인지는 path-link-os-open 의 순수 함수가 정한다.
  it("activate 는 osOpen/osReveal 을 onOsAction 으로 라우팅한다", () => {
    const onOpenPath = vi.fn();
    const onChangeDir = vi.fn();
    const onOsAction = vi.fn();
    const t = makeTerminal();
    const ctrl = createPathLinkController(t.terminal, { onOpenPath, onChangeDir, onOsAction });

    const file = {
      bufferLine: 1,
      startCol: 1,
      endCol: 10,
      absPath: "/proj/a.ts",
      isDirectory: false,
    };
    ctrl.activate(file, "osOpen");
    expect(onOsAction).toHaveBeenCalledWith("/proj/a.ts", "open");

    ctrl.activate(file, "osReveal");
    expect(onOsAction).toHaveBeenCalledWith("/proj/a.ts", "reveal");

    const dir = { ...file, absPath: "/proj/src", isDirectory: true };
    ctrl.activate(dir, "osOpen");
    expect(onOsAction).toHaveBeenCalledWith("/proj/src", "open");

    // 앱 내부 동작은 트리거되지 않는다.
    expect(onOpenPath).not.toHaveBeenCalled();
    expect(onChangeDir).not.toHaveBeenCalled();
  });

  it("hitTest 는 검증이 없으면 false, 있으면 데코 사각형 안일 때만 true", () => {
    const t = makeTerminal();
    const ctrl = createPathLinkController(t.terminal, {
      onOpenPath: vi.fn(),
      onChangeDir: vi.fn(),
      onOsAction: vi.fn(),
    });
    expect(ctrl.getHit(20, 25)).toBeNull(); // 검증 없음
    ctrl.setVerifiedSelections([
      {
        bufferLine: 1,
        startCol: 1,
        endCol: 4,
        absPath: "/x",
        isDirectory: false,
      },
    ]);
    // jsdom 은 0 사각형을 주므로 데코레이션 생성 뒤 명시적으로 mock.
    t.el.getBoundingClientRect = () => ({ left: 10, right: 50, top: 20, bottom: 36 }) as DOMRect;
    expect(ctrl.getHit(20, 25)?.selection.absPath).toBe("/x"); // 사각형 안
    expect(ctrl.getHit(5, 25)).toBeNull(); // 왼쪽 밖
    expect(ctrl.getHit(20, 40)).toBeNull(); // 아래 밖
    ctrl.clear();
    expect(ctrl.getHit(20, 25)).toBeNull();
  });

  // #687: 힌트 라벨 배치의 유일한 좌표 소스다.
  it("getRect 는 검증이 없으면 null, 있으면 데코 사각형을 돌려준다", () => {
    const t = makeTerminal();
    const rect = { left: 10, right: 50, top: 20, bottom: 36 } as DOMRect;
    const ctrl = createPathLinkController(t.terminal, {
      onOpenPath: vi.fn(),
      onChangeDir: vi.fn(),
      onOsAction: vi.fn(),
    });
    expect(ctrl.getHit(20, 25)).toBeNull();
    ctrl.setVerifiedSelections([
      {
        bufferLine: 1,
        startCol: 1,
        endCol: 4,
        absPath: "/x",
        isDirectory: false,
      },
    ]);
    t.el.getBoundingClientRect = () => rect;
    expect(ctrl.getHit(20, 25)?.rect).toBe(rect);
    ctrl.clear();
    expect(ctrl.getHit(20, 25)).toBeNull();
  });

  it("데코레이션 요소는 클릭을 가로채지 않는다(pointer-events:none)", () => {
    const t = makeTerminal();
    const ctrl = createPathLinkController(t.terminal, {
      onOpenPath: vi.fn(),
      onChangeDir: vi.fn(),
      onOsAction: vi.fn(),
    });
    ctrl.setVerifiedSelections([
      {
        bufferLine: 1,
        startCol: 1,
        endCol: 4,
        absPath: "/x",
        isDirectory: false,
      },
    ]);
    expect(t.el.style.pointerEvents).toBe("none");
  });

  it("clear() 는 데코레이션·마커를 dispose 하고 상태를 비운다", () => {
    const t = makeTerminal();
    const ctrl = createPathLinkController(t.terminal, {
      onOpenPath: vi.fn(),
      onChangeDir: vi.fn(),
      onOsAction: vi.fn(),
    });
    ctrl.setVerifiedSelections([
      {
        bufferLine: 2,
        startCol: 1,
        endCol: 5,
        absPath: "/x",
        isDirectory: false,
      },
    ]);
    ctrl.clear();
    expect(t.decorationDispose).toHaveBeenCalled();
    expect(t.markerDispose).toHaveBeenCalled();
    expect(ctrl.getCurrent()).toEqual([]);
  });

  it("setVerifiedSelection 갱신 시 이전 데코레이션을 dispose 한다", () => {
    const t = makeTerminal();
    const ctrl = createPathLinkController(t.terminal, {
      onOpenPath: vi.fn(),
      onChangeDir: vi.fn(),
      onOsAction: vi.fn(),
    });
    ctrl.setVerifiedSelections([
      {
        bufferLine: 2,
        startCol: 1,
        endCol: 5,
        absPath: "/a",
        isDirectory: false,
      },
    ]);
    ctrl.setVerifiedSelections([
      {
        bufferLine: 7,
        startCol: 3,
        endCol: 9,
        absPath: "/b",
        isDirectory: false,
      },
    ]);
    expect(t.decorationDispose).toHaveBeenCalled();
    expect(ctrl.getCurrent()[0]?.absPath).toBe("/b");
  });

  it("복수 경로를 각각 데코레이션하고 좌표 아래의 경로를 반환한다", () => {
    const t = makeTerminal();
    const ctrl = createPathLinkController(t.terminal, {
      onOpenPath: vi.fn(),
      onChangeDir: vi.fn(),
      onOsAction: vi.fn(),
    });
    ctrl.setVerifiedSelections([
      { bufferLine: 1, startCol: 1, endCol: 4, absPath: "/a", isDirectory: false },
      { bufferLine: 2, startCol: 6, endCol: 9, absPath: "/b", isDirectory: true },
    ]);
    t.elements[0].getBoundingClientRect = () =>
      ({ left: 10, right: 40, top: 10, bottom: 20 }) as DOMRect;
    t.elements[1].getBoundingClientRect = () =>
      ({ left: 50, right: 80, top: 30, bottom: 40 }) as DOMRect;

    expect(t.terminal.registerDecoration).toHaveBeenCalledTimes(2);
    expect(ctrl.getHit(60, 35)?.selection.absPath).toBe("/b");
    expect(ctrl.getHit(20, 15)?.selection.absPath).toBe("/a");
  });

  it("앞 후보 데코레이션 실패가 뒤 후보 생성을 막지 않는다", () => {
    const t = makeTerminal();
    vi.mocked(t.terminal.registerMarker).mockReturnValueOnce(undefined);
    const ctrl = createPathLinkController(t.terminal, {
      onOpenPath: vi.fn(),
      onChangeDir: vi.fn(),
      onOsAction: vi.fn(),
    });

    ctrl.setVerifiedSelections([
      { bufferLine: 1, startCol: 1, endCol: 4, absPath: "/a", isDirectory: false },
      { bufferLine: 2, startCol: 6, endCol: 9, absPath: "/b", isDirectory: false },
    ]);

    expect(t.terminal.registerMarker).toHaveBeenCalledTimes(2);
    expect(t.terminal.registerDecoration).toHaveBeenCalledTimes(1);
  });
});
